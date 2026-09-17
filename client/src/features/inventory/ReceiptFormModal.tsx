import {
  BarcodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  ExclamationCircleFilled,
  FileTextOutlined,
  InboxOutlined,
  PlusOutlined,
  SearchOutlined,
  ShopOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, AutoComplete, Button, DatePicker, Divider, Empty, Form, Input, InputNumber, Modal, Select, Table, Tag, Tooltip, Typography } from "antd";
import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import {
  formatVnd,
  type Envelope,
  type GoodsReceiptDetail,
  type GoodsReceiptLine,
  type Paged,
  type ProductDetail,
  type ProductListItem,
  type SupplierListItem,
} from "../../api/types.js";
import { daysUntil, formatNumber, vnDateKey } from "../../ui/format.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";

type DraftLine = {
  key: string;
  productId: string;
  productCode: string;
  productName: string;
  unitId: string;
  /** Đơn vị lấy từ dòng đã lưu, dùng tạm tới khi tải xong chi tiết sản phẩm. */
  fallbackUnit: { id: string; name: string; conversionToBase: number };
  quantity: number;
  unitCost: number;
  batchNumber: string;
  manufactureDate: string;
  expiryDate: string;
};

type Issue = { level: "error" | "warning"; text: string };

const DATE_FORMAT = "DD/MM/YYYY";
const NEAR_EXPIRY_DAYS = 90;

