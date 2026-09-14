import { BarcodeOutlined, DeleteOutlined, PlusOutlined, PrinterOutlined, UserAddOutlined, WarningOutlined } from "@ant-design/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Col,
  Divider,
  Empty,
  Input,
  InputNumber,
  Modal,
  Radio,
  Row,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useMemo, useRef, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import {
  formatVnd,
  type CustomerSearchItem,
  type CustomerDetail,
  type CategoryItem,
  type Envelope,
  type Invoice,
  type Paged,
  type PrescriptionDetail,
  type PrescriptionListItem,
  type ProductDetail,
  type ProductListItem,
  type SafetyResult,
} from "../../api/types.js";
import { printInvoice } from "./print-invoice.js";
import { useAuth } from "../auth/AuthProvider.js";

type CartLine = {
  key: string;
  product: ProductDetail;
  unitId: string;
  quantity: number;
  /** Chỉ có ý nghĩa với thuốc kê đơn: dòng nào của đơn thuốc đang chọn khớp với dòng này. */
  prescriptionItemId: string | null;
};

/** Thuốc kê đơn hoặc thuốc kiểm soát đặc biệt đều cần đơn thuốc mới bán được (contract §14.2). */
function needsPrescription(drugClass: string | null): boolean {
  return drugClass === "RX" || drugClass === "CONTROLLED";
}

