import { DeleteOutlined, WarningOutlined } from "@ant-design/icons";
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
  type Envelope,
  type Invoice,
  type Paged,
  type ProductDetail,
  type ProductListItem,
  type SafetyResult,
} from "../../api/types.js";

type CartLine = {
  key: string;
  product: ProductDetail;
  unitId: string;
  quantity: number;
};

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
  const [term, setTerm] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [ackReason, setAckReason] = useState("");
  const [discountType, setDiscountType] = useState<"PERCENT" | "AMOUNT">("PERCENT");
  const [discountValue, setDiscountValue] = useState(0);
  const [discountReason, setDiscountReason] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [tendered, setTendered] = useState<number | null>(null);
  const [done, setDone] = useState<Invoice | null>(null);

  const search = useQuery({
    queryKey: ["products", term],
    queryFn: async () => {
      const response = await http.get<Envelope<Paged<ProductListItem>>>("/products", {
        params: { search: term || undefined, limit: 15 },
      });
      return response.data.data.items;
    },
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

  const safety = useQuery({
    queryKey: ["safety-check", cartLines],
    enabled: cart.length > 0,
    queryFn: async () => {
      const response = await http.post<Envelope<SafetyResult>>("/sales/safety-check", {
        lines: cartLines,
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
    lines: cartLines,
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
      setDone(invoice);
      setCart([]);
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
        { key: `${product.id}:${unit.id}:${Date.now()}`, product, unitId: unit.id, quantity: 1 },
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
    <Row gutter={16}>
      <Col xs={24} lg={15}>
        <Card
          title="Bán hàng"
          extra={
            <AutoComplete
              style={{ width: 380 }}
              value={term}
              onChange={setTerm}
              onSelect={(value) => void addProduct(value)}
              options={(search.data ?? []).map((product) => ({
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
              <Input.Search placeholder="Tìm theo tên, mã, hoạt chất rồi chọn để thêm" allowClear />
            </AutoComplete>
          }
        >
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

      <Col xs={24} lg={9}>
        <Card title="Thanh toán">
          <Space direction="vertical" style={{ width: "100%" }} size="middle">
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
              Thanh toán
            </Button>
          </Space>
        </Card>
      </Col>

      <Modal
        open={done !== null}
        onCancel={() => setDone(null)}
        onOk={() => setDone(null)}
        okText="Đóng"
        cancelButtonProps={{ style: { display: "none" } }}
        title={`Đã bán — ${done?.code ?? ""}`}
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
  );
}
