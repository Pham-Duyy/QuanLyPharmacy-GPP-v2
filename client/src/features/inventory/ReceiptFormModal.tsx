import {
  ArrowRightOutlined,
  BarcodeOutlined,
  DownOutlined,
  FileExcelOutlined,
  FileTextOutlined,
  InboxOutlined,
  PlusOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  AutoComplete,
  Button,
  DatePicker,
  Divider,
  Dropdown,
  Input,
  Modal,
  Select,
  Tag,
  Tooltip,
} from "antd";
import type { RefSelectProps } from "antd";
import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { useSubmitKey } from "../../api/submit-key.js";
import type {
  Envelope,
  GoodsReceiptDetail,
  Paged,
  ProductDetail,
  ProductListItem,
  SupplierListItem,
} from "../../api/types.js";
import { formatNumber, vnDateKey } from "../../ui/format.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/auth-context.js";
import { QuickSupplierModal } from "./receipts/QuickSupplierModal.js";
import { ReceiptLinesTable } from "./receipts/ReceiptLinesTable.js";
import { ReceiptSummary } from "./receipts/ReceiptSummary.js";
import { useReceiptImport } from "./receipts/useReceiptImport.js";
import {
  DATE_FORMAT,
  duplicateLineKeys,
  lineIssues,
  markExtraBatches,
  receiptChecks,
  toDateKey,
  toDraftLines,
  type DraftLine,
} from "./receipts/receipt-draft.js";

export type ReceiptSavedOptions = { inspect: boolean };

/**
 * Dòng hàng đổ sẵn vào phiếu nháp (từ Đề xuất đặt hàng). Số lô và hạn dùng
 * cố ý để trống: lúc gọi hàng chưa biết, người kiểm nhập điền khi hàng về.
 */
export type ReceiptPrefill = {
  supplierId: string;
  /** Lập từ đơn đặt hàng (Phase 7, D32): máy chủ đối chiếu số đã nhận theo đơn. */
  purchaseOrderId?: string;
  lines: Array<{ productId: string; unitName: string; quantity: number; unitCost: number }>;
};