const SEVERITY_COLOR: Record<string, string> = { HIGH: "red", MEDIUM: "orange", INFO: "blue" };

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
  const [term, setTerm] = useState("");
  const [catalogFilter, setCatalogFilter] = useState<"ALL" | "RX" | "OTC" | "SUPPLEMENT" | "MEDICAL_DEVICE">("ALL");
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

  const search = useQuery({
    queryKey: ["products", term, catalogFilter, categoryId, catalogPage],
    queryFn: async () => {
      const response = await http.get<Envelope<Paged<ProductListItem>>>("/products", {
        params: {
          search: term || undefined,
          page: catalogPage,
          limit: 15,
          categoryId,
          ...(catalogFilter === "RX" || catalogFilter === "OTC" ? { productType: "DRUG", drugClass: catalogFilter } : {}),
          ...(catalogFilter === "SUPPLEMENT" || catalogFilter === "MEDICAL_DEVICE" ? { productType: catalogFilter } : {}),
        },
      });
      return response.data.data;
    },
  });

  const categories = useQuery({
    queryKey: ["sale-categories"],
    queryFn: async () => (await http.get<Envelope<Paged<CategoryItem>>>("/categories", { params: { page: 1, limit: 100 } })).data.data.items,
  });

  // Chỉ tìm khi gõ đủ 3 ký tự, khớp đúng quy tắc GET /customers (contract §11).
  const customerSearchResults = useQuery({
    queryKey: ["customer-search", customerSearch],
    enabled: customerSearch.trim().length >= 3,
    queryFn: async () => {
      const response = await http.get<Envelope<CustomerSearchItem[]>>("/customers", {
        params: { search: customerSearch },
      });
      return response.data.data;
    },
  });

  const createCustomer = useMutation({
    mutationFn: async () => (await http.post<Envelope<CustomerDetail>>("/customers", {
      fullName: newCustomerName.trim() || null,
      phone: newCustomerPhone.trim() || null,
    })).data.data,
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
    () =>
      cart.map((line) => ({
        productId: line.product.id,
        unitId: line.unitId,
        quantity: line.quantity,
      })),
    [cart],
  );

  // Tải một lần rồi lọc theo mã hoặc tên khách ngay trên trình duyệt — danh
  // mục này không lớn tới mức cần endpoint tìm kiếm riêng. Endpoint chỉ lọc
  // được một trạng thái mỗi lần gọi, nên lấy hết rồi tự lọc còn dùng bán
  // tiếp được: VERIFIED hoặc PARTIALLY_DISPENSED (đã bán một phần vẫn còn
  // dòng chưa bán hết, contract §5.4 cho phép bán tiếp).
  const verifiedPrescriptions = useQuery({
    queryKey: ["usable-prescriptions"],
    queryFn: async () => {
      const response = await http.get<Envelope<PrescriptionListItem[]>>("/prescriptions");
      return response.data.data.filter(
        (item) => item.status === "VERIFIED" || item.status === "PARTIALLY_DISPENSED",
      );
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
    discount:
      discountValue > 0
        ? { type: discountType, value: discountValue, reason: discountReason || "Giảm giá" }
        : null,
    acknowledgedWarnings: liveAcked.map((code) => ({
      code,
      productIds: [],
      reason: ackReason || null,
    })),
    payment: { method: paymentMethod, amountTendered: tendered },
  };

  /**
   * Khóa idempotency gắn với đúng một nội dung giỏ hàng: bấm lại sau khi mạng
   * lỗi thì dùng lại khóa cũ nên không bán hai lần, còn sửa giỏ hàng thì sinh
   * khóa mới để máy chủ không báo trùng khóa với nội dung khác.
   */
  const attempt = useRef<{ signature: string; key: string }>({ signature: "", key: "" });

  const checkout = useMutation({
    mutationFn: async () => {
      // Cùng nội dung thì giữ nguyên khóa, nên bấm lại sau khi mạng lỗi không
      // bán thành hai hóa đơn. Sửa giỏ hàng thì sinh khóa mới, vì máy chủ coi
      // cùng khóa với nội dung khác là lỗi (contract §2.3).
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
      if (printAfterPayment) void printInvoice(invoice.id, "k80");
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

  async function addProduct(productId: string) {
    const response = await http.get<Envelope<ProductDetail>>(`/products/${productId}`);
    const product = response.data.data;
    const unit =
      product.units.find((item) => item.isDefaultSaleUnit) ??
      product.units.find((item) => item.conversionToBase === 1) ??
      product.units[0];
    if (!unit) {
      void message.error("Sản phẩm chưa có đơn vị tính");
      return;
    }

    // Thuốc kê đơn thì thử khớp sẵn vào đơn đang chọn nếu chỉ có đúng một
    // dòng phù hợp; khớp nhiều dòng thì để trống, người bán tự chọn ở bảng.
    const candidates = needsPrescription(product.drugClass) ? matchingPrescriptionItems(product.id) : [];
    const prescriptionItemId = candidates.length === 1 ? candidates[0]!.id : null;

    setCart((current) => {
      const found = current.find(
        (line) => line.product.id === product.id && line.unitId === unit.id,
      );
      if (found) {
        return current.map((line) =>
          line.key === found.key ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [
        ...current,
        {
          key: `${product.id}:${unit.id}:${Date.now()}`,
          product,
          unitId: unit.id,
          quantity: 1,
          prescriptionItemId,
        },
      ];
    });
    setTerm("");
  }

  function unitOf(line: CartLine) {
    return line.product.units.find((unit) => unit.id === line.unitId);
  }

  function lineTotal(line: CartLine): number {
    return (unitOf(line)?.currentPrice?.salePrice ?? 0) * line.quantity;
  }

  const subtotal = cart.reduce((sum, line) => sum + lineTotal(line), 0);
  const estimatedDiscount =
    discountValue <= 0
      ? 0
      : discountType === "PERCENT"
        ? Math.floor((subtotal * discountValue) / 100)
        : Math.min(discountValue, subtotal);
  const estimatedTotal = subtotal - estimatedDiscount;

  const needAck = warnings.filter((warning) => warning.requiresAck);
  const missingAck = needAck.filter((warning) => !liveAcked.includes(warning.code));
  const canSell = cart.length > 0 && blocking.length === 0 && missingAck.length === 0;

  const nameOf = (productId: string) =>
    cart.find((line) => line.product.id === productId)?.product.name ?? productId;

  return (
    <div className="sale-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>Bán thuốc</Typography.Title>
          <Typography.Text>Tìm kiếm và thêm thuốc vào đơn hàng</Typography.Text>
        </div>
        <Tag color="blue">Bán hàng tại quầy</Tag>
      </div>
    <Row gutter={18}>
      <Col xs={24} lg={15} className="sale-catalog">
        <Card
          title="Danh sách thuốc"
          extra={
            <AutoComplete
              style={{ width: 380 }}
              value={term}
              onChange={setTerm}
              onSelect={(value) => void addProduct(value)}
              options={(search.data?.items ?? []).map((product) => ({
                value: product.id,
                label: (
                  <Space>
                    <span>{product.name}</span>
                    <Tag>{product.code}</Tag>
                    <Typography.Text type="secondary">
                      {formatVnd(product.currentPrice?.salePrice)} · tồn{" "}
                      {product.stock?.sellable ?? 0}
                    </Typography.Text>
                  </Space>
                ),
              }))}
            >
              <Input.Search prefix={<BarcodeOutlined />} placeholder="Quét mã vạch hoặc nhập tên thuốc, hoạt chất..." allowClear onChange={(event) => { setTerm(event.target.value); setCatalogPage(1); }} onSearch={() => { if (search.data?.items.length === 1) void addProduct(search.data.items[0]!.id); }} />
            </AutoComplete>
          }
        >
          <Segmented
            className="sale-catalog-filter"
            block
            value={catalogFilter}
            onChange={(value) => { setCatalogFilter(value as typeof catalogFilter); setCatalogPage(1); }}
            options={[
              { label: "Tất cả", value: "ALL" },
              { label: "Thuốc kê đơn", value: "RX" },
              { label: "Không kê đơn", value: "OTC" },
              { label: "Thực phẩm chức năng", value: "SUPPLEMENT" },
              { label: "Thiết bị y tế", value: "MEDICAL_DEVICE" },
            ]}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            className="sale-category-filter"
            placeholder="Lọc theo nhóm hàng"
            value={categoryId}
            onChange={(value) => { setCategoryId(value); setCatalogPage(1); }}
            options={(categories.data ?? []).map((item) => ({ value: item.id, label: item.name }))}
          />
          <Table
            className="sale-product-table"
            rowKey="id"
            size="small"
            loading={search.isFetching}
            dataSource={search.data?.items ?? []}
            pagination={{ current: catalogPage, pageSize: 15, total: search.data?.pagination.total ?? 0, showSizeChanger: false, onChange: setCatalogPage, showTotal: (total) => `${total} thuốc` }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không tìm thấy thuốc phù hợp" /> }}
            columns={[
              { title: "STT", width: 52, render: (_: unknown, _product: ProductListItem, index: number) => index + 1 },
              { title: "Tên thuốc", dataIndex: "name", render: (value: string, product: ProductListItem) => <Space direction="vertical" size={0}><Typography.Text strong>{value}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 11 }}>{product.code}</Typography.Text></Space> },
              { title: "Hoạt chất / hàm lượng", width: 170, render: (_: unknown, product: ProductListItem) => <Space direction="vertical" size={0}><Typography.Text ellipsis>{product.ingredients.map((item) => item.name).join(", ") || "—"}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 11 }}>{product.strengthText ?? (product.ingredients.map((item) => item.strengthText).filter(Boolean).join(", ") || product.dosageForm || "—")}</Typography.Text></Space> },
              { title: "Dạng bào chế", dataIndex: "dosageForm", width: 115, ellipsis: true, render: (value: string | null) => value ?? "—" },
              { title: "Tồn kho", width: 82, align: "right", render: (_: unknown, product: ProductListItem) => <Typography.Text className={(product.stock?.sellable ?? 0) > 0 ? "sale-stock" : "sale-stock low"}>{product.stock?.sellable ?? 0}</Typography.Text> },
              { title: "Giá bán", width: 108, align: "right", render: (_: unknown, product: ProductListItem) => <Typography.Text strong>{formatVnd(product.currentPrice?.salePrice)}</Typography.Text> },
              { width: 82, render: (_: unknown, product: ProductListItem) => <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => void addProduct(product.id)}>Thêm</Button> },
            ]}
          />
          <Divider style={{ margin: "18px 0 12px" }}>Đơn bán đang soạn</Divider>
          <div className="sale-cart-on-left">
          <Space direction="vertical" style={{ width: "100%", marginBottom: 12 }}>
            {customer ? (
              <Alert
                type="info"
                showIcon
                message={
                  <Space>
                    <span>
                      Khách: <strong>{customer.fullName ?? "Chưa rõ tên"}</strong>
                      {customer.phone ? ` — ${customer.phone}` : ""}
                    </span>
                    <Button size="small" onClick={() => setCustomer(null)}>
                      Bỏ chọn
                    </Button>
                  </Space>
                }
              />
            ) : (
              <AutoComplete
                style={{ width: "100%" }}
                value={customerSearch}
                onChange={setCustomerSearch}
                options={(customerSearchResults.data ?? []).map((item) => ({
                  value: item.id,
                  label: `${item.fullName ?? "Chưa rõ tên"}${item.phone ? ` — ${item.phone}` : ""}`,
                }))}
                onSelect={(id) => {
                  const found = customerSearchResults.data?.find((item) => item.id === id);
                  if (found) setCustomer(found);
                  setCustomerSearch("");
                }}
              >
                <Input.Search
                  placeholder="Tìm khách quen theo tên hoặc số điện thoại (gõ ≥ 3 ký tự) — để trống nếu là khách lẻ"
                  allowClear
                />
              </AutoComplete>
            )}

            {prescription ? (
              <Alert
                type="info"
                showIcon
                message={
                  <Space>
                    <span>
                      Đơn thuốc <strong>{prescription.code}</strong>
                      {prescription.customer?.fullName ? ` — ${prescription.customer.fullName}` : ""}
                    </span>
                    <Button
                      size="small"
                      onClick={() => {
                        setPrescription(null);
                        setCart((current) => current.map((line) => ({ ...line, prescriptionItemId: null })));
                      }}
                    >
                      Bỏ chọn
                    </Button>
                  </Space>
                }
              />
            ) : (
              <AutoComplete
                style={{ width: "100%" }}
                value={prescriptionSearch}
                onChange={setPrescriptionSearch}
                filterOption={(input, option) =>
                  typeof option?.label === "string" &&
                  option.label.toLowerCase().includes(input.toLowerCase())
                }
                options={(verifiedPrescriptions.data ?? []).map((item) => ({
                  value: item.id,
                  label: `${item.code} — ${item.customer?.fullName ?? "Khách lẻ"}`,
                }))}
                onSelect={async (id) => {
                  const response = await http.get<Envelope<PrescriptionDetail>>(`/prescriptions/${id}`);
                  setPrescription(response.data.data);
                  setPrescriptionSearch("");
                  // Đơn thuốc thường đã gắn sẵn khách — tự điền nếu chưa chọn ai.
                  if (!customer && response.data.data.customer) setCustomer(response.data.data.customer);
                }}
              >
                <Input.Search placeholder="Bán thuốc kê đơn thì chọn đơn thuốc đã xác nhận ở đây" allowClear />
              </AutoComplete>
            )}
          </Space>

          {cart.length === 0 ? (
            <Empty description="Giỏ hàng trống. Tìm sản phẩm ở ô bên trên để thêm." />
          ) : (
            <Table
              dataSource={cart}
              pagination={false}
              size="small"
              columns={[
                {
                  title: "Sản phẩm",
                  render: (_, line: CartLine) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>{line.product.name}</Typography.Text>
                      <Typography.Text type="secondary">{line.product.code}</Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: "Đơn vị",
                  width: 140,
                  render: (_, line: CartLine) => (
                    <Select
                      size="small"
                      style={{ width: "100%" }}
                      value={line.unitId}
                      onChange={(unitId) =>
                        setCart((current) =>
                          current.map((item) =>
                            item.key === line.key ? { ...item, unitId } : item,
                          ),
                        )
                      }
                      options={line.product.units.map((unit) => ({
                        value: unit.id,
                        label: unit.name,
                      }))}
                    />
                  ),
                },
                {
                  title: "SL",
                  width: 90,
                  render: (_, line: CartLine) => (
                    <InputNumber
                      size="small"
                      min={1}
                      value={line.quantity}
                      onChange={(quantity) =>
                        setCart((current) =>
                          current.map((item) =>
                            item.key === line.key ? { ...item, quantity: quantity ?? 1 } : item,
                          ),
                        )
                      }
                      style={{ width: "100%" }}
                    />
                  ),
                },
                {
                  title: "Đơn thuốc",
                  width: 160,
                  render: (_, line: CartLine) => {
                    if (!needsPrescription(line.product.drugClass)) return null;
                    const candidates = matchingPrescriptionItems(line.product.id);
                    if (candidates.length === 0) {
                      return (
                        <Typography.Text type="danger" style={{ fontSize: 12 }}>
                          {prescription ? "Không có trong đơn" : "Cần chọn đơn thuốc"}
                        </Typography.Text>
                      );
                    }
                    return (
                      <Select
                        size="small"
                        style={{ width: "100%" }}
                        placeholder="Chọn dòng trong đơn"
                        value={line.prescriptionItemId ?? undefined}
                        onChange={(prescriptionItemId) =>
                          setCart((current) =>
                            current.map((item) =>
                              item.key === line.key ? { ...item, prescriptionItemId } : item,
                            ),
                          )
                        }
                        options={candidates.map((item) => ({
                          value: item.id,
                          label: `${item.quantity - item.dispensedBaseQuantity} ${item.unitName ?? ""} còn lại`,
                        }))}
                      />
                    );
                  },
                },
                {
                  title: "Đơn giá",
                  width: 120,
                  align: "right",
                  render: (_, line: CartLine) => formatVnd(unitOf(line)?.currentPrice?.salePrice),
                },
                {
                  title: "Thành tiền",
                  width: 130,
                  align: "right",
                  render: (_, line: CartLine) => (
                    <Typography.Text strong>{formatVnd(lineTotal(line))}</Typography.Text>
                  ),
                },
                {
                  width: 40,
                  render: (_, line: CartLine) => (
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() =>
                        setCart((current) => current.filter((item) => item.key !== line.key))
                      }
                    />
                  ),
                },
              ]}
            />
          )}
          </div>
        </Card>

        {cart.length > 0 ? (
          <Card title="Kiểm tra an toàn" style={{ marginTop: 16 }} loading={safety.isFetching}>
            {blocking.length === 0 && warnings.length === 0 ? (
              <Alert type="success" showIcon message="Không phát hiện vấn đề chặn bán" />
            ) : null}

            {blocking.map((item) => (
              <Alert
                key={`${item.code}-${item.productId}`}
                type="error"
                showIcon
                style={{ marginBottom: 8 }}
                message={item.message}
                description={<Tag color="red">{item.code}</Tag>}
              />
            ))}

            {warnings.map((warning) => (
              <Alert
                key={`${warning.code}-${warning.productIds.join(",")}`}
                type="warning"
                showIcon
                icon={<WarningOutlined />}
                style={{ marginBottom: 8 }}
                message={
                  <Space>
                    {warning.message}
                    <Tag color={SEVERITY_COLOR[warning.severity]}>{warning.severity}</Tag>
                  </Space>
                }
                description={
                  warning.requiresAck ? (
                    <Checkbox
                      checked={liveAcked.includes(warning.code)}
                      onChange={(event) =>
                        setAcked((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(warning.code);
                          else next.delete(warning.code);
                          return next;
                        })
                      }
                    >
                      Đã tư vấn khách và chịu trách nhiệm tiếp tục bán
                    </Checkbox>
                  ) : (
                    <Typography.Text type="secondary">
                      Nguồn: {warning.source} ({warning.sourceVersion})
                    </Typography.Text>
                  )
                }
              />
            ))}

            {notChecked.length > 0 ? (
              <Alert
                type="info"
                showIcon
                message="Hệ thống KHÔNG kiểm tra được những mục sau, đừng coi là an toàn"
                description={
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {notChecked.map((item) => (
                      <li key={`${item.productId}-${item.reason}`}>
                        {nameOf(item.productId)}: {NOT_CHECKED_TEXT[item.reason] ?? item.reason}
                      </li>
                    ))}
                  </ul>
                }
              />
            ) : null}
          </Card>
        ) : null}
      </Col>

      <Col xs={24} lg={9} className="sale-checkout">
        <Card title="Đơn bán hiện tại" extra={cart.length > 0 ? <Button danger type="text" size="small" onClick={() => setCart([])}>Xóa tất cả</Button> : null}>
          <Space direction="vertical" style={{ width: "100%" }} size="middle">
            <Space.Compact style={{ width: "100%" }}>
            <AutoComplete
              style={{ width: "100%" }}
              value={customerSearch}
              onChange={setCustomerSearch}
              options={(customerSearchResults.data ?? []).map((item) => ({
                value: item.id,
                label: `${item.fullName ?? "Chưa rõ tên"}${item.phone ? ` — ${item.phone}` : ""}`,
              }))}
              onSelect={(id) => {
                const found = customerSearchResults.data?.find((item) => item.id === id);
                if (found) setCustomer(found);
                setCustomerSearch("");
              }}
            >
              <Input.Search placeholder={customer ? customer.fullName ?? "Khách đã chọn" : "Khách lẻ · tìm tên hoặc số điện thoại"} allowClear onSearch={() => customer && setCustomer(null)} />
            </AutoComplete>
            {can("customer.manage") ? <Button icon={<UserAddOutlined />} onClick={() => setNewCustomerOpen(true)}>Khách mới</Button> : null}
            </Space.Compact>
            {prescription ? <Alert type="info" showIcon message={`Đơn thuốc ${prescription.code}${prescription.customer?.fullName ? ` · ${prescription.customer.fullName}` : ""}`} action={<Button size="small" onClick={() => { setPrescription(null); setCart((current) => current.map((line) => ({ ...line, prescriptionItemId: null }))); }}>Bỏ chọn</Button>} /> : <AutoComplete style={{ width: "100%" }} value={prescriptionSearch} onChange={setPrescriptionSearch} filterOption={(input, option) => typeof option?.label === "string" && option.label.toLowerCase().includes(input.toLowerCase())} options={(verifiedPrescriptions.data ?? []).map((item) => ({ value: item.id, label: `${item.code} — ${item.customer?.fullName ?? "Khách lẻ"}` }))} onSelect={async (id) => { const response = await http.get<Envelope<PrescriptionDetail>>(`/prescriptions/${id}`); setPrescription(response.data.data); setPrescriptionSearch(""); if (!customer && response.data.data.customer) setCustomer(response.data.data.customer); }}><Input.Search placeholder="Chọn đơn thuốc đã xác nhận (nếu có)" allowClear /></AutoComplete>}
            {cart.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có thuốc trong đơn" /> : <Table className="sale-cart-table" rowKey="key" size="small" pagination={false} dataSource={cart} columns={[
              { title: "Tên thuốc", render: (_: unknown, line: CartLine) => <Space direction="vertical" size={3}><Typography.Text strong>{line.product.name}</Typography.Text><Select size="small" value={line.unitId} onChange={(unitId) => setCart((current) => current.map((item) => item.key === line.key ? { ...item, unitId } : item))} options={line.product.units.map((unit) => ({ value: unit.id, label: unit.name }))} />{needsPrescription(line.product.drugClass) ? (() => { const candidates = matchingPrescriptionItems(line.product.id); return candidates.length === 0 ? <Typography.Text type="danger" style={{ fontSize: 11 }}>{prescription ? "Không có trong đơn" : "Cần chọn đơn thuốc"}</Typography.Text> : <Select size="small" value={line.prescriptionItemId ?? undefined} placeholder="Dòng đơn thuốc" onChange={(prescriptionItemId) => setCart((current) => current.map((item) => item.key === line.key ? { ...item, prescriptionItemId } : item))} options={candidates.map((item) => ({ value: item.id, label: `${item.quantity - item.dispensedBaseQuantity} ${item.unitName ?? ""} còn lại` }))} />; })() : null}</Space> },
              { title: "SL", width: 74, render: (_: unknown, line: CartLine) => <InputNumber size="small" min={1} value={line.quantity} onChange={(quantity) => setCart((current) => current.map((item) => item.key === line.key ? { ...item, quantity: quantity ?? 1 } : item))} style={{ width: "100%" }} /> },
              { title: "Thành tiền", width: 100, align: "right", render: (_: unknown, line: CartLine) => <Space direction="vertical" size={2}><Typography.Text strong>{formatVnd(lineTotal(line))}</Typography.Text><Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setCart((current) => current.filter((item) => item.key !== line.key))}>Xóa</Button></Space> },
            ]} />}
            <div>
              <Typography.Text type="secondary">Giảm giá</Typography.Text>
              <Space.Compact style={{ width: "100%", marginTop: 4 }}>
                <Select
                  value={discountType}
                  onChange={setDiscountType}
                  style={{ width: 110 }}
                  options={[
                    { value: "PERCENT", label: "Theo %" },
                    { value: "AMOUNT", label: "Số tiền" },
                  ]}
                />
                <InputNumber
                  style={{ width: "100%" }}
                  min={0}
                  value={discountValue}
                  onChange={(value) => setDiscountValue(value ?? 0)}
                />
              </Space.Compact>
              {discountValue > 0 ? (
                <Input
                  style={{ marginTop: 8 }}
                  placeholder="Lý do giảm giá (bắt buộc)"
                  value={discountReason}
                  onChange={(event) => setDiscountReason(event.target.value)}
                />
              ) : null}
            </div>

            <div>
              <Typography.Text type="secondary">Hình thức thanh toán</Typography.Text>
              <Radio.Group
                style={{ display: "block", marginTop: 4 }}
                value={paymentMethod}
                onChange={(event) => setPaymentMethod(event.target.value as string)}
                options={[
                  { value: "CASH", label: "Tiền mặt" },
                  { value: "BANK_TRANSFER", label: "Chuyển khoản" },
                  { value: "CARD", label: "Thẻ" },
                ]}
              />
            </div>

            <div>
              <Typography.Text type="secondary">Khách đưa</Typography.Text>
              <InputNumber
                style={{ width: "100%", marginTop: 4 }}
                min={0}
                step={1000}
                value={tendered}
                onChange={setTendered}
                placeholder="Để trống nếu không cần tính tiền thừa"
              />
              <div className="sale-quick-tender">
                {[estimatedTotal, 100_000, 200_000, 500_000].filter((value, index, values) => value > 0 && values.indexOf(value) === index).map((value) => <Button key={value} size="small" onClick={() => setTendered(value)}>{formatVnd(value)}</Button>)}
              </div>
            </div>

            <Divider style={{ margin: 0 }} />

            <Row justify="space-between">
              <Typography.Text>Tạm tính</Typography.Text>
              <Typography.Text>{formatVnd(subtotal)}</Typography.Text>
            </Row>
            <Row justify="space-between">
              <Typography.Text>Giảm giá</Typography.Text>
              <Typography.Text>-{formatVnd(estimatedDiscount)}</Typography.Text>
            </Row>
            <Row justify="space-between">
              <Typography.Title level={4} style={{ margin: 0 }}>
                Phải trả
              </Typography.Title>
              <Typography.Title level={4} style={{ margin: 0, color: "#0a7657" }}>
                {formatVnd(estimatedTotal)}
              </Typography.Title>
            </Row>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Số tạm tính. Máy chủ tính lại đơn giá, VAT và tổng tiền khi lập hóa đơn.
            </Typography.Text>

            {missingAck.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={`Còn ${missingAck.length} cảnh báo mức cao chưa ghi nhận`}
              />
            ) : null}

            {needAck.length > 0 && missingAck.length === 0 ? (
              <Input
                placeholder="Ghi chú khi ghi nhận cảnh báo"
                value={ackReason}
                onChange={(event) => setAckReason(event.target.value)}
              />
            ) : null}

            <Button
              type="primary"
              size="large"
              block
              disabled={!canSell}
              loading={checkout.isPending}
              onClick={() => checkout.mutate()}
            >
              Thanh toán · {formatVnd(estimatedTotal)}
            </Button>
            <Checkbox checked={printAfterPayment} onChange={(event) => setPrintAfterPayment(event.target.checked)}>In hóa đơn sau thanh toán</Checkbox>
          </Space>
        </Card>
      </Col>

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
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text type="secondary">Nhập ít nhất họ tên hoặc số điện thoại. Thông tin sức khỏe chỉ được bổ sung khi khách đồng ý.</Typography.Text>
          <Input placeholder="Họ và tên" value={newCustomerName} onChange={(event) => setNewCustomerName(event.target.value)} autoFocus />
          <Input placeholder="Số điện thoại" inputMode="tel" value={newCustomerPhone} onChange={(event) => setNewCustomerPhone(event.target.value)} />
        </Space>
      </Modal>
      <Modal
        open={done !== null}
        onCancel={() => setDone(null)}
        title={`Đã bán — ${done?.code ?? ""}`}
        footer={
          <Space>
            <Button icon={<PrinterOutlined />} onClick={() => void printInvoice(done!.id, "k80")}>
              In hóa đơn
            </Button>
            <Button type="primary" onClick={() => setDone(null)}>
              Đóng
            </Button>
          </Space>
        }
      >
        {done ? (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Row justify="space-between">
              <span>Tạm tính</span>
              <span>{formatVnd(done.subtotal)}</span>
            </Row>
            <Row justify="space-between">
              <span>Giảm giá</span>
              <span>-{formatVnd(done.discountAmount)}</span>
            </Row>
            <Row justify="space-between">
              <span>Trong đó VAT</span>
              <span>{formatVnd(done.vatAmount)}</span>
            </Row>
            <Row justify="space-between">
              <Typography.Text strong>Tổng tiền</Typography.Text>
              <Typography.Text strong>{formatVnd(done.totalAmount)}</Typography.Text>
            </Row>
            {done.changeAmount !== null ? (
              <Row justify="space-between">
                <Typography.Text strong>Tiền thừa trả khách</Typography.Text>
                <Typography.Text strong>{formatVnd(done.changeAmount)}</Typography.Text>
              </Row>
            ) : null}

            <Divider style={{ margin: "8px 0" }} />
            <Typography.Text type="secondary">Lô đã xuất</Typography.Text>
            {done.lines.map((line) =>
              line.allocations.map((allocation) => (
                <Row key={allocation.id} justify="space-between">
                  <span>
                    {line.productName} — lô {allocation.batchNumber}
                  </span>
                  <span>{allocation.baseQuantity}</span>
                </Row>
              )),
            )}
          </Space>
        ) : null}
      </Modal>
    </Row>
    </div>
  );
}