function toDateKey(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

function toDraftLine(line: GoodsReceiptLine): DraftLine {
  return {
    key: line.id,
    productId: line.productId,
    productCode: line.productCode,
    productName: line.productName,
    unitId: line.unitId,
    fallbackUnit: { id: line.unitId, name: line.unitName, conversionToBase: line.conversionToBase },
    quantity: line.quantity,
    unitCost: line.unitCost,
    batchNumber: line.batchNumber,
    manufactureDate: toDateKey(line.manufactureDate),
    expiryDate: toDateKey(line.expiryDate),
  };
}

/** Kiểm tra từng dòng như người nhập hàng tự soát trước khi lưu. */
function lineIssues(line: DraftLine, duplicate: boolean): Issue[] {
  const issues: Issue[] = [];
  const today = vnDateKey();
  if (duplicate) issues.push({ level: "error", text: "Trùng sản phẩm, đơn vị và số lô với dòng khác — gộp số lượng lại" });
  if (!line.batchNumber.trim()) issues.push({ level: "error", text: "Thiếu số lô" });
  if (line.quantity <= 0) issues.push({ level: "error", text: "Số lượng phải lớn hơn 0" });
  if (!line.expiryDate) issues.push({ level: "error", text: "Thiếu hạn dùng" });
  else if (line.expiryDate <= today) issues.push({ level: "error", text: "Hạn dùng đã qua, không được nhập" });
  else if (daysUntil(line.expiryDate) <= NEAR_EXPIRY_DAYS) issues.push({ level: "warning", text: `Hạn dùng chỉ còn ${daysUntil(line.expiryDate)} ngày` });
  if (line.manufactureDate && line.manufactureDate > today) issues.push({ level: "error", text: "Ngày sản xuất ở tương lai" });
  if (line.manufactureDate && line.expiryDate && line.manufactureDate >= line.expiryDate) issues.push({ level: "error", text: "Ngày sản xuất phải trước hạn dùng" });
  if (line.unitCost === 0) issues.push({ level: "warning", text: "Giá nhập bằng 0 — chỉ dùng cho hàng tặng/khuyến mại" });
  return issues;
}

export function ReceiptFormModal({
  open,
  receipt,
  onClose,
  onSaved,
}: {
  open: boolean;
  receipt: GoodsReceiptDetail | null;
  onClose: () => void;
  onSaved: (id: string) => Promise<unknown> | unknown;
}) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const [supplierId, setSupplierId] = useState<string>();
  const [receivedAt, setReceivedAt] = useState(vnDateKey());
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [supplierInvoiceDate, setSupplierInvoiceDate] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const [addingSupplier, setAddingSupplier] = useState(false);
  const createAttempt = useRef({ signature: "", key: "" });
  const productTerm = useDebounced(productSearch.trim(), 250);

  const suppliers = useQuery({
    queryKey: ["receipt-suppliers"],
    enabled: open,
    queryFn: async () => (await http.get<Envelope<Paged<SupplierListItem>>>("/suppliers", { params: { page: 1, limit: 100 } })).data.data.items,
  });
  const products = useQuery({
    queryKey: ["receipt-products", productTerm],
    enabled: open && productTerm.length > 0,
    queryFn: async () => (await http.get<Envelope<Paged<ProductListItem>>>("/products", { params: { search: productTerm, page: 1, limit: 15 } })).data.data.items,
  });

  // Chi tiết từng sản phẩm trong phiếu: đủ đơn vị quy đổi, số đăng ký, hãng, điều kiện bảo quản.
  const productIds = useMemo(() => [...new Set(lines.map((line) => line.productId))], [lines]);
  const productDetails = useQueries({
    queries: productIds.map((id) => ({
      queryKey: ["product", id],
      enabled: open,
      queryFn: async () => (await http.get<Envelope<ProductDetail>>(`/products/${id}`)).data.data,
      staleTime: 5 * 60_000,
    })),
  });
  const productById = new Map(productDetails.flatMap((query) => (query.data ? [[query.data.id, query.data] as const] : [])));

  useEffect(() => {
    if (!open) return;
    setSupplierId(receipt?.supplier?.id);
    setReceivedAt(toDateKey(receipt?.receivedAt) || vnDateKey());
    setSupplierInvoiceNumber(receipt?.supplierInvoiceNumber ?? "");
    setSupplierInvoiceDate(toDateKey(receipt?.supplierInvoiceDate));
    setNote(receipt?.note ?? "");
    setLines((receipt?.lines ?? []).map(toDraftLine));
    setProductSearch("");
  }, [open, receipt]);

  const supplier = suppliers.data?.find((item) => item.id === supplierId) ?? null;
  const total = lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);

  const duplicateKeys = useMemo(() => {
    const seen = new Map<string, number>();
    for (const line of lines) {
      const key = `${line.productId}|${line.unitId}|${line.batchNumber.trim().toUpperCase()}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return new Set(lines.filter((line) => line.batchNumber.trim() && (seen.get(`${line.productId}|${line.unitId}|${line.batchNumber.trim().toUpperCase()}`) ?? 0) > 1).map((line) => line.key));
  }, [lines]);
  const issuesByLine = new Map(lines.map((line) => [line.key, lineIssues(line, duplicateKeys.has(line.key))]));
  const errorLines = lines.filter((line) => issuesByLine.get(line.key)?.some((issue) => issue.level === "error")).length;
  const warningLines = lines.filter((line) => issuesByLine.get(line.key)?.some((issue) => issue.level === "warning")).length;

  const headerIssues: string[] = [];
  if (receivedAt > vnDateKey()) headerIssues.push("Ngày nhận hàng không được ở tương lai");
  if (supplierInvoiceDate > vnDateKey()) headerIssues.push("Ngày hóa đơn không được ở tương lai");
  // Hóa đơn có thể xuất trước khi hàng về (hàng đi đường) hoặc sau khi giao (hóa đơn điện tử
  // gửi sau), nên không chặn theo thứ tự; chỉ nhắc khi hai ngày lệch nhau bất thường.
  const invoiceGapDays = supplierInvoiceDate ? Math.abs(dayjs(supplierInvoiceDate).diff(dayjs(receivedAt), "day")) : 0;
  const headerWarning = invoiceGapDays > 30 ? `Ngày hóa đơn và ngày nhận hàng lệch nhau ${invoiceGapDays} ngày — kiểm tra lại có nhập nhầm không` : null;

  async function addProduct(productId: string): Promise<void> {
    const product = (await http.get<Envelope<ProductDetail>>(`/products/${productId}`)).data.data;
    // Nhà thuốc nhập theo quy cách đóng gói (hộp, chai…) nên chọn sẵn đơn vị lớn nhất còn dùng.
    const activeUnits = product.units.filter((unit) => unit.isActive !== false);
    const unit = [...activeUnits].sort((a, b) => b.conversionToBase - a.conversionToBase)[0] ?? product.units[0];
    if (!unit) {
      void message.error("Sản phẩm chưa có đơn vị tính");
      return;
    }
    setLines((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        productId: product.id,
        productCode: product.code,
        productName: product.name,
        unitId: unit.id,
        fallbackUnit: { id: unit.id, name: unit.name, conversionToBase: unit.conversionToBase },
        quantity: 1,
        unitCost: 0,
        batchNumber: "",
        manufactureDate: "",
        expiryDate: "",
      },
    ]);
    setProductSearch("");
  }

  async function addFromSearchEnter(): Promise<void> {
    const value = productSearch.trim();
    if (!value) return;
    const found = (await http.get<Envelope<Paged<ProductListItem>>>("/products", { params: { search: value, page: 1, limit: 2 } })).data.data.items;
    if (found.length === 1) await addProduct(found[0]!.id);
    else if (found.length === 0) void message.warning(`Không tìm thấy sản phẩm “${value}”`);
  }

  function changeLine(key: string, patch: Partial<DraftLine>): void {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  /** Cùng một sản phẩm về nhiều lô khác nhau: tách thêm dòng giữ nguyên sản phẩm, đơn vị, giá. */
  function splitBatch(line: DraftLine): void {
    setLines((current) => {
      const index = current.findIndex((item) => item.key === line.key);
      const copy: DraftLine = { ...line, key: crypto.randomUUID(), quantity: 1, batchNumber: "", manufactureDate: "", expiryDate: "" };
      return [...current.slice(0, index + 1), copy, ...current.slice(index + 1)];
    });
  }

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        supplierId,
        receivedAt,
        supplierInvoiceNumber: supplierInvoiceNumber.trim() || null,
        supplierInvoiceDate: supplierInvoiceDate || null,
        note: note.trim() || null,
        lines: lines.map((line) => ({
          productId: line.productId,
          unitId: line.unitId,
          quantity: line.quantity,
          unitCost: line.unitCost,
          batchNumber: line.batchNumber.trim(),
          manufactureDate: line.manufactureDate || null,
          expiryDate: line.expiryDate,
        })),
      };
      if (receipt) {
        const response = await http.patch<Envelope<GoodsReceiptDetail>>(`/goods-receipts/${receipt.id}`, { ...body, version: receipt.version });
        return response.data.data.id;
      }
      const signature = JSON.stringify(body);
      if (createAttempt.current.signature !== signature) createAttempt.current = { signature, key: crypto.randomUUID() };
      const response = await http.post<Envelope<GoodsReceiptDetail>>("/goods-receipts", body, { headers: { "Idempotency-Key": createAttempt.current.key } });
      return response.data.data.id;
    },
    onSuccess: async (id) => {
      void message.success(receipt ? "Đã lưu phiếu nháp" : "Đã tạo phiếu nháp, chờ kiểm nhập");
      await onSaved(id);
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được phiếu nhập")),
  });

  const canSave = Boolean(supplierId) && lines.length > 0 && errorLines === 0 && headerIssues.length === 0;
  const blockReason = !supplierId ? "Chọn nhà cung cấp" : lines.length === 0 ? "Thêm ít nhất một dòng hàng" : errorLines > 0 ? `${errorLines} dòng còn lỗi` : headerIssues[0] ?? null;

  return (
    <Modal
      open={open}
      width="min(1320px, 96vw)"
      style={{ top: 24 }}
      title={receipt ? `Sửa phiếu nhập ${receipt.code}` : "Tạo phiếu nhập hàng"}
      onCancel={onClose}
      destroyOnHidden
      footer={
        <div className="receipt-form-footer">
          <span className={blockReason ? "text-secondary" : "text-success"}>{blockReason ?? "Sẵn sàng lưu phiếu nháp"}</span>
          <Button onClick={onClose}>Đóng</Button>
          <Tooltip title={blockReason}>
            <Button type="primary" disabled={!canSave} loading={save.isPending} onClick={() => save.mutate()}>
              Lưu phiếu nháp
            </Button>
          </Tooltip>
        </div>
      }
    >
      <div className="receipt-form">
        <Alert type="info" showIcon title="Lưu nháp chưa cộng tồn. Sau khi hàng về, dược sĩ kiểm nhập cảm quan từng dòng rồi xác nhận mới tạo lô và ghi thẻ kho." />

        <section className="form-section">
          <h4>
            <FileTextOutlined /> Thông tin chứng từ
          </h4>
          <div className="receipt-form-header">
            <div className="field supplier-field">
              <span>Nhà cung cấp *</span>
              <div className="supplier-picker">
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="Tìm và chọn nhà cung cấp"
                  loading={suppliers.isLoading}
                  value={supplierId}
                  onChange={setSupplierId}
                  notFoundContent={suppliers.isLoading ? "Đang tải…" : "Không có nhà cung cấp phù hợp"}
                  options={(suppliers.data ?? []).filter((item) => item.isActive || item.id === supplierId).map((item) => ({ value: item.id, label: item.name }))}
                  popupRender={(menu) =>
                    can("catalog.manage") ? (
                      <>
                        {menu}
                        <Divider style={{ margin: "4px 0" }} />
                        <Button type="text" block icon={<PlusOutlined />} className="select-footer-btn" onClick={() => setAddingSupplier(true)}>
                          Thêm nhà cung cấp mới
                        </Button>
                      </>
                    ) : (
                      menu
                    )
                  }
                />
                {can("catalog.manage") ? (
                  <Tooltip title="Thêm nhà cung cấp mới">
                    <Button icon={<PlusOutlined />} onClick={() => setAddingSupplier(true)} aria-label="Thêm nhà cung cấp mới" />
                  </Tooltip>
                ) : null}
              </div>
              {supplier ? (
                <div className="supplier-card">
                  <ShopOutlined />
                  <div>
                    <strong>{supplier.name}</strong>
                    <span>
                      MST {supplier.taxCode ?? "—"} · GPKD {supplier.licenseNumber ?? "—"} · ĐT {supplier.phone ?? "—"}
                    </span>
                    {supplier.address ? <span>{supplier.address}</span> : null}
                    {!supplier.licenseNumber ? (
                      <span className="text-warning">
                        <WarningFilled /> Chưa lưu số giấy phép kinh doanh dược của nhà cung cấp — nên bổ sung để chứng minh nguồn gốc hợp pháp.
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : !can("catalog.manage") ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Chưa có nhà cung cấp cần dùng? Nhờ quản lý thêm ở trang Nhà cung cấp.
                </Typography.Text>
              ) : null}
            </div>
            <label className="field">
              <span>Số hóa đơn</span>
              <Input placeholder="Ghi theo hóa đơn NCC" value={supplierInvoiceNumber} onChange={(event) => setSupplierInvoiceNumber(event.target.value)} maxLength={50} />
            </label>
            <label className="field">
              <span>Ngày hóa đơn</span>
              <DatePicker
                format={DATE_FORMAT}
                placeholder="Ngày in trên hóa đơn"
                value={supplierInvoiceDate ? dayjs(supplierInvoiceDate) : null}
                disabledDate={(date) => date.isAfter(dayjs(), "day")}
                onChange={(value) => setSupplierInvoiceDate(value ? value.format("YYYY-MM-DD") : "")}
              />
            </label>
            <label className="field">
              <span>Ngày nhận hàng *</span>
              <DatePicker
                format={DATE_FORMAT}
                allowClear={false}
                value={receivedAt ? dayjs(receivedAt) : null}
                disabledDate={(date) => date.isAfter(dayjs(), "day")}
                onChange={(value) => value && setReceivedAt(value.format("YYYY-MM-DD"))}
              />
            </label>
            <label className="field note-field">
              <span>Ghi chú</span>
              <Input placeholder="Không bắt buộc — ví dụ: nhập hàng định kỳ, người giao hàng…" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
            </label>
          </div>
          {headerIssues.map((issue) => (
            <Typography.Text key={issue} type="danger" style={{ display: "block", marginTop: 6 }}>
              <ExclamationCircleFilled /> {issue}
            </Typography.Text>
          ))}
          {headerWarning ? (
            <Typography.Text type="warning" style={{ display: "block", marginTop: 6 }}>
              <WarningFilled /> {headerWarning}
            </Typography.Text>
          ) : null}
          <p className="section-note" style={{ margin: "8px 0 0" }}>
            Ngày hóa đơn là ngày in trên hóa đơn của nhà cung cấp; ngày nhận hàng là ngày hàng thực tế về nhà thuốc — dùng để tính tồn và báo cáo theo tháng. Hai ngày có thể khác nhau.
          </p>
        </section>

        <section className="form-section">
          <h4>
            <InboxOutlined /> Hàng hóa nhập
          </h4>
          <AutoComplete
            className="receipt-product-search"
            value={productSearch}
            onChange={setProductSearch}
            onSelect={(id) => void addProduct(String(id))}
            options={(products.data ?? []).map((product) => ({
              value: product.id,
              label: (
                <div className="product-option">
                  <strong>{product.name}</strong>
                  <span>{[product.code, product.dosageForm, product.strengthText, product.stock ? `tồn ${formatNumber(product.stock.sellable)}` : null].filter(Boolean).join(" · ")}</span>
                </div>
              ),
            }))}
            notFoundContent={productTerm && !products.isFetching ? "Không tìm thấy sản phẩm — thêm mới ở trang Thuốc & sản phẩm" : null}
          >
            <Input
              size="large"
              prefix={<SearchOutlined />}
              suffix={<BarcodeOutlined />}
              placeholder="Quét mã vạch hoặc gõ tên, mã, hoạt chất để thêm hàng vào phiếu"
              onPressEnter={(event) => {
                // Để AutoComplete xử lý Enter khi đang có gợi ý được chọn.
                if (!(products.data?.length ?? 0) || (products.data?.length ?? 0) === 1) {
                  event.preventDefault();
                  void addFromSearchEnter();
                }
              }}
            />
          </AutoComplete>

          <Table
            rowKey="key"
            size="small"
            className="receipt-lines"
            pagination={false}
            dataSource={lines}
            scroll={{ x: 1200 }}
            rowClassName={(line) => (issuesByLine.get(line.key)?.some((issue) => issue.level === "error") ? "line-has-error" : "")}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có hàng — quét mã vạch hoặc tìm sản phẩm ở ô phía trên" /> }}
            columns={[
              { title: "#", key: "index", width: 40, render: (_: unknown, __: DraftLine, index: number) => index + 1 },
              {
                title: "Sản phẩm",
                key: "product",
                width: 260,
                render: (_: unknown, line: DraftLine) => {
                  const product = productById.get(line.productId);
                  const issues = issuesByLine.get(line.key) ?? [];
                  const meta = [line.productCode, product?.registrationNumber ? `SĐK ${product.registrationNumber}` : null].filter(Boolean).join(" · ");
                  const origin = [product?.manufacturer, product?.countryOfOrigin].filter(Boolean).join(" · ");
                  return (
                    <div className="cell-main">
                      <strong>{line.productName}</strong>
                      <span>{meta}</span>
                      {origin ? <span>{origin}</span> : null}
                      {product?.storageCondition ? <span>Bảo quản: {product.storageCondition}</span> : null}
                      {product && !product.registrationNumber && product.productType === "DRUG" ? <span className="text-warning">Thuốc chưa có số đăng ký trong danh mục</span> : null}
                      {issues.map((issue) => (
                        <span key={issue.text} className={issue.level === "error" ? "text-danger" : "text-warning"}>
                          {issue.level === "error" ? <ExclamationCircleFilled /> : <WarningFilled />} {issue.text}
                        </span>
                      ))}
                    </div>
                  );
                },
              },
              {
                title: "Đơn vị",
                key: "unit",
                width: 130,
                render: (_: unknown, line: DraftLine) => {
                  const units = productById.get(line.productId)?.units.filter((unit) => unit.isActive !== false || unit.id === line.unitId) ?? [line.fallbackUnit];
                  const current = units.find((unit) => unit.id === line.unitId) ?? line.fallbackUnit;
                  const base = units.find((unit) => unit.conversionToBase === 1);
                  return (
                    <div className="cell-main">
                      <Select size="small" style={{ width: "100%" }} value={line.unitId} onChange={(unitId) => changeLine(line.key, { unitId })} options={units.map((unit) => ({ value: unit.id, label: unit.name }))} />
                      {current.conversionToBase > 1 ? <span>= {formatNumber(current.conversionToBase)} {base?.name ?? "đơn vị lẻ"}</span> : null}
                    </div>
                  );
                },
              },
              {
                title: "Số lượng",
                key: "qty",
                width: 100,
                render: (_: unknown, line: DraftLine) => (
                  <InputNumber<number> size="small" style={{ width: "100%" }} min={1} precision={0} value={line.quantity} onChange={(value) => changeLine(line.key, { quantity: value ?? 0 })} />
                ),
              },
              {
                title: "Đơn giá nhập",
                key: "cost",
                width: 130,
                render: (_: unknown, line: DraftLine) => (
                  <InputNumber<number>
                    size="small"
                    style={{ width: "100%" }}
                    min={0}
                    precision={0}
                    value={line.unitCost}
                    formatter={(value) => (value ? Number(value).toLocaleString("vi-VN") : "0")}
                    parser={(value) => Number((value ?? "").replace(/\D/g, ""))}
                    onChange={(value) => changeLine(line.key, { unitCost: value ?? 0 })}
                  />
                ),
              },
              {
                title: "Số lô *",
                key: "batch",
                width: 130,
                render: (_: unknown, line: DraftLine) => (
                  <Input
                    size="small"
                    value={line.batchNumber}
                    placeholder="Theo bao bì"
                    status={line.batchNumber.trim() && !duplicateKeys.has(line.key) ? undefined : "error"}
                    onChange={(event) => changeLine(line.key, { batchNumber: event.target.value.toUpperCase() })}
                    maxLength={50}
                  />
                ),
              },
              {
                title: "Ngày SX",
                key: "mfg",
                width: 140,
                render: (_: unknown, line: DraftLine) => (
                  <DatePicker
                    size="small"
                    format={DATE_FORMAT}
                    placeholder="dd/mm/yyyy"
                    value={line.manufactureDate ? dayjs(line.manufactureDate) : null}
                    disabledDate={(date) => date.isAfter(dayjs(), "day")}
                    onChange={(value) => changeLine(line.key, { manufactureDate: value ? value.format("YYYY-MM-DD") : "" })}
                  />
                ),
              },
              {
                title: "Hạn dùng *",
                key: "exp",
                width: 140,
                render: (_: unknown, line: DraftLine) => {
                  const invalid = !line.expiryDate || line.expiryDate <= vnDateKey();
                  const near = !invalid && daysUntil(line.expiryDate) <= NEAR_EXPIRY_DAYS;
                  return (
                    <DatePicker
                      size="small"
                      format={DATE_FORMAT}
                      placeholder="dd/mm/yyyy"
                      status={invalid ? "error" : near ? "warning" : undefined}
                      value={line.expiryDate ? dayjs(line.expiryDate) : null}
                      disabledDate={(date) => !date.isAfter(dayjs(), "day")}
                      onChange={(value) => changeLine(line.key, { expiryDate: value ? value.format("YYYY-MM-DD") : "" })}
                    />
                  );
                },
              },
              {
                title: "Thành tiền",
                key: "total",
                width: 120,
                align: "right",
                render: (_: unknown, line: DraftLine) => <strong>{formatVnd(line.quantity * line.unitCost)}</strong>,
              },
              {
                title: "",
                key: "actions",
                width: 76,
                fixed: "right",
                render: (_: unknown, line: DraftLine) => (
                  <span className="row-actions">
                    <Tooltip title="Tách thêm lô cho sản phẩm này">
                      <Button type="text" size="small" icon={<CopyOutlined />} aria-label="Tách lô" onClick={() => splitBatch(line)} />
                    </Tooltip>
                    <Tooltip title="Xóa dòng">
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label="Xóa dòng" onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))} />
                    </Tooltip>
                  </span>
                ),
              },
            ]}
          />

          <div className="receipt-form-summary">
            <div className="summary-stats">
              <span>
                <strong>{new Set(lines.map((line) => line.productId)).size}</strong> mặt hàng · <strong>{lines.length}</strong> dòng lô
              </span>
              {errorLines > 0 ? <Tag color="red">{errorLines} dòng cần sửa</Tag> : null}
              {warningLines > 0 ? <Tag color="orange">{warningLines} dòng cần lưu ý</Tag> : null}
            </div>
            <div className="summary-total">
              <span>Tổng tiền hàng</span>
              <strong>{formatVnd(total)}</strong>
            </div>
          </div>
        </section>
      </div>

      <QuickSupplierModal
        open={addingSupplier}
        onClose={() => setAddingSupplier(false)}
        onCreated={(created) => {
          setAddingSupplier(false);
          setSupplierId(created.id);
        }}
      />
    </Modal>
  );
}

type SupplierForm = { name: string; phone?: string; taxCode?: string; licenseNumber?: string; address?: string };

/** Thêm nhanh nhà cung cấp ngay trong phiếu nhập, không phải rời màn hình. */
function QuickSupplierModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (supplier: SupplierListItem) => void }) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<SupplierForm>();

  const create = useMutation({
    mutationFn: async (values: SupplierForm) =>
      (
        await http.post<Envelope<SupplierListItem>>("/suppliers", {
          name: values.name.trim(),
          phone: values.phone?.trim() || null,
          taxCode: values.taxCode?.trim() || null,
          licenseNumber: values.licenseNumber?.trim() || null,
          address: values.address?.trim() || null,
        })
      ).data.data,
    onSuccess: async (created) => {
      void message.success(`Đã thêm nhà cung cấp ${created.name}`);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["receipt-suppliers"] }), queryClient.invalidateQueries({ queryKey: ["suppliers-page"] })]);
      form.resetFields();
      onCreated(created);
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không thêm được nhà cung cấp")),
  });

  return (
    <Modal
      open={open}
      title="Thêm nhà cung cấp"
      okText="Thêm và chọn"
      cancelText="Hủy"
      width={560}
      confirmLoading={create.isPending}
      onOk={() => void form.validateFields().then((values) => create.mutate(values))}
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">Nhà thuốc chỉ được mua hàng từ cơ sở kinh doanh dược hợp pháp — nên ghi đủ mã số thuế và số giấy phép.</Typography.Paragraph>
      <Form form={form} layout="vertical" requiredMark="optional">
        <Form.Item name="name" label="Tên nhà cung cấp" rules={[{ required: true, whitespace: true, message: "Nhập tên nhà cung cấp" }]}>
          <Input placeholder="Ví dụ: Công ty CP Dược phẩm Traphaco" autoFocus />
        </Form.Item>
        <div className="form-grid">
          <Form.Item name="taxCode" label="Mã số thuế">
            <Input placeholder="10 hoặc 13 số" maxLength={20} />
          </Form.Item>
          <Form.Item name="licenseNumber" label="Số giấy phép kinh doanh dược">
            <Input maxLength={50} />
          </Form.Item>
          <Form.Item name="phone" label="Số điện thoại">
            <Input inputMode="tel" maxLength={20} />
          </Form.Item>
        </div>
        <Form.Item name="address" label="Địa chỉ">
          <Input placeholder="Số nhà, đường, phường/xã, tỉnh/thành phố" maxLength={500} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
