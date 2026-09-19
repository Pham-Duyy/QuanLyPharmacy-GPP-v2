import {
  BankOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseOutlined,
  CreditCardOutlined,
  DeleteOutlined,
  DollarOutlined,
  EditOutlined,
  FileProtectOutlined,
  FileTextOutlined,
  LoadingOutlined,
  MinusOutlined,
  PlusOutlined,
  PrinterOutlined,
  SafetyCertificateOutlined,
  ShoppingCartOutlined,
  UserAddOutlined,
  UserOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { App, AutoComplete, Button, Checkbox, Dropdown, Input, InputNumber, Modal, Select, Space, Tag, Typography } from "antd";
import type { InputRef } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { getErrorMessage, http } from "../../api/http.js";
import {
  formatVnd,
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
import { formatDateTime } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";
import { ProductThumb } from "../catalog/products/ProductThumb.js";
import { printInvoice } from "../printing/printing.js";
import { MAX_SALE_DRAFTS, readDrafts, writeDrafts, type SaleDraft } from "./pos/drafts.js";
import { PosCatalog } from "./pos/PosCatalog.js";
import { SafetyPanel } from "./pos/SafetyPanel.js";

type CartLine = {
  key: string;
  product: ProductDetail;
  unitId: string;
  quantity: number;
  /** Chỉ có ý nghĩa với thuốc kê đơn: dòng nào của đơn thuốc đang chọn khớp với dòng này. */
  prescriptionItemId: string | null;
};

type Customer = Pick<CustomerSearchItem, "id" | "fullName" | "phone">;

/** Thuốc kê đơn hoặc thuốc kiểm soát đặc biệt đều cần đơn thuốc mới bán được (contract §14.2). */
function needsPrescription(drugClass: string | null): boolean {
  return drugClass === "RX" || drugClass === "CONTROLLED";
}

/** Che bớt số điện thoại khi hiển thị ở quầy (kết quả tìm kiếm đã che sẵn từ máy chủ). */
function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  if (phone.includes("*") || phone.length < 8) return phone;
  return `${phone.slice(0, 3)}***${phone.slice(-4)}`;
}

const vnd = new Intl.NumberFormat("vi-VN");
const money = (value: number) => `${vnd.format(value)} đ`;

const PAYMENT_METHODS = [
  { value: "CASH", label: "Tiền mặt", icon: <DollarOutlined /> },
  { value: "BANK_TRANSFER", label: "Chuyển khoản", icon: <BankOutlined /> },
  { value: "CARD", label: "Thẻ", icon: <CreditCardOutlined /> },
];

/** Mệnh giá gợi ý cho "Khách đưa": đúng số tiền, rồi làm tròn lên các mệnh giá hay gặp. */
function quickTenders(total: number): number[] {
  if (total <= 0) return [];
  const candidates = [total, ...[10_000, 50_000, 100_000, 200_000, 500_000].map((step) => Math.ceil(total / step) * step)];
  return [...new Set(candidates)].filter((value) => value >= total).sort((a, b) => a - b).slice(0, 3);
}

/**
 * Màn hình bán hàng. Giao diện chỉ gửi ý định bán; đơn giá, VAT, lô FEFO và
 * tổng tiền đều do máy chủ tính (contract §14.1), nên phần tổng ở đây chỉ là
 * số tạm tính để người bán ước lượng.
 */
export function SalePage() {
  const { can, storeId } = useAuth();
  const { message, modal } = App.useApp();
  const searchRef = useRef<InputRef>(null);
  const [term, setTerm] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [prescriptionSearch, setPrescriptionSearch] = useState("");
  const [prescription, setPrescription] = useState<PrescriptionDetail | null>(null);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [ackReason, setAckReason] = useState("");
  const [discountType, setDiscountType] = useState<"PERCENT" | "AMOUNT">("AMOUNT");
  const [discountValue, setDiscountValue] = useState(0);
  const [discountReason, setDiscountReason] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [tendered, setTendered] = useState<number | null>(null);
  const [printAfterPayment, setPrintAfterPayment] = useState(true);
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [done, setDone] = useState<Invoice | null>(null);
  // Nháp lưu trên máy theo cửa hàng; đổi cửa hàng thì đọc lại danh sách của cửa hàng mới.
  const [draftCache, setDraftCache] = useState(() => ({ storeId, list: readDrafts(storeId) }));
  const [restoringDraft, setRestoringDraft] = useState(false);
  const customerTerm = useDebounced(customerSearch.trim(), 250);
  const [params, setParams] = useSearchParams();
  const preselectId = params.get("khach");
  const drafts = draftCache.storeId === storeId ? draftCache.list : readDrafts(storeId);

  // Chỉ tìm khi gõ đủ 3 ký tự, khớp đúng quy tắc GET /customers (contract §11).
  const customerSearchResults = useQuery({
    queryKey: ["customer-search", customerTerm],
    enabled: customerTerm.length >= 3,
    queryFn: async () => (await http.get<Envelope<CustomerSearchItem[]>>("/customers", { params: { search: customerTerm } })).data.data,
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
      setCustomer({ id: created.id, fullName: created.fullName, phone: created.phone });
      setNewCustomerOpen(false);
      setNewCustomerName("");
      setNewCustomerPhone("");
      void message.success("Đã tạo và chọn khách hàng cho đơn bán");
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không thể tạo khách hàng")),
  });

  const cartLines = useMemo(() => cart.map((line) => ({ productId: line.product.id, unitId: line.unitId, quantity: line.quantity })), [cart]);

  // Tải một lần rồi lọc theo mã hoặc tên khách ngay trên trình duyệt. Endpoint
  // chỉ lọc được một trạng thái mỗi lần gọi, nên lấy hết rồi tự lọc còn dùng
  // bán tiếp được: VERIFIED hoặc PARTIALLY_DISPENSED (contract §5.4).
  const verifiedPrescriptions = useQuery({
    queryKey: ["usable-prescriptions"],
    enabled: can("prescription.read"),
    queryFn: async () => (await http.get<Envelope<PrescriptionListItem[]>>("/prescriptions")).data.data.filter((item) => item.status === "VERIFIED" || item.status === "PARTIALLY_DISPENSED"),
  });

  const safety = useQuery({
    queryKey: ["safety-check", cartLines, prescription?.id, customer?.id],
    enabled: cart.length > 0,
    queryFn: async () =>
      (
        await http.post<Envelope<SafetyResult>>("/sales/safety-check", {
          lines: cartLines,
          prescriptionId: prescription?.id ?? null,
          customerId: customer?.id ?? null,
        })
      ).data.data,
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
    payment: { method: paymentMethod, amountTendered: paymentMethod === "CASH" ? tendered : null },
  };

  /**
   * Khóa idempotency gắn với đúng một nội dung giỏ hàng: bấm lại sau khi mạng
   * lỗi thì dùng lại khóa cũ nên không bán hai lần, còn sửa giỏ hàng thì sinh
   * khóa mới để máy chủ không báo trùng khóa với nội dung khác (contract §2.3).
   */
  const attempt = useRef<{ signature: string; key: string }>({ signature: "", key: "" });

  function resetSale() {
    setCart([]);
    setCustomer(null);
    setCustomerSearch("");
    setPrescription(null);
    setAcked(new Set());
    setAckReason("");
    setDiscountValue(0);
    setDiscountReason("");
    setTendered(null);
    setPaymentMethod("CASH");
  }

  const checkout = useMutation({
    mutationFn: async () => {
      const signature = JSON.stringify(body);
      if (attempt.current.signature !== signature) {
        attempt.current = { signature, key: crypto.randomUUID() };
      }
      const response = await http.post<Envelope<Invoice>>("/invoices", body, { headers: { "Idempotency-Key": attempt.current.key } });
      return response.data.data;
    },
    onSuccess: (invoice) => {
      if (printAfterPayment) void printInvoice(invoice.id, message);
      setDone(invoice);
      resetSale();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không bán được")),
  });

  /** Dòng đơn thuốc còn khớp được với một sản phẩm: đúng thuốc, chưa bán hết theo đơn. */
  function matchingPrescriptionItems(productId: string, source = prescription) {
    return (source?.items ?? []).filter((item) => item.productId === productId && (item.baseQuantity ?? 0) > item.dispensedBaseQuantity);
  }

  /**
   * Thêm sản phẩm vào đơn. `unitId` là đơn vị người bán chọn ở danh sách;
   * `scannedCode` là mã vạch vừa quét (quét mã hộp thì thêm một hộp).
   */
  async function addProduct(productId: string, options: { unitId?: string; scannedCode?: string } = {}) {
    try {
      const product = (await http.get<Envelope<ProductDetail>>(`/products/${productId}`)).data.data;
      const unit =
        (options.unitId ? product.units.find((item) => item.id === options.unitId) : undefined) ??
        (options.scannedCode ? product.units.find((item) => item.barcodes?.includes(options.scannedCode!)) : undefined) ??
        product.units.find((item) => item.isDefaultSaleUnit) ??
        product.units.find((item) => item.conversionToBase === 1) ??
        product.units[0];
      if (!unit) {
        void message.error("Sản phẩm chưa có đơn vị tính");
        return;
      }

      // Thuốc kê đơn thì thử khớp sẵn vào đơn đang chọn nếu chỉ có đúng một dòng phù hợp.
      const candidates = needsPrescription(product.drugClass) ? matchingPrescriptionItems(product.id) : [];
      const prescriptionItemId = candidates.length === 1 ? candidates[0]!.id : null;

      setCart((current) => {
        const found = current.find((line) => line.product.id === product.id && line.unitId === unit.id);
        if (found) return current.map((line) => (line.key === found.key ? { ...line, quantity: line.quantity + 1 } : line));
        return [...current, { key: `${product.id}:${unit.id}:${Date.now()}`, product, unitId: unit.id, quantity: 1, prescriptionItemId }];
      });
      setTerm("");
      searchRef.current?.focus();
    } catch (error) {
      void message.error(getErrorMessage(error, "Không thêm được sản phẩm"));
    }
  }

  /**
   * Enter trong ô tìm khi chưa chọn dòng: máy quét mã vạch gõ rất nhanh rồi
   * Enter, nên tra thẳng API với chuỗi hiện tại thay vì dựa vào danh sách.
   */
  async function handleScanEnter() {
    const value = term.trim();
    if (!value) return;
    try {
      const items = (await http.get<Envelope<Paged<ProductListItem>>>("/products", { params: { search: value, page: 1, limit: 2 } })).data.data.items;
      if (items.length === 1) await addProduct(items[0]!.id, { scannedCode: value });
      else if (items.length === 0) void message.warning(`Không tìm thấy sản phẩm khớp “${value}”`);
      else void message.info("Có nhiều sản phẩm khớp — dùng phím ↑ ↓ để chọn rồi Enter");
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
  const estimatedDiscount = discountValue <= 0 ? 0 : discountType === "PERCENT" ? Math.floor((subtotal * discountValue) / 100) : Math.min(discountValue, subtotal);
  const estimatedTotal = subtotal - estimatedDiscount;
  const cash = paymentMethod === "CASH";
  const shortfall = cash && tendered !== null && cart.length > 0 && tendered < estimatedTotal ? estimatedTotal - tendered : null;
  const estimatedChange = cash && tendered !== null && tendered >= estimatedTotal && cart.length > 0 ? tendered - estimatedTotal : null;

  const needAck = warnings.filter((warning) => warning.requiresAck);
  const missingAck = needAck.filter((warning) => !liveAcked.includes(warning.code));
  const canSell = cart.length > 0 && blocking.length === 0 && missingAck.length === 0 && !safety.isFetching;

  const nameOf = (productId: string) => cart.find((line) => line.product.id === productId)?.product.name ?? productId;

  // Mở từ màn Khách hàng ("Tạo đơn bán cho khách"): chọn sẵn khách rồi bỏ tham số khỏi URL.
  useEffect(() => {
    if (!preselectId) return;
    let cancelled = false;
    http
      .get<Envelope<CustomerDetail>>(`/customers/${preselectId}`)
      .then((response) => {
        if (cancelled) return;
        const found = response.data.data;
        if (!found.isAnonymized) setCustomer({ id: found.id, fullName: found.fullName, phone: found.phone });
      })
      .catch((error: unknown) => {
        if (!cancelled) void message.error(getErrorMessage(error, "Không mở được khách hàng"));
      })
      .finally(() => {
        if (!cancelled) {
          setParams(
            (current) => {
              const next = new URLSearchParams(current);
              next.delete("khach");
              return next;
            },
            { replace: true },
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [preselectId, message, setParams]);

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

  function confirmClear() {
    if (cart.length === 0 && !customer && !prescription) return;
    modal.confirm({
      title: "Xóa đơn đang bán?",
      content: "Toàn bộ thuốc, khách hàng và đơn thuốc đã chọn sẽ bị bỏ. Chưa có gì được ghi vào hệ thống.",
      okText: "Xóa đơn",
      okButtonProps: { danger: true },
      cancelText: "Giữ lại",
      onOk: () => {
        resetSale();
        searchRef.current?.focus();
      },
    });
  }

  function saveDraft() {
    if (!storeId || cart.length === 0) return;
    const draft: SaleDraft = {
      id: crypto.randomUUID(),
      savedAt: new Date().toISOString(),
      customer,
      prescriptionId: prescription?.id ?? null,
      lines: cart.map((line) => ({ productId: line.product.id, productName: line.product.name, unitId: line.unitId, quantity: line.quantity })),
      discount: { type: discountType, value: discountValue, reason: discountReason },
    };
    try {
      setDraftCache({ storeId, list: writeDrafts(storeId, [draft, ...drafts]) });
      resetSale();
      void message.success(drafts.length >= MAX_SALE_DRAFTS ? `Đã lưu nháp; chỉ giữ ${MAX_SALE_DRAFTS} đơn nháp gần nhất` : "Đã lưu nháp — mở lại ở mục Đơn nháp");
      searchRef.current?.focus();
    } catch {
      void message.error("Trình duyệt không cho lưu nháp trên máy này");
    }
  }

  function removeDraft(id: string) {
    if (!storeId) return;
    try {
      setDraftCache({ storeId, list: writeDrafts(storeId, drafts.filter((item) => item.id !== id)) });
    } catch {
      // Không xóa được thì danh sách giữ nguyên.
    }
  }

  /** Mở lại đơn nháp: tải lại sản phẩm để giá, đơn vị và tồn là số hiện hành. */
  async function openDraft(draft: SaleDraft) {
    setRestoringDraft(true);
    try {
      const products = await Promise.all(draft.lines.map((line) => http.get<Envelope<ProductDetail>>(`/products/${line.productId}`).then((response) => response.data.data)));
      const restoredPrescription = draft.prescriptionId ? (await http.get<Envelope<PrescriptionDetail>>(`/prescriptions/${draft.prescriptionId}`)).data.data : null;
      const lines: CartLine[] = [];
      const skipped: string[] = [];
      draft.lines.forEach((line, index) => {
        const product = products[index]!;
        const unit = product.units.find((item) => item.id === line.unitId && item.isActive !== false);
        if (!unit || !product.isActive) {
          skipped.push(line.productName);
          return;
        }
        const candidates = needsPrescription(product.drugClass) ? matchingPrescriptionItems(product.id, restoredPrescription) : [];
        lines.push({ key: `${product.id}:${unit.id}:${Date.now()}:${index}`, product, unitId: unit.id, quantity: line.quantity, prescriptionItemId: candidates.length === 1 ? candidates[0]!.id : null });
      });
      resetSale();
      setCart(lines);
      setCustomer(draft.customer);
      setPrescription(restoredPrescription && (restoredPrescription.status === "VERIFIED" || restoredPrescription.status === "PARTIALLY_DISPENSED") ? restoredPrescription : null);
      setDiscountType(draft.discount.type);
      setDiscountValue(draft.discount.value);
      setDiscountReason(draft.discount.reason);
      removeDraft(draft.id);
      if (skipped.length > 0) void message.warning(`Bỏ qua sản phẩm không còn bán: ${skipped.join(", ")}`);
      else void message.success("Đã mở lại đơn nháp");
    } catch (error) {
      void message.error(getErrorMessage(error, "Không mở lại được đơn nháp"));
    } finally {
      setRestoringDraft(false);
    }
  }

  function requestOpenDraft(draft: SaleDraft) {
    if (cart.length === 0) {
      void openDraft(draft);
      return;
    }
    modal.confirm({
      title: "Thay đơn đang bán bằng đơn nháp?",
      content: "Đơn đang bán sẽ bị bỏ. Muốn giữ lại, hãy bấm “Lưu nháp” trước.",
      okText: "Mở đơn nháp",
      cancelText: "Không",
      onOk: () => openDraft(draft),
    });
  }

  const safetyStatus = cart.length === 0 ? null : safety.isFetching ? (
    <span className="pos-status">
      <LoadingOutlined /> Đang kiểm tra an toàn
    </span>
  ) : safety.isError ? (
    <span className="pos-status is-danger">
      <WarningFilled /> Chưa kiểm tra được
    </span>
  ) : blocking.length > 0 ? (
    <span className="pos-status is-danger">
      <WarningFilled /> Có vấn đề chặn bán
    </span>
  ) : missingAck.length > 0 ? (
    <span className="pos-status is-warning">
      <ClockCircleOutlined /> Cần ghi nhận {missingAck.length} cảnh báo
    </span>
  ) : (
    <span className="pos-status is-ok">
      <SafetyCertificateOutlined /> Đã kiểm tra an toàn
    </span>
  );

  const discountLimitedByRole = !can("sale.discount");

  return (
    <div className="sale-page">
      <PageHeader
        icon={<ShoppingCartOutlined />}
        title="Bán thuốc"
        description="Tìm thuốc, kiểm tra đơn và thanh toán"
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
        <PosCatalog term={term} onTermChange={setTerm} searchRef={searchRef} onScanEnter={() => void handleScanEnter()} onAdd={(productId, unitId) => void addProduct(productId, { unitId })} />

        <section className="pos-panel pos-checkout-panel" aria-label="Đơn bán hiện tại">
          <div className="pos-checkout-head">
            <h2>Đơn bán hiện tại</h2>
            <Tag color="blue" variant="filled">
              Đơn mới
            </Tag>
            <span className="pos-head-actions">
              {drafts.length > 0 ? (
                <Dropdown
                  trigger={["click"]}
                  placement="bottomRight"
                  menu={{
                    items: drafts.map((draft) => ({
                      key: draft.id,
                      label: (
                        <span className="pos-draft-item">
                          <strong>{draft.customer?.fullName ?? "Khách lẻ"}</strong>
                          <small>
                            {draft.lines.length} sản phẩm · {formatDateTime(draft.savedAt)}
                          </small>
                        </span>
                      ),
                      extra: (
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          aria-label="Xóa đơn nháp"
                          onClick={(event) => {
                            event.stopPropagation();
                            removeDraft(draft.id);
                          }}
                        />
                      ),
                    })),
                    onClick: ({ key }) => {
                      const draft = drafts.find((item) => item.id === key);
                      if (draft) requestOpenDraft(draft);
                    },
                  }}
                >
                  <Button type="text" icon={<FileTextOutlined />} loading={restoringDraft}>
                    Đơn nháp ({drafts.length})
                  </Button>
                </Dropdown>
              ) : null}
              <Button type="text" danger icon={<DeleteOutlined />} disabled={cart.length === 0 && !customer && !prescription} onClick={confirmClear}>
                Xóa đơn
              </Button>
            </span>
          </div>

          <div className="pos-attach">
            <div className="pos-attach-row">
              {customer ? (
                <div className="pos-field">
                  <UserOutlined />
                  <strong>{customer.fullName ?? "Khách chưa có tên"}</strong>
                  <span className="muted">{maskPhone(customer.phone) ?? "Không có SĐT"}</span>
                  <Button type="text" size="small" icon={<EditOutlined />} aria-label="Đổi khách hàng" onClick={() => setCustomer(null)} />
                </div>
              ) : (
                <AutoComplete
                  className="pos-field-input"
                  value={customerSearch}
                  onChange={setCustomerSearch}
                  options={(customerSearchResults.data ?? []).map((item) => ({ value: item.id, label: `${item.fullName ?? "Chưa rõ tên"}${item.phone ? ` · ${item.phone}` : ""}` }))}
                  onSelect={(id) => {
                    const found = customerSearchResults.data?.find((item) => item.id === id);
                    if (found) setCustomer(found);
                    setCustomerSearch("");
                  }}
                  notFoundContent={customerTerm.length >= 3 && !customerSearchResults.isFetching ? "Không tìm thấy khách" : null}
                >
                  <Input prefix={<UserOutlined />} placeholder="Khách lẻ · tìm tên hoặc SĐT (≥ 3 ký tự)" allowClear aria-label="Tìm khách hàng" />
                </AutoComplete>
              )}
              {can("customer.manage") ? (
                <Button icon={<UserAddOutlined />} onClick={() => setNewCustomerOpen(true)}>
                  Thêm khách hàng
                </Button>
              ) : null}
            </div>

            {prescription ? (
              <div className="pos-field pos-field-rx">
                <FileProtectOutlined />
                <span>
                  Đơn thuốc: <strong>{prescription.code}</strong>
                </span>
                <span className="muted">{prescription.customer?.fullName ?? "Khách lẻ"}</span>
                <Button type="text" size="small" icon={<CloseOutlined />} aria-label="Bỏ đơn thuốc" onClick={clearPrescription} />
              </div>
            ) : can("prescription.read") ? (
              <AutoComplete
                className="pos-field-input"
                value={prescriptionSearch}
                onChange={setPrescriptionSearch}
                filterOption={(input, option) => typeof option?.label === "string" && option.label.toLowerCase().includes(input.toLowerCase())}
                options={(verifiedPrescriptions.data ?? []).map((item) => ({ value: item.id, label: `${item.code} — ${item.customer?.fullName ?? "Khách lẻ"}` }))}
                notFoundContent={verifiedPrescriptions.data?.length === 0 ? "Chưa có đơn thuốc đã xác nhận" : null}
                onSelect={async (id) => {
                  try {
                    const detail = (await http.get<Envelope<PrescriptionDetail>>(`/prescriptions/${id}`)).data.data;
                    setPrescription(detail);
                    setPrescriptionSearch("");
                    // Đơn thuốc thường đã gắn sẵn khách — tự điền nếu chưa chọn ai.
                    if (!customer && detail.customer) setCustomer(detail.customer);
                  } catch (error) {
                    void message.error(getErrorMessage(error, "Không mở được đơn thuốc"));
                  }
                }}
              >
                <Input prefix={<FileProtectOutlined />} placeholder="Đơn thuốc: Chưa đính kèm — chọn đơn đã xác nhận" allowClear aria-label="Chọn đơn thuốc" />
              </AutoComplete>
            ) : null}
          </div>

          <div className="pos-cart">
            {cart.length === 0 ? (
              <div className="pos-cart-empty">
                <ShoppingCartOutlined />
                <strong>Chưa có thuốc trong đơn</strong>
                <span>Quét mã vạch hoặc bấm “Thêm” ở danh sách bên trái.</span>
              </div>
            ) : (
              <>
                <div className="pos-cart-head" aria-hidden>
                  <span>Thuốc / Đơn vị</span>
                  <span>Số lượng</span>
                  <span className="col-num">Thành tiền</span>
                  <span />
                </div>
                {cart.map((line) => {
                  const unit = unitOf(line);
                  const rx = needsPrescription(line.product.drugClass);
                  const candidates = rx ? matchingPrescriptionItems(line.product.id) : [];
                  const price = unit?.currentPrice?.salePrice;
                  return (
                    <div className="pos-cart-line" key={line.key}>
                      <div className="pos-cart-product">
                        <ProductThumb src={line.product.images?.[0]?.thumbUrl} alt={line.product.name} size={44} />
                        <div className="pos-cart-text">
                          <strong>{line.product.name}</strong>
                          <span className="pos-cart-unit">
                            <Select
                              size="small"
                              variant="borderless"
                              value={line.unitId}
                              aria-label={`Đơn vị ${line.product.name}`}
                              onChange={(unitId) => updateLine(line.key, { unitId })}
                              options={line.product.units.filter((item) => item.isSellable !== false && item.isActive !== false).map((item) => ({ value: item.id, label: item.name }))}
                              popupMatchSelectWidth={false}
                            />
                            <span className="muted">· {price === null || price === undefined ? "Chưa đặt giá" : money(price)}</span>
                          </span>
                          {rx ? (
                            candidates.length === 0 ? (
                              <Typography.Text type="danger" className="pos-cart-rx">
                                <WarningFilled /> {prescription ? "Không có trong đơn thuốc" : "Cần chọn đơn thuốc"}
                              </Typography.Text>
                            ) : (
                              <Select
                                size="small"
                                className="pos-cart-rx"
                                value={line.prescriptionItemId ?? undefined}
                                placeholder="Chọn dòng đơn thuốc"
                                onChange={(prescriptionItemId) => updateLine(line.key, { prescriptionItemId })}
                                options={candidates.map((item) => ({ value: item.id, label: `${item.quantity - item.dispensedBaseQuantity} ${item.unitName ?? ""} còn lại theo đơn` }))}
                              />
                            )
                          ) : null}
                        </div>
                      </div>
                      <div className="pos-qty">
                        <Button icon={<MinusOutlined />} aria-label={`Giảm số lượng ${line.product.name}`} disabled={line.quantity <= 1} onClick={() => updateLine(line.key, { quantity: Math.max(1, line.quantity - 1) })} />
                        <InputNumber min={1} precision={0} controls={false} value={line.quantity} onChange={(quantity) => updateLine(line.key, { quantity: quantity ?? 1 })} aria-label={`Số lượng ${line.product.name}`} />
                        <Button icon={<PlusOutlined />} aria-label={`Tăng số lượng ${line.product.name}`} onClick={() => updateLine(line.key, { quantity: line.quantity + 1 })} />
                      </div>
                      <strong className="col-num pos-cart-total">{money(lineTotal(line))}</strong>
                      <Button type="text" danger icon={<DeleteOutlined />} aria-label={`Xóa ${line.product.name} khỏi đơn`} onClick={() => setCart((current) => current.filter((item) => item.key !== line.key))} />
                    </div>
                  );
                })}
              </>
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

          <div className="pos-summary">
            <div className="pos-summary-row">
              <span>Tạm tính</span>
              <strong>{money(subtotal)}</strong>
            </div>
            <div className="pos-summary-row pos-discount">
              <span>Giảm giá</span>
              <Space.Compact>
                <Select
                  value={discountType}
                  onChange={setDiscountType}
                  aria-label="Kiểu giảm giá"
                  options={[
                    { value: "AMOUNT", label: "đ" },
                    { value: "PERCENT", label: "%" },
                  ]}
                  disabled={discountLimitedByRole}
                />
                <InputNumber<number>
                  min={0}
                  max={discountType === "PERCENT" ? 100 : undefined}
                  value={discountValue}
                  onChange={(value) => setDiscountValue(value ?? 0)}
                  formatter={(value) => (value ? Number(value).toLocaleString("vi-VN") : "0")}
                  parser={(value) => Number((value ?? "").replace(/\D/g, ""))}
                  aria-label="Mức giảm giá"
                  disabled={discountLimitedByRole}
                />
              </Space.Compact>
            </div>
            {discountValue > 0 ? <Input placeholder="Lý do giảm giá (bắt buộc)" value={discountReason} onChange={(event) => setDiscountReason(event.target.value)} aria-label="Lý do giảm giá" /> : null}
            {estimatedDiscount > 0 ? (
              <div className="pos-summary-row muted">
                <span>Giảm tạm tính</span>
                <span>−{money(estimatedDiscount)}</span>
              </div>
            ) : null}
            <div className="pos-due">
              <span>Khách phải trả</span>
              <strong>{money(estimatedTotal)}</strong>
            </div>
          </div>

          <div className="pos-pay-methods" role="radiogroup" aria-label="Hình thức thanh toán">
            {PAYMENT_METHODS.map((method) => (
              <button
                key={method.value}
                type="button"
                role="radio"
                aria-checked={paymentMethod === method.value}
                className={paymentMethod === method.value ? "pos-pay-method is-active" : "pos-pay-method"}
                onClick={() => setPaymentMethod(method.value)}
              >
                {method.icon} {method.label}
              </button>
            ))}
          </div>

          {cash ? (
            <div className="pos-tender">
              <div className="pos-summary-row">
                <span>Khách đưa</span>
                <InputNumber<number>
                  className="pos-tender-input"
                  min={0}
                  step={1000}
                  value={tendered}
                  onChange={setTendered}
                  suffix="đ"
                  placeholder="Để trống nếu không cần tiền thừa"
                  formatter={(value) => (value ? Number(value).toLocaleString("vi-VN") : "")}
                  parser={(value) => Number((value ?? "").replace(/\D/g, ""))}
                  aria-label="Khách đưa"
                />
              </div>
              {quickTenders(estimatedTotal).length > 0 ? (
                <div className="pos-quick-tender">
                  {quickTenders(estimatedTotal).map((value) => (
                    <button key={value} type="button" className={tendered === value ? "is-active" : undefined} onClick={() => setTendered(value)}>
                      {money(value)}
                    </button>
                  ))}
                </div>
              ) : null}
              {estimatedChange !== null ? (
                <div className="pos-summary-row pos-change">
                  <span>Tiền thừa</span>
                  <strong>{money(estimatedChange)}</strong>
                </div>
              ) : shortfall !== null ? (
                <div className="pos-summary-row pos-shortfall">
                  <span>Còn thiếu</span>
                  <strong>{money(shortfall)}</strong>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="pos-status-row">
            <Checkbox checked={printAfterPayment} onChange={(event) => setPrintAfterPayment(event.target.checked)}>
              In hóa đơn
            </Checkbox>
            {safetyStatus}
          </div>
          {cart.length > 0 && !canSell && !safety.isFetching ? (
            <p className="pos-blocked">
              <WarningFilled /> {blocking.length > 0 ? "Còn vấn đề chặn bán, xem mục Kiểm tra an toàn." : `Còn ${missingAck.length} cảnh báo cần ghi nhận trước khi bán.`}
            </p>
          ) : null}
          <p className="pos-note">Số tạm tính. Máy chủ tính lại đơn giá, VAT và tổng tiền khi lập hóa đơn.</p>

          <div className="pos-actions">
            <Button size="large" icon={<FileTextOutlined />} disabled={cart.length === 0 || !storeId} onClick={saveDraft}>
              Lưu nháp
            </Button>
            <Button type="primary" size="large" className="pos-pay" disabled={!canSell} loading={checkout.isPending} onClick={() => checkout.mutate()}>
              {!checkout.isPending ? <CreditCardOutlined /> : null} Thanh toán · {money(estimatedTotal)} <kbd>F9</kbd>
            </Button>
          </div>
        </section>
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