export function ReceiptFormModal({
  open,
  receipt,
  prefill = null,
  onClose,
  onSaved,
}: {
  open: boolean;
  receipt: GoodsReceiptDetail | null;
  prefill?: ReceiptPrefill | null;
  onClose: () => void;
  onSaved: (id: string, options: ReceiptSavedOptions) => Promise<unknown> | unknown;
}) {
  const { message } = App.useApp();
  const { can, me, storeId } = useAuth();
  const searchRef = useRef<RefSelectProps>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [supplierId, setSupplierId] = useState<string>();
  const [receivedAt, setReceivedAt] = useState(vnDateKey());
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [supplierInvoiceDate, setSupplierInvoiceDate] = useState("");
  const [note, setNote] = useState("");
  const [discountAmount, setDiscountAmount] = useState(0);
  const [vatAmount, setVatAmount] = useState(0);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [loadingPrefill, setLoadingPrefill] = useState(false);
  const submitKey = useSubmitKey();
  const productTerm = useDebounced(productSearch.trim(), 250);
  const store = me?.stores.find((item) => item.id === storeId);

  const suppliers = useQuery({
    queryKey: ["receipt-suppliers"],
    enabled: open,
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<SupplierListItem>>>("/suppliers", {
          params: { page: 1, limit: 100 },
        })
      ).data.data.items,
  });
  const products = useQuery({
    queryKey: ["receipt-products", productTerm],
    enabled: open && productTerm.length > 0,
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<ProductListItem>>>("/products", {
          params: { search: productTerm, page: 1, limit: 15 },
        })
      ).data.data.items,
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
  const productById = new Map(
    productDetails.flatMap((query) => (query.data ? [[query.data.id, query.data] as const] : [])),
  );

  useEffect(() => {
    if (!open) return;
    setSupplierId(receipt?.supplier?.id);
    setReceivedAt(toDateKey(receipt?.receivedAt) || vnDateKey());
    setSupplierInvoiceNumber(receipt?.supplierInvoiceNumber ?? "");
    setSupplierInvoiceDate(toDateKey(receipt?.supplierInvoiceDate));
    setNote(receipt?.note ?? "");
    setDiscountAmount(receipt?.discountAmount ?? 0);
    setVatAmount(receipt?.vatAmount ?? 0);
    setLines(toDraftLines(receipt?.lines ?? []));
    setProductSearch("");
  }, [open, receipt]);

  // Mở từ Đề xuất đặt hàng: đổ sẵn nhà cung cấp và dòng hàng đã chọn.
  useEffect(() => {
    if (!open || receipt || !prefill || prefill.lines.length === 0) return;
    let cancelled = false;
    setLoadingPrefill(true);
    setSupplierId(prefill.supplierId);
    void Promise.all(
      prefill.lines.map(async (item) => ({
        item,
        line: await productToLine(item.productId, item.unitName),
      })),
    )
      .then((loaded) => {
        if (cancelled) return;
        const ready = loaded
          .filter(
            (entry): entry is { item: ReceiptPrefill["lines"][number]; line: DraftLine } =>
              entry.line !== null,
          )
          .map(({ item, line }) => ({ ...line, quantity: item.quantity, unitCost: item.unitCost }));
        setLines(markExtraBatches(ready));
        if (ready.length < prefill.lines.length) {
          void message.warning("Có mặt hàng chưa có đơn vị tính nên không đưa vào phiếu được");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled)
          void message.error(getErrorMessage(error, "Không đổ được dòng hàng từ đề xuất"));
      })
      .finally(() => {
        if (!cancelled) setLoadingPrefill(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ đổ một lần khi mở phiếu
  }, [open, receipt, prefill]);

  const supplier = suppliers.data?.find((item) => item.id === supplierId) ?? null;
  const goodsAmount = lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);
  const totalAmount = goodsAmount - discountAmount + vatAmount;
  const productCount = productIds.length;

  const duplicateKeys = useMemo(() => duplicateLineKeys(lines), [lines]);
  const issuesByLine = new Map(
    lines.map((line) => [line.key, lineIssues(line, duplicateKeys.has(line.key))]),
  );
  const discountTooHigh = discountAmount > goodsAmount;
  const checks = receiptChecks({
    supplier,
    lines,
    issuesByLine,
    receivedAt,
    supplierInvoiceDate,
    goodsAmount,
    discountAmount,
  });
  const blocked = checks.some((check) => check.state === "error");

  async function productToLine(
    productId: string,
    preferredUnitName?: string,
  ): Promise<DraftLine | null> {
    const product = (await http.get<Envelope<ProductDetail>>(`/products/${productId}`)).data.data;
    const activeUnits = product.units.filter((unit) => unit.isActive !== false);
    // Nhà thuốc nhập theo quy cách đóng gói (hộp, chai…) nên chọn sẵn đơn vị lớn nhất còn dùng.
    const unit =
      (preferredUnitName
        ? activeUnits.find(
            (item) => item.name.toLowerCase() === preferredUnitName.trim().toLowerCase(),
          )
        : undefined) ??
      [...activeUnits].sort((a, b) => b.conversionToBase - a.conversionToBase)[0] ??
      product.units[0];
    if (!unit) return null;
    return {
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
      extraBatch: false,
    };
  }

  async function addProduct(productId: string): Promise<void> {
    const line = await productToLine(productId);
    if (!line) {
      void message.error("Sản phẩm chưa có đơn vị tính");
      return;
    }
    setLines((current) => [
      ...current,
      { ...line, extraBatch: current.some((item) => item.productId === productId) },
    ]);
    setProductSearch("");
  }

  async function addFromSearchEnter(): Promise<void> {
    const value = productSearch.trim();
    if (!value) return;
    const found = (
      await http.get<Envelope<Paged<ProductListItem>>>("/products", {
        params: { search: value, page: 1, limit: 2 },
      })
    ).data.data.items;
    if (found.length === 1) await addProduct(found[0]!.id);
    else if (found.length === 0) void message.warning(`Không tìm thấy sản phẩm “${value}”`);
  }

  function appendLines(added: DraftLine[]): void {
    setLines((current) => markExtraBatches([...current, ...added]));
  }

  const { importing, importFile, template } = useReceiptImport({ productToLine, appendLines });

  function changeLine(key: string, patch: Partial<DraftLine>): void {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  /** Cùng một sản phẩm về nhiều lô khác nhau: thêm dòng giữ nguyên sản phẩm, đơn vị, giá. */
  function addBatch(line: DraftLine): void {
    setLines((current) => {
      const lastIndex = current.map((item) => item.productId).lastIndexOf(line.productId);
      const copy: DraftLine = {
        ...line,
        key: crypto.randomUUID(),
        quantity: 1,
        batchNumber: "",
        manufactureDate: "",
        expiryDate: "",
        extraBatch: true,
      };
      return [...current.slice(0, lastIndex + 1), copy, ...current.slice(lastIndex + 1)];
    });
  }

  function removeLine(key: string): void {
    setLines((current) => markExtraBatches(current.filter((item) => item.key !== key)));
  }

  const save = useMutation({
    mutationFn: async (options: ReceiptSavedOptions) => {
      const body = {
        supplierId,
        receivedAt,
        supplierInvoiceNumber: supplierInvoiceNumber.trim() || null,
        supplierInvoiceDate: supplierInvoiceDate || null,
        note: note.trim() || null,
        discountAmount,
        vatAmount,
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
        const response = await http.patch<Envelope<GoodsReceiptDetail>>(
          `/goods-receipts/${receipt.id}`,
          { ...body, version: receipt.version },
        );
        return { id: response.data.data.id, options };
      }
      const createBody = prefill?.purchaseOrderId
        ? { ...body, purchaseOrderId: prefill.purchaseOrderId }
        : body;
      const response = await http.post<Envelope<GoodsReceiptDetail>>(
        "/goods-receipts",
        createBody,
        {
          headers: submitKey.headers(createBody),
        },
      );
      return { id: response.data.data.id, options };
    },
    onSuccess: async ({ id, options }) => {
      submitKey.done();
      void message.success(
        options.inspect
          ? "Đã lưu nháp — tiếp tục kiểm nhận hàng"
          : receipt
            ? "Đã lưu phiếu nháp"
            : "Đã tạo phiếu nháp",
      );
      await onSaved(id, options);
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được phiếu nhập")),
  });

  const summaryText = `${productCount} mặt hàng • ${lines.length} dòng lô`;

  return (
    <Modal
      open={open}
      width="min(1280px, 96vw)"
      style={{ top: 20 }}
      onCancel={onClose}
      destroyOnHidden
      className="receipt-form-modal"
      title={
        <div className="receipt-form-title">
          <div>
            <span>{receipt ? `Sửa phiếu nhập ${receipt.code}` : "Tạo phiếu nhập hàng"}</span>
            <Tag color="blue">Bản nháp</Tag>
          </div>
          <small>Nhập chứng từ và hàng hóa từ nhà cung cấp</small>
        </div>
      }
      footer={
        <div className="receipt-form-footer">
          <span className="text-secondary">
            {summaryText} &nbsp;·&nbsp; <span className="required-mark">*</span> Thông tin bắt buộc
          </span>
          <Button onClick={onClose}>Đóng</Button>
          <Button
            disabled={blocked}
            loading={save.isPending && !save.variables?.inspect}
            onClick={() => save.mutate({ inspect: false })}
          >
            Lưu nháp
          </Button>
          {can("goods_receipt.confirm") ? (
            <Button
              type="primary"
              disabled={blocked}
              loading={save.isPending && save.variables?.inspect}
              onClick={() => save.mutate({ inspect: true })}
            >
              Lưu nháp &amp; kiểm nhận <ArrowRightOutlined />
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="receipt-form">
        <Alert
          type="info"
          showIcon
          title="Lưu nháp chưa cộng tồn kho. Kiểm nhận từng dòng trước khi xác nhận nhập kho."
        />

        <section className="form-section">
          <h4>
            <FileTextOutlined /> Thông tin chứng từ
          </h4>
          <div className="receipt-form-grid">
            <div className="field">
              <span>
                Nhà cung cấp <span className="required-mark">*</span>
              </span>
              <div className="supplier-picker">
                <Select
                  showSearch
                  prefix={<SearchOutlined />}
                  optionFilterProp="label"
                  placeholder="Tìm nhà cung cấp"
                  loading={suppliers.isLoading}
                  value={supplierId}
                  onChange={setSupplierId}
                  notFoundContent={
                    suppliers.isLoading ? "Đang tải…" : "Không có nhà cung cấp phù hợp"
                  }
                  options={(suppliers.data ?? [])
                    .filter((item) => item.isActive || item.id === supplierId)
                    .map((item) => ({ value: item.id, label: item.name }))}
                  popupRender={(menu) =>
                    can("catalog.manage") ? (
                      <>
                        {menu}
                        <Divider style={{ margin: "4px 0" }} />
                        <Button
                          type="text"
                          block
                          icon={<PlusOutlined />}
                          className="select-footer-btn"
                          onClick={() => setAddingSupplier(true)}
                        >
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
                    <Button
                      icon={<PlusOutlined />}
                      onClick={() => setAddingSupplier(true)}
                      aria-label="Thêm nhà cung cấp mới"
                    />
                  </Tooltip>
                ) : null}
              </div>
              {supplier ? (
                <span className="field-hint">
                  MST {supplier.taxCode ?? "—"} · GPKD {supplier.licenseNumber ?? "—"} · ĐT{" "}
                  {supplier.phone ?? "—"}
                </span>
              ) : null}
            </div>
            <label className="field">
              <span>Số hóa đơn</span>
              <Input
                placeholder="Theo hóa đơn NCC"
                value={supplierInvoiceNumber}
                onChange={(event) => setSupplierInvoiceNumber(event.target.value)}
                maxLength={50}
              />
            </label>
            <label className="field">
              <span>Ngày hóa đơn</span>
              <DatePicker
                format={DATE_FORMAT}
                placeholder="dd/mm/yyyy"
                value={supplierInvoiceDate ? dayjs(supplierInvoiceDate) : null}
                disabledDate={(date) => date.isAfter(dayjs(), "day")}
                onChange={(value) =>
                  setSupplierInvoiceDate(value ? value.format("YYYY-MM-DD") : "")
                }
              />
            </label>
            <label className="field">
              <span>
                Ngày nhận hàng <span className="required-mark">*</span>
              </span>
              <DatePicker
                format={DATE_FORMAT}
                allowClear={false}
                value={receivedAt ? dayjs(receivedAt) : null}
                disabledDate={(date) => date.isAfter(dayjs(), "day")}
                onChange={(value) => value && setReceivedAt(value.format("YYYY-MM-DD"))}
              />
            </label>
            <label className="field">
              <span>
                Kho nhận <span className="required-mark">*</span>
              </span>
              <Tooltip title="Hàng nhập vào kho của cửa hàng đang chọn ở thanh trên cùng">
                <Select
                  disabled
                  value={storeId ?? undefined}
                  options={store ? [{ value: store.id, label: `${store.name}` }] : []}
                />
              </Tooltip>
            </label>
            <label className="field receipt-note-field">
              <span>Ghi chú</span>
              <Input
                placeholder="Nhập ghi chú cho phiếu…"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={500}
              />
            </label>
          </div>
          <p className="field-hint">
            Ngày hóa đơn theo chứng từ; ngày nhận hàng theo thực tế hàng về.
          </p>
        </section>

        <section className="form-section">
          <div className="form-section-head">
            <h4>
              <InboxOutlined /> Hàng hóa nhập
            </h4>
            <span className="text-secondary">{summaryText}</span>
          </div>
          <div className="receipt-search-row">
            <AutoComplete
              ref={searchRef}
              className="receipt-product-search"
              value={productSearch}
              onChange={setProductSearch}
              onSelect={(id) => void addProduct(String(id))}
              options={(products.data ?? []).map((product) => ({
                value: product.id,
                label: (
                  <div className="product-option">
                    <strong>{product.name}</strong>
                    <span>
                      {[
                        product.code,
                        product.dosageForm,
                        product.strengthText,
                        product.stock ? `tồn ${formatNumber(product.stock.sellable)}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                ),
              }))}
              notFoundContent={
                productTerm && !products.isFetching
                  ? "Không tìm thấy — thêm sản phẩm mới ở trang Thuốc & sản phẩm"
                  : null
              }
            >
              <Input
                prefix={<SearchOutlined />}
                suffix={<BarcodeOutlined />}
                placeholder="Quét mã vạch, tìm tên thuốc, mã hoặc hoạt chất…"
                onPressEnter={(event) => {
                  if ((products.data?.length ?? 0) <= 1) {
                    event.preventDefault();
                    void addFromSearchEnter();
                  }
                }}
              />
            </AutoComplete>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) importFile(file);
                event.target.value = "";
              }}
            />
            <Dropdown
              menu={{
                items: [
                  { key: "pick", label: "Chọn tệp Excel (.xlsx hoặc .csv)" },
                  { key: "template", label: "Tải tệp mẫu Excel" },
                ],
                onClick: ({ key }) => (key === "pick" ? fileRef.current?.click() : void template()),
              }}
            >
              <Button icon={<FileExcelOutlined />} loading={importing}>
                Nhập Excel <DownOutlined />
              </Button>
            </Dropdown>
          </div>

          <ReceiptLinesTable
            lines={lines}
            loading={loadingPrefill}
            productById={productById}
            issuesByLine={issuesByLine}
            duplicateKeys={duplicateKeys}
            onChange={changeLine}
            onAddBatch={addBatch}
            onRemove={removeLine}
          />
          <div className="receipt-add-row">
            <Button icon={<PlusOutlined />} onClick={() => searchRef.current?.focus()}>
              Thêm sản phẩm
            </Button>
            <span className="field-hint">Mỗi số lô / hạn dùng là một dòng riêng.</span>
          </div>
        </section>

        <ReceiptSummary
          checks={checks}
          blocked={blocked}
          goodsAmount={goodsAmount}
          discountAmount={discountAmount}
          discountTooHigh={discountTooHigh}
          vatAmount={vatAmount}
          totalAmount={totalAmount}
          onDiscountChange={setDiscountAmount}
          onVatChange={setVatAmount}
        />
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
