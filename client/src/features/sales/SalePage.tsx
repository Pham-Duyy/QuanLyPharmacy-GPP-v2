import {
  BarcodeOutlined,
  CheckCircleFilled,
  CloseOutlined,
  DeleteOutlined,
  FileProtectOutlined,
  PlusOutlined,
  PrinterOutlined,
  SafetyCertificateOutlined,
  ShoppingCartOutlined,
  UserAddOutlined,
  UserOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  App,
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { InputRef } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import {
  formatVnd,
  type CategoryItem,
  type CustomerDetail,
  type CustomerSearchItem,
  type Envelope,
  type Invoice,
  type Paged,
  type PrescriptionDetail,
  type PrescriptionListItem,
  type ProductDetail,
  type ProductListItem,
  type SafetyResult,
} from "../../api/types.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";
import { printInvoice } from "./print-invoice.js";

type CartLine = {
  key: string;
  product: ProductDetail;
  unitId: string;
  quantity: number;
  /** Chỉ có ý nghĩa với thuốc kê đơn: dòng nào của đơn thuốc đang chọn khớp với dòng này. */
  prescriptionItemId: string | null;
};

type CatalogFilter = "ALL" | "RX" | "OTC" | "SUPPLEMENT" | "MEDICAL_DEVICE";

/** Thuốc kê đơn hoặc thuốc kiểm soát đặc biệt đều cần đơn thuốc mới bán được (contract §14.2). */
function needsPrescription(drugClass: string | null): boolean {
  return drugClass === "RX" || drugClass === "CONTROLLED";
}

const SEVERITY: Record<string, { label: string; color: string }> = {
  HIGH: { label: "Mức cao", color: "red" },
  MEDIUM: { label: "Trung bình", color: "orange" },
  INFO: { label: "Thông tin", color: "blue" },
};

const NOT_CHECKED_TEXT: Record<string, string> = {
  NO_INGREDIENT_MAPPING: "chưa gắn hoạt chất nên không đối chiếu trùng hoạt chất và dị ứng được",
  INTERACTION_SOURCE_NOT_CONFIGURED: "chưa có nguồn dữ liệu tương tác thuốc",
};

/**
 * Màn hình bán hàng. Giao diện chỉ gửi ý định bán; đơn giá, VAT, lô FEFO và
 * tổng tiền đều do máy chủ tính (contract §14.1), nên phần tổng ở đây chỉ là
 * số tạm tính để người bán ước lượng.
 */
export function SalePage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const searchRef = useRef<InputRef>(null);
  const [term, setTerm] = useState("");
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>("ALL");
  const [categoryId, setCategoryId] = useState<string>();
  const [catalogPage, setCatalogPage] = useState(1);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customer, setCustomer] = useState<CustomerSearchItem | null>(null);
  const [prescriptionSearch, setPrescriptionSearch] = useState("");
  const [prescription, setPrescription] = useState<PrescriptionDetail | null>(null);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [ackReason, setAckReason] = useState("");
  const [discountType, setDiscountType] = useState<"PERCENT" | "AMOUNT">("PERCENT");
  const [discountValue, setDiscountValue] = useState(0);
  const [discountReason, setDiscountReason] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [tendered, setTendered] = useState<number | null>(null);
  const [printAfterPayment, setPrintAfterPayment] = useState(true);
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [done, setDone] = useState<Invoice | null>(null);
  const searchTerm = useDebounced(term.trim(), 250);
  const customerTerm = useDebounced(customerSearch.trim(), 250);

  const search = useQuery({
    queryKey: ["products", searchTerm, catalogFilter, categoryId, catalogPage],
    queryFn: async () => {
      const response = await http.get<Envelope<Paged<ProductListItem>>>("/products", {
        params: {
          search: searchTerm || undefined,
          page: catalogPage,
          limit: 15,
          categoryId,
          ...(catalogFilter === "RX" || catalogFilter === "OTC" ? { productType: "DRUG", drugClass: catalogFilter } : {}),
          ...(catalogFilter === "SUPPLEMENT" || catalogFilter === "MEDICAL_DEVICE" ? { productType: catalogFilter } : {}),
        },
      });
      return response.data.data;
    },
    placeholderData: (previous) => previous,
  });

  const categories = useQuery({
    queryKey: ["sale-categories"],
    queryFn: async () => (await http.get<Envelope<Paged<CategoryItem>>>("/categories", { params: { page: 1, limit: 100 } })).data.data.items,
  });

  // Chỉ tìm khi gõ đủ 3 ký tự, khớp đúng quy tắc GET /customers (contract §11).
  const customerSearchResults = useQuery({
    queryKey: ["customer-search", customerTerm],
    enabled: customerTerm.length >= 3,
    queryFn: async () => {
      const response = await http.get<Envelope<CustomerSearchItem[]>>("/customers", { params: { search: customerTerm } });
      return response.data.data;
    },
  });

  const createCustomer = useMutation({
    mutationFn: async () =>
      (
        await http.post<Envelope<CustomerDetail>>("/customers", {
          fullName: newCustomerName.trim() || null,
          phone: newCustomerPhone.trim() || null,
        })
      ).data.data,
    onSuccess: (created) => {
      setCustomer(created);
      setNewCustomerOpen(false);
      setNewCustomerName("");
      setNewCustomerPhone("");
      void message.success("Đã tạo và chọn khách hàng cho đơn bán");
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không thể tạo khách hàng")),
  });

  const cartLines = useMemo(
    () => cart.map((line) => ({ productId: line.product.id, unitId: line.unitId, quantity: line.quantity })),
    [cart],
  );

  // Tải một lần rồi lọc theo mã hoặc tên khách ngay trên trình duyệt — danh
  // mục này không lớn tới mức cần endpoint tìm kiếm riêng. Endpoint chỉ lọc
  // được một trạng thái mỗi lần gọi, nên lấy hết rồi tự lọc còn dùng bán
  // tiếp được: VERIFIED hoặc PARTIALLY_DISPENSED (đã bán một phần vẫn còn
  // dòng chưa bán hết, contract §5.4 cho phép bán tiếp).
  const verifiedPrescriptions = useQuery({
    queryKey: ["usable-prescriptions"],
    enabled: can("prescription.read"),
    queryFn: async () => {
      const response = await http.get<Envelope<PrescriptionListItem[]>>("/prescriptions");
      return response.data.data.filter((item) => item.status === "VERIFIED" || item.status === "PARTIALLY_DISPENSED");
    },
  });

  const safety = useQuery({
    queryKey: ["safety-check", cartLines, prescription?.id, customer?.id],
    enabled: cart.length > 0,
    queryFn: async () => {
      const response = await http.post<Envelope<SafetyResult>>("/sales/safety-check", {
        lines: cartLines,
        prescriptionId: prescription?.id ?? null,
        customerId: customer?.id ?? null,
      });
      return response.data.data;
    },
  });

  const blocking = safety.data?.blocking ?? [];
  const warnings = safety.data?.warnings ?? [];
  const notChecked = safety.data?.notChecked ?? [];

  // Sửa giỏ hàng có thể làm một cảnh báo biến mất, khi đó ghi nhận cũ phải hết
  // hiệu lực theo. Lọc ngay lúc render, không đồng bộ lại state bằng effect.
  const liveCodes = new Set(warnings.map((warning) => warning.code));
  const liveAcked = [...acked].filter((code) => liveCodes.has(code));

  const body = {
    customerId: customer?.id ?? null,
    prescriptionId: prescription?.id ?? null,
    lines: cart.map((line) => ({
      productId: line.product.id,
      unitId: line.unitId,
      quantity: line.quantity,
      prescriptionItemId: line.prescriptionItemId,
    })),
    discount: discountValue > 0 ? { type: discountType, value: discountValue, reason: discountReason || "Giảm giá" } : null,
    acknowledgedWarnings: liveAcked.map((code) => ({ code, productIds: [], reason: ackReason || null })),
    payment: { method: paymentMethod, amountTendered: tendered },
  };

  /**
   * Khóa idempotency gắn với đúng một nội dung giỏ hàng: bấm lại sau khi mạng
   * lỗi thì dùng lại khóa cũ nên không bán hai lần, còn sửa giỏ hàng thì sinh
   * khóa mới để máy chủ không báo trùng khóa với nội dung khác (contract §2.3).
   */
  const attempt = useRef<{ signature: string; key: string }>({ signature: "", key: "" });

  const checkout = useMutation({
    mutationFn: async () => {
      const signature = JSON.stringify(body);
      if (attempt.current.signature !== signature) {
        attempt.current = { signature, key: crypto.randomUUID() };
      }
      const response = await http.post<Envelope<Invoice>>("/invoices", body, {
        headers: { "Idempotency-Key": attempt.current.key },
      });
      return response.data.data;
    },
    onSuccess: (invoice) => {
      if (printAfterPayment) void printInvoice(invoice.id, message);
      setDone(invoice);
      setCart([]);
      setCustomer(null);
      setPrescription(null);
      setAcked(new Set());
      setAckReason("");
      setDiscountValue(0);
      setDiscountReason("");
      setTendered(null);
    },
    onError: (error) => {
      void message.error(getErrorMessage(error, "Không bán được"));
    },
  });

  /** Dòng đơn thuốc còn khớp được với một sản phẩm: đúng thuốc, chưa bán hết theo đơn. */
  function matchingPrescriptionItems(productId: string) {
    return (prescription?.items ?? []).filter(
      (item) => item.productId === productId && (item.baseQuantity ?? 0) > item.dispensedBaseQuantity,
    );
  }

  /** `scannedCode` là mã vạch vừa quét: chọn đúng đơn vị gắn mã đó (quét mã hộp thì thêm một hộp). */
  async function addProduct(productId: string, scannedCode?: string) {
    const response = await http.get<Envelope<ProductDetail>>(`/products/${productId}`);
    const product = response.data.data;
    const unit =
      (scannedCode ? product.units.find((item) => item.barcodes?.includes(scannedCode)) : undefined) ??
      product.units.find((item) => item.isDefaultSaleUnit) ??
      product.units.find((item) => item.conversionToBase === 1) ??
      product.units[0];
    if (!unit) {
      void message.error("Sản phẩm chưa có đơn vị tính");
      return;
    }

    // Thuốc kê đơn thì thử khớp sẵn vào đơn đang chọn nếu chỉ có đúng một
    // dòng phù hợp; khớp nhiều dòng thì để trống, người bán tự chọn.
    const candidates = needsPrescription(product.drugClass) ? matchingPrescriptionItems(product.id) : [];
    const prescriptionItemId = candidates.length === 1 ? candidates[0]!.id : null;

    setCart((current) => {
      const found = current.find((line) => line.product.id === product.id && line.unitId === unit.id);
      if (found) {
        return current.map((line) => (line.key === found.key ? { ...line, quantity: line.quantity + 1 } : line));
      }
      return [...current, { key: `${product.id}:${unit.id}:${Date.now()}`, product, unitId: unit.id, quantity: 1, prescriptionItemId }];
    });
    setTerm("");
    searchRef.current?.focus();
  }

  /**
   * Enter trong ô tìm: máy quét mã vạch gõ rất nhanh rồi Enter, nên tra thẳng
   * API với chuỗi hiện tại thay vì dựa vào kết quả bảng (có thể còn của lần gõ trước).
   */
  async function handleSearchEnter() {
    const value = term.trim();
    if (!value) return;
    try {
      const response = await http.get<Envelope<Paged<ProductListItem>>>("/products", { params: { search: value, page: 1, limit: 2 } });
      const items = response.data.data.items;
      if (items.length === 1) await addProduct(items[0]!.id, value);
      else if (items.length === 0) void message.warning(`Không tìm thấy sản phẩm khớp “${value}”`);
    } catch (error) {
      void message.error(getErrorMessage(error, "Không tìm được sản phẩm"));
    }
  }

  function updateLine(key: string, patch: Partial<CartLine>) {
    setCart((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  function unitOf(line: CartLine) {
    return line.product.units.find((unit) => unit.id === line.unitId);
  }

  function lineTotal(line: CartLine): number {
    return (unitOf(line)?.currentPrice?.salePrice ?? 0) * line.quantity;
  }

  const subtotal = cart.reduce((sum, line) => sum + lineTotal(line), 0);
  const estimatedDiscount =
    discountValue <= 0 ? 0 : discountType === "PERCENT" ? Math.floor((subtotal * discountValue) / 100) : Math.min(discountValue, subtotal);
  const estimatedTotal = subtotal - estimatedDiscount;
  const estimatedChange = tendered !== null && tendered >= estimatedTotal && cart.length > 0 ? tendered - estimatedTotal : null;

  const needAck = warnings.filter((warning) => warning.requiresAck);
  const missingAck = needAck.filter((warning) => !liveAcked.includes(warning.code));
  const canSell = cart.length > 0 && blocking.length === 0 && missingAck.length === 0 && !safety.isFetching;

  const nameOf = (productId: string) => cart.find((line) => line.product.id === productId)?.product.name ?? productId;

  // F2: về ô tìm thuốc; F9: thanh toán. Hai phím này trình duyệt không dùng.
  const { mutate: submitCheckout, isPending: checkoutPending } = checkout;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "F2") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === "F9") {
        event.preventDefault();
        if (canSell && !checkoutPending) submitCheckout();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canSell, checkoutPending, submitCheckout]);

  function clearPrescription() {
    setPrescription(null);
    setCart((current) => current.map((line) => ({ ...line, prescriptionItemId: null })));
  }

  return (
    <div className="sale-page">
      <PageHeader
        icon={<ShoppingCartOutlined />}
        title="Bán thuốc"
        description="Quét mã vạch hoặc tìm theo tên, hoạt chất, mã sản phẩm để thêm vào đơn."
        extra={
          <div className="shortcut-hints">
            <span>
              <kbd>F2</kbd> Tìm thuốc
            </span>
            <span>
              <kbd>F9</kbd> Thanh toán
            </span>
          </div>
        }
      />

      <div className="pos-layout">
        <Card className="pos-catalog">
          <Input
            ref={searchRef}
            size="large"
            className="pos-search"
            prefix={<BarcodeOutlined />}
            placeholder="Quét mã vạch hoặc nhập tên thuốc, hoạt chất, mã sản phẩm…"
            value={term}
            allowClear
            autoFocus
            onChange={(event) => {
              setTerm(event.target.value);
              setCatalogPage(1);
            }}
            onPressEnter={() => void handleSearchEnter()}
          />
          <div className="toolbar pos-filters">
            <Segmented
              value={catalogFilter}
              onChange={(value) => {
                setCatalogFilter(value as CatalogFilter);
                setCatalogPage(1);
              }}
              options={[
                { label: "Tất cả", value: "ALL" },
                { label: "Kê đơn", value: "RX" },
                { label: "Không kê đơn", value: "OTC" },
                { label: "TPCN", value: "SUPPLEMENT" },
                { label: "Thiết bị y tế", value: "MEDICAL_DEVICE" },
              ]}
            />
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              className="pos-category"
              placeholder="Tất cả nhóm hàng"
              value={categoryId}
              onChange={(value) => {
                setCategoryId(value);
                setCatalogPage(1);
              }}
              options={(categories.data ?? []).map((item) => ({ value: item.id, label: item.name }))}
            />
          </div>
          <Table
            className="sale-product-table"
            rowKey="id"
            size="middle"
            loading={search.isFetching}
            dataSource={search.data?.items ?? []}
            scroll={{ x: 600 }}
            onRow={(product) => ({ onDoubleClick: () => void addProduct(product.id) })}
            pagination={{
              current: catalogPage,
              pageSize: 15,
              total: search.data?.pagination.total ?? 0,
              showSizeChanger: false,
              onChange: setCatalogPage,
              showTotal: (total) => `${total} sản phẩm`,
            }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không tìm thấy sản phẩm phù hợp" /> }}
            columns={[
              {
                title: "Sản phẩm",
                key: "name",
                render: (_: unknown, product: ProductListItem) => (
                  <div className="cell-main">
                    <strong>
                      {product.name} {product.drugClass === "RX" || product.drugClass === "CONTROLLED" ? <Tag color="orange">Kê đơn</Tag> : null}
                    </strong>
                    <span>{[product.code, product.dosageForm, product.strengthText].filter(Boolean).join(" · ")}</span>
                  </div>
                ),
              },
              {
                title: "Hoạt chất",
                key: "ingredients",
                width: 180,
                ellipsis: true,
                responsive: ["xl"],
                render: (_: unknown, product: ProductListItem) => product.ingredients.map((item) => item.name).join(", ") || "—",
              },
              {
                title: "Tồn bán được",
                key: "stock",
                width: 116,
                align: "right",
                render: (_: unknown, product: ProductListItem) =>
                  product.stock ? <span className={product.stock.sellable > 0 ? "sale-stock" : "sale-stock low"}>{product.stock.sellable.toLocaleString("vi-VN")}</span> : "—",
              },
              {
                title: "Giá bán",
                key: "price",
                width: 110,
                align: "right",
                render: (_: unknown, product: ProductListItem) => <Typography.Text strong>{formatVnd(product.currentPrice?.salePrice)}</Typography.Text>,
              },
              {
                key: "action",
                width: 92,
                align: "right",
                render: (_: unknown, product: ProductListItem) => {
                  const soldOut = product.stock !== null && product.stock.sellable <= 0;
                  return (
                    <Tooltip title={soldOut ? "Hết hàng bán được" : null}>
                      <Button type="primary" ghost size="small" icon={<PlusOutlined />} disabled={soldOut} onClick={() => void addProduct(product.id)}>
                        Thêm
                      </Button>
                    </Tooltip>
                  );
                },
              },
            ]}
          />
        </Card>

        <Card className="pos-checkout" title="Đơn bán hiện tại" extra={cart.length > 0 ? <Button danger type="text" size="small" onClick={() => setCart([])}>Xóa đơn</Button> : null}>
          <div className="pos-section">
            {customer ? (
              <div className="pos-chip">
                <span className="pos-chip-icon">
                  <UserOutlined />
                </span>
                <span className="pos-chip-text">
                  <strong>{customer.fullName ?? "Khách chưa có tên"}</strong>
                  <span>{customer.phone ?? "Không có số điện thoại"}</span>
                </span>
                <Button type="text" size="small" icon={<CloseOutlined />} aria-label="Bỏ chọn khách" onClick={() => setCustomer(null)} />
              </div>
            ) : (
              <Space.Compact block>
                <AutoComplete
                  style={{ width: "100%" }}
                  value={customerSearch}
                  onChange={setCustomerSearch}
                  options={(customerSearchResults.data ?? []).map((item) => ({
                    value: item.id,
                    label: `${item.fullName ?? "Chưa rõ tên"}${item.phone ? ` · ${item.phone}` : ""}`,
                  }))}
                  onSelect={(id) => {
                    const found = customerSearchResults.data?.find((item) => item.id === id);
                    if (found) setCustomer(found);
                    setCustomerSearch("");
                  }}
                  notFoundContent={customerTerm.length >= 3 && !customerSearchResults.isFetching ? "Không tìm thấy khách" : null}
                >
                  <Input prefix={<UserOutlined />} placeholder="Khách lẻ · tìm tên hoặc SĐT (≥ 3 ký tự)" allowClear />
                </AutoComplete>
                {can("customer.manage") ? (
                  <Tooltip title="Thêm khách hàng mới">
                    <Button icon={<UserAddOutlined />} onClick={() => setNewCustomerOpen(true)} aria-label="Thêm khách hàng mới" />
                  </Tooltip>
                ) : null}
              </Space.Compact>
            )}

            {prescription ? (
              <div className="pos-chip pos-chip-rx">
                <span className="pos-chip-icon">
                  <FileProtectOutlined />
                </span>
                <span className="pos-chip-text">
                  <strong>Đơn thuốc {prescription.code}</strong>
                  <span>{prescription.customer?.fullName ?? "Khách lẻ"}</span>
                </span>
                <Button type="text" size="small" icon={<CloseOutlined />} aria-label="Bỏ chọn đơn thuốc" onClick={clearPrescription} />
              </div>
            ) : (
              <AutoComplete
                style={{ width: "100%" }}
                value={prescriptionSearch}
                onChange={setPrescriptionSearch}
                filterOption={(input, option) => typeof option?.label === "string" && option.label.toLowerCase().includes(input.toLowerCase())}
                options={(verifiedPrescriptions.data ?? []).map((item) => ({ value: item.id, label: `${item.code} — ${item.customer?.fullName ?? "Khách lẻ"}` }))}
                onSelect={async (id) => {
                  const response = await http.get<Envelope<PrescriptionDetail>>(`/prescriptions/${id}`);
                  setPrescription(response.data.data);
                  setPrescriptionSearch("");
                  // Đơn thuốc thường đã gắn sẵn khách — tự điền nếu chưa chọn ai.
                  if (!customer && response.data.data.customer) setCustomer(response.data.data.customer);
                }}
              >
                <Input prefix={<FileProtectOutlined />} placeholder="Chọn đơn thuốc đã xác nhận (nếu bán thuốc kê đơn)" allowClear />
              </AutoComplete>
            )}
          </div>

          <div className="pos-cart">
            {cart.length === 0 ? (
              <div className="pos-cart-empty">
                <ShoppingCartOutlined />
                <strong>Chưa có sản phẩm trong đơn</strong>
                <span>Quét mã vạch hoặc bấm “Thêm” ở danh sách bên cạnh.</span>
              </div>
            ) : (
              cart.map((line) => {
                const unit = unitOf(line);
                const candidates = needsPrescription(line.product.drugClass) ? matchingPrescriptionItems(line.product.id) : [];
                return (
                  <div className="pos-line" key={line.key}>
                    <div className="pos-line-main">
                      <strong>{line.product.name}</strong>
                      <span>
                        {formatVnd(unit?.currentPrice?.salePrice)} / {unit?.name ?? "—"}
                      </span>
                    </div>
                    <strong className="pos-line-total">{formatVnd(lineTotal(line))}</strong>
                    <div className="pos-line-controls">
                      <Select size="small" value={line.unitId} onChange={(unitId) => updateLine(line.key, { unitId })} options={line.product.units.map((item) => ({ value: item.id, label: item.name }))} popupMatchSelectWidth={false} />
                      <InputNumber size="small" min={1} value={line.quantity} onChange={(quantity) => updateLine(line.key, { quantity: quantity ?? 1 })} aria-label={`Số lượng ${line.product.name}`} />
                      {needsPrescription(line.product.drugClass) ? (
                        candidates.length === 0 ? (
                          <Typography.Text type="danger" className="pos-line-rx">
                            {prescription ? "Không có trong đơn thuốc" : "Cần chọn đơn thuốc"}
                          </Typography.Text>
                        ) : (
                          <Select
                            size="small"
                            className="pos-line-rx"
                            value={line.prescriptionItemId ?? undefined}
                            placeholder="Dòng đơn thuốc"
                            onChange={(prescriptionItemId) => updateLine(line.key, { prescriptionItemId })}
                            options={candidates.map((item) => ({ value: item.id, label: `${item.quantity - item.dispensedBaseQuantity} ${item.unitName ?? ""} còn lại` }))}
                          />
                        )
                      ) : null}
                    </div>
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`Xóa ${line.product.name}`} onClick={() => setCart((current) => current.filter((item) => item.key !== line.key))} />
                  </div>
                );
              })
            )}
          </div>

          {cart.length > 0 ? (
            <SafetyPanel
              loading={safety.isFetching}
              failed={safety.isError}
              blocking={blocking}
              warnings={warnings}
              notChecked={notChecked}
              liveAcked={liveAcked}
              nameOf={nameOf}
              onToggle={(code, checked) =>
                setAcked((current) => {
                  const next = new Set(current);
                  if (checked) next.add(code);
                  else next.delete(code);
                  return next;
                })
              }
              ackReason={needAck.length > 0 && missingAck.length === 0 ? ackReason : null}
              onAckReasonChange={setAckReason}
            />
          ) : null}

          <div className="pos-section">
            <span className="pos-label">Giảm giá</span>
            <Space.Compact block>
              <Select
                value={discountType}
                onChange={setDiscountType}
                style={{ width: 110 }}
                options={[
                  { value: "PERCENT", label: "Theo %" },
                  { value: "AMOUNT", label: "Số tiền" },
                ]}
              />
              <InputNumber style={{ width: "100%" }} min={0} value={discountValue} onChange={(value) => setDiscountValue(value ?? 0)} />
            </Space.Compact>
            {discountValue > 0 ? <Input placeholder="Lý do giảm giá (bắt buộc)" value={discountReason} onChange={(event) => setDiscountReason(event.target.value)} /> : null}
          </div>

          <div className="pos-section">
            <span className="pos-label">Thanh toán</span>
            <Segmented
              block
              value={paymentMethod}
              onChange={(value) => setPaymentMethod(value as string)}
              options={[
                { value: "CASH", label: "Tiền mặt" },
                { value: "BANK_TRANSFER", label: "Chuyển khoản" },
                { value: "CARD", label: "Thẻ" },
              ]}
            />
            <InputNumber
              style={{ width: "100%" }}
              min={0}
              step={1000}
              value={tendered}
              onChange={setTendered}
              placeholder="Khách đưa — để trống nếu không cần tính tiền thừa"
              formatter={(value) => (value ? Number(value).toLocaleString("vi-VN") : "")}
              parser={(value) => Number((value ?? "").replace(/\D/g, ""))}
            />
            <div className="sale-quick-tender">
              {[estimatedTotal, 100_000, 200_000, 500_000]
                .filter((value, index, values) => value > 0 && values.indexOf(value) === index)
                .map((value) => (
                  <Button key={value} size="small" onClick={() => setTendered(value)}>
                    {formatVnd(value)}
                  </Button>
                ))}
            </div>
          </div>

          <div className="pos-totals">
            <div>
              <span>Tạm tính</span>
              <span>{formatVnd(subtotal)}</span>
            </div>
            <div>
              <span>Giảm giá</span>
              <span>{estimatedDiscount > 0 ? `−${formatVnd(estimatedDiscount)}` : formatVnd(0)}</span>
            </div>
            {estimatedChange !== null ? (
              <div>
                <span>Tiền thừa (tạm tính)</span>
                <span>{formatVnd(estimatedChange)}</span>
              </div>
            ) : null}
            <div className="pos-total-due">
              <span>Khách phải trả</span>
              <strong>{formatVnd(estimatedTotal)}</strong>
            </div>
            <p className="pos-note">Số tạm tính. Máy chủ tính lại đơn giá, VAT và tổng tiền khi lập hóa đơn.</p>
          </div>

          <Button type="primary" size="large" block className="pos-pay" disabled={!canSell} loading={checkout.isPending} onClick={() => checkout.mutate()}>
            Thanh toán <kbd>F9</kbd>
          </Button>
          {cart.length > 0 && !canSell && !safety.isFetching ? (
            <p className="pos-blocked">
              <WarningFilled /> {blocking.length > 0 ? "Còn vấn đề chặn bán, xem mục Kiểm tra an toàn." : `Còn ${missingAck.length} cảnh báo cần ghi nhận trước khi bán.`}
            </p>
          ) : null}
          <Checkbox checked={printAfterPayment} onChange={(event) => setPrintAfterPayment(event.target.checked)} className="pos-print">
            In hóa đơn sau khi thanh toán
          </Checkbox>
        </Card>
      </div>

      <Modal
        open={newCustomerOpen}
        title="Thêm khách hàng mới"
        okText="Tạo và chọn"
        cancelText="Hủy"
        confirmLoading={createCustomer.isPending}
        okButtonProps={{ disabled: !newCustomerName.trim() && !newCustomerPhone.trim() }}
        onOk={() => createCustomer.mutate()}
        onCancel={() => setNewCustomerOpen(false)}
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Typography.Text type="secondary">Nhập ít nhất họ tên hoặc số điện thoại. Thông tin sức khỏe chỉ được bổ sung khi khách đồng ý.</Typography.Text>
          <Input placeholder="Họ và tên" value={newCustomerName} onChange={(event) => setNewCustomerName(event.target.value)} autoFocus />
          <Input placeholder="Số điện thoại" inputMode="tel" value={newCustomerPhone} onChange={(event) => setNewCustomerPhone(event.target.value)} />
        </Space>
      </Modal>

      <Modal
        open={done !== null}
        onCancel={() => setDone(null)}
        afterClose={() => searchRef.current?.focus()}
        title={null}
        width={460}
        footer={
          <div className="sale-done-actions">
            <Button icon={<PrinterOutlined />} onClick={() => done && void printInvoice(done.id, message)}>
              In lại hóa đơn
            </Button>
            <Button type="primary" autoFocus onClick={() => setDone(null)}>
              Bán đơn mới
            </Button>
          </div>
        }
      >
        {done ? (
          <div className="sale-done">
            <CheckCircleFilled className="sale-done-icon" />
            <h3>Thanh toán thành công</h3>
            <span className="mono">{done.code}</span>
            <div className="sale-done-total">{formatVnd(done.totalAmount)}</div>
            {done.changeAmount !== null ? (
              <div className="sale-done-change">
                Tiền thừa trả khách <strong>{formatVnd(done.changeAmount)}</strong>
              </div>
            ) : null}
            <dl className="sale-done-summary">
              <div>
                <dt>Tạm tính</dt>
                <dd>{formatVnd(done.subtotal)}</dd>
              </div>
              <div>
                <dt>Giảm giá</dt>
                <dd>{done.discountAmount > 0 ? `−${formatVnd(done.discountAmount)}` : formatVnd(0)}</dd>
              </div>
              <div>
                <dt>Trong đó VAT</dt>
                <dd>{formatVnd(done.vatAmount)}</dd>
              </div>
            </dl>
            <div className="sale-done-batches">
              <span>Lô đã xuất (FEFO)</span>
              {done.lines.flatMap((line) =>
                line.allocations.map((allocation) => (
                  <div key={allocation.id}>
                    <span>
                      {line.productName} · lô <span className="mono">{allocation.batchNumber}</span>
                    </span>
                    <strong>{allocation.baseQuantity}</strong>
                  </div>
                )),
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function SafetyPanel({
  loading,
  failed,
  blocking,
  warnings,
  notChecked,
  liveAcked,
  nameOf,
  onToggle,
  ackReason,
  onAckReasonChange,
}: {
  loading: boolean;
  failed: boolean;
  blocking: SafetyResult["blocking"];
  warnings: SafetyResult["warnings"];
  notChecked: SafetyResult["notChecked"];
  liveAcked: string[];
  nameOf: (productId: string) => string;
  onToggle: (code: string, checked: boolean) => void;
  ackReason: string | null;
  onAckReasonChange: (value: string) => void;
}) {
  return (
    <div className="pos-safety">
      <div className="pos-safety-head">
        <SafetyCertificateOutlined />
        <strong>Kiểm tra an toàn</strong>
        {loading ? <Spin size="small" /> : null}
      </div>

      {failed ? <div className="pos-safety-item danger">Không kiểm tra được an toàn. Thử sửa đơn hoặc tải lại trang.</div> : null}

      {!loading && !failed && blocking.length === 0 && warnings.length === 0 ? (
        <div className="pos-safety-item ok">
          <CheckCircleFilled /> Không phát hiện vấn đề chặn bán
        </div>
      ) : null}

      {blocking.map((item) => (
        <div className="pos-safety-item danger" key={`${item.code}-${item.productId}`}>
          {item.message}
        </div>
      ))}

      {warnings.map((warning) => {
        const severity = SEVERITY[warning.severity] ?? { label: warning.severity, color: "default" };
        return (
          <div className="pos-safety-item warning" key={`${warning.code}-${warning.productIds.join(",")}`}>
            <div className="pos-safety-title">
              <span>{warning.message}</span>
              <Tag color={severity.color}>{severity.label}</Tag>
            </div>
            {warning.requiresAck ? (
              <Checkbox checked={liveAcked.includes(warning.code)} onChange={(event) => onToggle(warning.code, event.target.checked)}>
                Đã tư vấn khách và chịu trách nhiệm tiếp tục bán
              </Checkbox>
            ) : (
              <span className="pos-safety-source">
                Nguồn: {warning.source} ({warning.sourceVersion})
              </span>
            )}
          </div>
        );
      })}

      {ackReason !== null ? <Input size="small" placeholder="Ghi chú khi ghi nhận cảnh báo (không bắt buộc)" value={ackReason} onChange={(event) => onAckReasonChange(event.target.value)} /> : null}

      {notChecked.length > 0 ? (
        <div className="pos-safety-item info">
          <strong>Hệ thống KHÔNG kiểm tra được các mục sau, đừng coi là an toàn:</strong>
          <ul>
            {notChecked.map((item) => (
              <li key={`${item.productId}-${item.reason}`}>
                {nameOf(item.productId)}: {NOT_CHECKED_TEXT[item.reason] ?? item.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
