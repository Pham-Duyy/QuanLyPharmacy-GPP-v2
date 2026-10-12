import {
  BarcodeOutlined,
  CreditCardOutlined,
  DeleteOutlined,
  FileTextOutlined,
  ShoppingCartOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Checkbox, Tag } from "antd";
import type { InputRef } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { getCommittedResource, getErrorMessage, http } from "../../api/http.js";
import { useSubmitKey } from "../../api/submit-key.js";
import type {
  CustomerDetail,
  Envelope,
  Invoice,
  Paged,
  PrescriptionDetail,
  ProductDetail,
  ProductListItem,
  SafetyResult,
} from "../../api/types.js";
import { formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useAuth } from "../auth/auth-context.js";
import {
  maxRedeemablePoints,
  useCustomerLoyalty,
  useLoyaltySettings,
} from "../loyalty/loyalty-api.js";
import { importEPrescription } from "../prescriptions/eprescription-api.js";
import { CameraScanButton } from "../scanning/CameraScan.js";
import { productCodeFromScan } from "../scanning/scan-codes.js";
import { printDocument, printInvoice, printUrl } from "../printing/printing.js";
import { cashShiftKeys } from "./cash-shift-api.js";
import { CashShiftBar } from "./CashShiftBar.js";
import { MAX_SALE_DRAFTS, readDrafts, writeDrafts, type SaleDraft } from "./pos/drafts.js";
import { PosCatalog } from "./pos/PosCatalog.js";
import { prescriptionCartLines, productsToFetch } from "./pos/prescription-cart.js";
import { applyScan, pendingPicks, scanConfirmsLine } from "./pos/scan-confirm.js";
import { ControlledBuyerCard, type ControlledBuyer } from "./pos/ControlledBuyerCard.js";
import { SafetyPanel, SafetyStatus } from "./pos/SafetyPanel.js";
import { NewCustomerModal } from "./pos/NewCustomerModal.js";
import { PosCartLines } from "./pos/PosCartLines.js";
import { PosCustomerRow } from "./pos/PosCustomerRow.js";
import { PosDiscount } from "./pos/PosDiscount.js";
import { PosDraftsMenu } from "./pos/PosDraftsMenu.js";
import { PosLoyaltyBox } from "./pos/PosLoyaltyBox.js";
import { PosPrescriptionField } from "./pos/PosPrescriptionField.js";
import { PosTender } from "./pos/PosTender.js";
import { SaleDoneModal } from "./pos/SaleDoneModal.js";
import {
  type CartLine,
  type Customer,
  lineTotal,
  matchingPrescriptionItems,
  money,
  needsPrescription,
  usageOf,
} from "./pos/sale-cart.js";
/**
 * Màn hình bán hàng. Giao diện chỉ gửi ý định bán; đơn giá, VAT, lô FEFO và
 * tổng tiền đều do máy chủ tính (contract §14.1), nên phần tổng ở đây chỉ là
 * số tạm tính để người bán ước lượng.
 */
export function SalePage() {
  const { can, storeId } = useAuth();
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const searchRef = useRef<InputRef>(null);
  const [term, setTerm] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [prescriptionSearch, setPrescriptionSearch] = useState("");
  const [prescription, setPrescription] = useState<PrescriptionDetail | null>(null);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [controlledBuyer, setControlledBuyer] = useState<ControlledBuyer | null>(null);
  const [ackReason, setAckReason] = useState("");
  const [discountType, setDiscountType] = useState<"PERCENT" | "AMOUNT">("AMOUNT");
  const [discountValue, setDiscountValue] = useState(0);
  const [discountReason, setDiscountReason] = useState("");
  const [redeemPoints, setRedeemPoints] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [tendered, setTendered] = useState<number | null>(null);
  const [printAfterPayment, setPrintAfterPayment] = useState(true);
  const [printLabels, setPrintLabels] = useState(true);
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  const [done, setDone] = useState<Invoice | null>(null);
  // Nháp lưu trên máy theo cửa hàng; đổi cửa hàng thì đọc lại danh sách của cửa hàng mới.
  const [draftCache, setDraftCache] = useState(() => ({ storeId, list: readDrafts(storeId) }));
  const [restoringDraft, setRestoringDraft] = useState(false);
  const [params, setParams] = useSearchParams();
  const preselectId = params.get("khach");
  const drafts = draftCache.storeId === storeId ? draftCache.list : readDrafts(storeId);

  const loyaltyQuery = useLoyaltySettings();
  const loyaltyProgram = loyaltyQuery.data?.settings;
  const customerLoyalty = useCustomerLoyalty(
    customer?.id ?? null,
    Boolean(loyaltyProgram?.enabled),
  );

  const cartLines = useMemo(
    () =>
      cart.map((line) => ({
        productId: line.product.id,
        unitId: line.unitId,
        quantity: line.quantity,
      })),
    [cart],
  );

  // Thuốc kiểm soát đặc biệt: phải ghi người mua vào sổ theo dõi trước khi bán.
  const controlledLines = cart.filter((line) => line.product.drugClass === "CONTROLLED");
  const hasControlledBuyer = Boolean(controlledBuyer);

  // Số thuốc trong đơn thuốc đang gắn còn bán được mà giỏ chưa có.
  const prescriptionPending = prescription
    ? productsToFetch(prescription.items, new Set(cart.map((line) => line.product.id))).length
    : 0;

  // Quét xác nhận: chỉ hiện trạng thái khi đơn này đã có lần quét, quầy không
  // dùng máy quét thì giao diện giữ nguyên như cũ.
  const scanning = cart.some((line) => line.scanned > 0);
  const unscanned = scanning ? cart.filter((line) => line.scanned === 0).length : 0;

  const safety = useQuery({
    queryKey: ["safety-check", cartLines, prescription?.id, customer?.id, hasControlledBuyer],
    enabled: cart.length > 0,
    queryFn: async () =>
      (
        await http.post<Envelope<SafetyResult>>("/sales/safety-check", {
          lines: cartLines,
          prescriptionId: prescription?.id ?? null,
          customerId: customer?.id ?? null,
          hasControlledBuyer,
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

  // Đổi điểm: chỉ tính trên nhóm hàng được tích điểm (mặc định không gồm
  // thuốc), số điểm đổi tối đa do trần phần trăm của chương trình quyết định.
  const pointsAvailable = customerLoyalty.data?.balance.available ?? 0;
  const loyaltyEligibleSubtotal = loyaltyProgram
    ? cart.reduce(
        (sum, line) =>
          loyaltyProgram.earnOnDrugs || line.product.productType !== "DRUG"
            ? sum + lineTotal(line)
            : sum,
        0,
      )
    : 0;
  const maxRedeem =
    loyaltyProgram && customer
      ? maxRedeemablePoints(loyaltyProgram, loyaltyEligibleSubtotal, pointsAvailable)
      : 0;
  const canRedeem =
    Boolean(loyaltyProgram?.enabled) && maxRedeem >= (loyaltyProgram?.minRedeemPoints ?? 0);
  const appliedRedeem =
    canRedeem && loyaltyProgram && redeemPoints >= loyaltyProgram.minRedeemPoints
      ? Math.min(redeemPoints, maxRedeem)
      : 0;
  const loyaltyDiscount = appliedRedeem * (loyaltyProgram?.pointValue ?? 0);

  const body = {
    customerId: customer?.id ?? null,
    controlledBuyer: controlledLines.length > 0 ? controlledBuyer : null,
    prescriptionId: prescription?.id ?? null,
    lines: cart.map((line) => ({
      productId: line.product.id,
      unitId: line.unitId,
      quantity: line.quantity,
      prescriptionItemId: line.prescriptionItemId,
      usageInstruction: usageOf(line, prescription) || null,
    })),
    discount:
      discountValue > 0
        ? { type: discountType, value: discountValue, reason: discountReason || "Giảm giá" }
        : null,
    loyaltyRedeemPoints: appliedRedeem,
    acknowledgedWarnings: liveAcked.map((code) => ({
      code,
      productIds: [],
      reason: ackReason || null,
    })),
    payment: { method: paymentMethod, amountTendered: paymentMethod === "CASH" ? tendered : null },
  };

  /**
   * Khóa idempotency gắn với đúng một nội dung giỏ hàng: bấm lại sau khi mạng
   * lỗi thì dùng lại khóa cũ nên không bán hai lần, còn sửa giỏ hàng thì sinh
   * khóa mới (contract §2.3). Bán xong phải bỏ khóa: khách sau mua y hệt mà
   * dùng lại khóa thì máy chủ chỉ trả lại hóa đơn cũ, đơn mới không được ghi.
   */
  const submitKey = useSubmitKey();

  function resetSale() {
    setCart([]);
    setControlledBuyer(null);
    setCustomer(null);
    setCustomerSearch("");
    setPrescription(null);
    setAcked(new Set());
    setAckReason("");
    setDiscountValue(0);
    setDiscountReason("");
    setRedeemPoints(0);
    setTendered(null);
    setPaymentMethod("CASH");
  }

  const checkout = useMutation({
    mutationFn: async () => {
      const response = await http.post<Envelope<Invoice>>("/invoices", body, {
        headers: submitKey.headers(body),
      });
      return response.data.data;
    },
    onSuccess: (invoice) => {
      submitKey.done();
      void queryClient.invalidateQueries({ queryKey: ["customer-loyalty"] });
      void queryClient.invalidateQueries({ queryKey: cashShiftKeys.current });
      // In lần lượt: hộp thoại in thứ hai chỉ mở khi hộp thứ nhất đã đóng.
      const labels = printLabels && invoice.lines.some((line) => line.usageInstruction);
      void (async () => {
        if (printAfterPayment) await printInvoice(invoice.id, message);
        if (labels) await printDocument(printUrl.usageLabels(invoice.id), message);
      })();
      setDone(invoice);
      resetSale();
    },
    onError: (error) => {
      // Lần gửi trước đã lập hóa đơn nhưng máy khách mất kết nối trước khi
      // nhận kết quả: mở đúng hóa đơn đó ra, tuyệt đối không để người bán
      // tưởng là thất bại rồi bán lại lần nữa.
      const committed = getCommittedResource(error);
      if (committed?.resourceType === "invoice") {
        void (async () => {
          try {
            const invoice = (await http.get<Envelope<Invoice>>(`/invoices/${committed.resourceId}`))
              .data.data;
            submitKey.done();
            void message.warning("Đơn này đã được lập từ lần bấm trước, mở lại hóa đơn đã lưu", 8);
            setDone(invoice);
            resetSale();
          } catch {
            void message.error(
              `Đơn đã được lập từ lần bấm trước (mã chứng từ ${committed.resourceId}). Mở màn Hóa đơn để kiểm tra trước khi bán lại.`,
              10,
            );
          }
        })();
        return;
      }
      void message.error(getErrorMessage(error, "Không bán được"));
    },
  });

  /**
   * Gắn một đơn đã xác nhận vào đơn bán. Giỏ đang trống thì điền luôn thuốc
   * theo đơn; giỏ đã có thuốc thì để người bán bấm "Thêm thuốc theo đơn".
   */
  async function attachPrescription(id: string) {
    try {
      const detail = (await http.get<Envelope<PrescriptionDetail>>(`/prescriptions/${id}`)).data
        .data;
      setPrescription(detail);
      setPrescriptionSearch("");
      // Đơn thuốc thường đã gắn sẵn khách — tự điền nếu chưa chọn ai.
      if (!customer && detail.customer) setCustomer(detail.customer);
      if (cart.length === 0) await addPrescriptionLines(detail, []);
    } catch (error) {
      void message.error(getErrorMessage(error, "Không mở được đơn thuốc"));
    }
  }

  /**
   * Thêm các thuốc còn bán được của đơn mà giỏ chưa có, đúng đơn vị và số
   * lượng kê, kèm vị trí kệ của lô sẽ bán trước: người bán chỉ còn đi lấy.
   */
  async function addPrescriptionLines(detail: PrescriptionDetail, current: CartLine[]) {
    const inCart = new Set(current.map((line) => line.product.id));
    try {
      const products = await Promise.all(
        productsToFetch(detail.items, inCart).map((productId) =>
          http
            .get<Envelope<ProductDetail>>(`/products/${productId}`)
            .then((response) => response.data.data),
        ),
      );
      const { lines, skipped } = prescriptionCartLines(
        detail.items,
        new Map(products.map((product) => [product.id, product])),
        inCart,
      );
      const stamp = Date.now();
      setCart((existing) => [
        ...existing,
        ...lines
          .filter((line) => !existing.some((item) => item.product.id === line.product.id))
          .map((line, index) => ({
            ...line,
            key: `${line.product.id}:${line.unitId}:${stamp}:${index}`,
            scanned: 0,
            fromPrescription: true,
          })),
      ]);
      if (skipped.length > 0)
        void message.warning(`Chưa tự thêm được: ${skipped.join(", ")}. Thêm tay nếu cần.`, 8);
      else if (lines.length > 0) void message.success(`Đã thêm ${lines.length} thuốc theo đơn`);
    } catch (error) {
      void message.error(getErrorMessage(error, "Không thêm được thuốc theo đơn"));
    }
  }

  /**
   * Lấy đơn điện tử bằng mã. Đơn đã khớp đủ thuốc: dược sĩ xác nhận ngay tại
   * quầy rồi bán; còn thuốc chưa khớp thì phải chọn sản phẩm ở màn Đơn thuốc.
   */
  async function loadEPrescription(code: string) {
    try {
      const result = await importEPrescription(code);
      setPrescriptionSearch("");
      const detail = (
        await http.get<Envelope<PrescriptionDetail>>(`/prescriptions/${result.prescriptionId}`)
      ).data.data;
      if (detail.status === "VERIFIED" || detail.status === "PARTIALLY_DISPENSED") {
        await attachPrescription(detail.id);
        return;
      }
      if (detail.status !== "DRAFT" && detail.status !== "PENDING_REVIEW") {
        void message.warning(`Đơn ${code} đang ở trạng thái không bán được`);
        return;
      }
      if (result.unmatched > 0 || detail.items.some((item) => !item.productId)) {
        void message.warning(
          `Đã lấy đơn về (${detail.code}). Còn thuốc chưa khớp sản phẩm — chọn ở màn Đơn thuốc rồi quay lại.`,
          8,
        );
        return;
      }
      if (!can("prescription.verify")) {
        void message.info(
          `Đã lấy đơn về (${detail.code}). Cần dược sĩ xác nhận đơn trước khi bán.`,
          8,
        );
        return;
      }
      modal.confirm({
        title: `Xác nhận đơn ${code}?`,
        content: `${detail.patientName ?? "Người bệnh"} · ${detail.items.length} thuốc, đã khớp đủ sản phẩm. Xác nhận đơn và dùng để bán ngay.`,
        okText: "Xác nhận và bán",
        cancelText: "Để sau",
        onOk: async () => {
          await http.post(
            `/prescriptions/${detail.id}/verify`,
            {},
            { headers: { "Idempotency-Key": crypto.randomUUID() } },
          );
          await attachPrescription(detail.id);
          void queryClient.invalidateQueries({ queryKey: ["usable-prescriptions"] });
        },
      });
    } catch (error) {
      void message.error(getErrorMessage(error, "Không lấy được đơn thuốc điện tử"), 8);
    }
  }

  /**
   * Thêm sản phẩm vào đơn. `unitId` là đơn vị người bán chọn ở danh sách;
   * `scannedCode` là mã vạch vừa quét (quét mã hộp thì thêm một hộp).
   */
  async function addProduct(
    productId: string,
    options: { unitId?: string; scannedCode?: string } = {},
  ) {
    try {
      const product = (await http.get<Envelope<ProductDetail>>(`/products/${productId}`)).data.data;
      const code = options.scannedCode;
      const scannedUnit = code
        ? product.units.find((item) => item.barcodes?.includes(code))
        : undefined;
      // Đúng mã vạch của một đơn vị, hoặc mã sản phẩm in trên tem: người bán
      // đang cầm hộp thuốc này. Gõ tên rồi Enter thì không tính là đã quét.
      const scanned = Boolean(scannedUnit) || code?.toLowerCase() === product.code.toLowerCase();
      const unit =
        (options.unitId ? product.units.find((item) => item.id === options.unitId) : undefined) ??
        scannedUnit ??
        product.units.find((item) => item.isDefaultSaleUnit) ??
        product.units.find((item) => item.conversionToBase === 1) ??
        product.units[0];
      if (!unit) {
        void message.error("Sản phẩm chưa có đơn vị tính");
        return;
      }

      // Thuốc kê đơn thì thử khớp sẵn vào đơn đang chọn nếu chỉ có đúng một dòng phù hợp.
      const candidates = needsPrescription(product.drugClass)
        ? matchingPrescriptionItems(product.id, prescription)
        : [];
      const prescriptionItemId = candidates.length === 1 ? candidates[0]!.id : null;
      const newLine = (): CartLine => ({
        key: `${product.id}:${unit.id}:${Date.now()}`,
        product,
        unitId: unit.id,
        quantity: 1,
        prescriptionItemId,
        scanned: scanned ? 1 : 0,
      });
      setTerm("");

      if (!scanned) {
        setCart((current) => {
          const found = current.find(
            (line) => line.product.id === product.id && line.unitId === unit.id,
          );
          if (found)
            return current.map((line) =>
              line.key === found.key ? { ...line, quantity: line.quantity + 1 } : line,
            );
          return [...current, newLine()];
        });
        searchRef.current?.focus();
        return;
      }

      const pending = pendingPicks(
        cart,
        product.id,
        prescription?.items.some((item) => item.productId === product.id) ?? false,
      );
      if (pending.length > 0) {
        modal.confirm({
          title: "Có thể lấy nhầm thuốc",
          content: `${product.name} không có trong đơn thuốc. Thuốc theo đơn chưa quét: ${pending.map((line) => line.product.name).join(", ")}.`,
          okText: "Vẫn thêm vào đơn",
          cancelText: "Lấy nhầm, bỏ qua",
          focusable: { autoFocusButton: "cancel" },
          onOk: () => setCart((current) => applyScan(current, product.id, unit.id, newLine)),
          afterClose: () => searchRef.current?.focus(),
        });
        return;
      }
      if (scanConfirmsLine(cart, product.id, unit.id))
        void message.success(`Đúng thuốc: ${product.name}`, 1.5);
      setCart((current) => applyScan(current, product.id, unit.id, newLine));
      searchRef.current?.focus();
    } catch (error) {
      void message.error(getErrorMessage(error, "Không thêm được sản phẩm"));
    }
  }

  /**
   * Enter trong ô tìm khi chưa chọn dòng: máy quét mã vạch gõ rất nhanh rồi
   * Enter, nên tra thẳng API với chuỗi hiện tại thay vì dựa vào danh sách.
   */
  async function handleScanEnter(code = term) {
    const value = productCodeFromScan(code);
    if (!value) return;
    try {
      const items = (
        await http.get<Envelope<Paged<ProductListItem>>>("/products", {
          params: { search: value, page: 1, limit: 2 },
        })
      ).data.data.items;
      if (items.length === 1) await addProduct(items[0]!.id, { scannedCode: value });
      else if (items.length === 0) void message.warning(`Không tìm thấy sản phẩm khớp “${value}”`);
      else void message.info("Có nhiều sản phẩm khớp — chọn dòng cần bán rồi Enter");
    } catch (error) {
      void message.error(getErrorMessage(error, "Không tìm được sản phẩm"));
    }
  }

  function updateLine(key: string, patch: Partial<CartLine>) {
    setCart((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  const subtotal = cart.reduce((sum, line) => sum + lineTotal(line), 0);
  const estimatedDiscount =
    discountValue <= 0
      ? 0
      : discountType === "PERCENT"
        ? Math.floor((subtotal * discountValue) / 100)
        : Math.min(discountValue, subtotal);
  const estimatedTotal = subtotal - estimatedDiscount - loyaltyDiscount;
  const cash = paymentMethod === "CASH";
  const shortfall =
    cash && tendered !== null && cart.length > 0 && tendered < estimatedTotal
      ? estimatedTotal - tendered
      : null;
  const estimatedChange =
    cash && tendered !== null && tendered >= estimatedTotal && cart.length > 0
      ? tendered - estimatedTotal
      : null;

  const needAck = warnings.filter((warning) => warning.requiresAck);
  const missingAck = needAck.filter((warning) => !liveAcked.includes(warning.code));
  const canSell =
    cart.length > 0 && blocking.length === 0 && missingAck.length === 0 && !safety.isFetching;

  const nameOf = (productId: string) =>
    cart.find((line) => line.product.id === productId)?.product.name ?? productId;

  // Mở từ màn Khách hàng ("Tạo đơn bán cho khách"): chọn sẵn khách rồi bỏ tham số khỏi URL.
  useEffect(() => {
    if (!preselectId) return;
    let cancelled = false;
    http
      .get<Envelope<CustomerDetail>>(`/customers/${preselectId}`)
      .then((response) => {
        if (cancelled) return;
        const found = response.data.data;
        if (!found.isAnonymized)
          setCustomer({ id: found.id, fullName: found.fullName, phone: found.phone });
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
      content:
        "Toàn bộ thuốc, khách hàng và đơn thuốc đã chọn sẽ bị bỏ. Chưa có gì được ghi vào hệ thống.",
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
      lines: cart.map((line) => ({
        productId: line.product.id,
        productName: line.product.name,
        unitId: line.unitId,
        quantity: line.quantity,
      })),
      discount: { type: discountType, value: discountValue, reason: discountReason },
    };
    try {
      setDraftCache({ storeId, list: writeDrafts(storeId, [draft, ...drafts]) });
      resetSale();
      void message.success(
        drafts.length >= MAX_SALE_DRAFTS
          ? `Đã lưu nháp; chỉ giữ ${MAX_SALE_DRAFTS} đơn nháp gần nhất`
          : "Đã lưu nháp — mở lại ở mục Đơn nháp",
      );
      searchRef.current?.focus();
    } catch {
      void message.error("Trình duyệt không cho lưu nháp trên máy này");
    }
  }

  function removeDraft(id: string) {
    if (!storeId) return;
    try {
      setDraftCache({
        storeId,
        list: writeDrafts(
          storeId,
          drafts.filter((item) => item.id !== id),
        ),
      });
    } catch {
      // Không xóa được thì danh sách giữ nguyên.
    }
  }

  /** Mở lại đơn nháp: tải lại sản phẩm để giá, đơn vị và tồn là số hiện hành. */
  async function openDraft(draft: SaleDraft) {
    setRestoringDraft(true);
    try {
      const products = await Promise.all(
        draft.lines.map((line) =>
          http
            .get<Envelope<ProductDetail>>(`/products/${line.productId}`)
            .then((response) => response.data.data),
        ),
      );
      const restoredPrescription = draft.prescriptionId
        ? (await http.get<Envelope<PrescriptionDetail>>(`/prescriptions/${draft.prescriptionId}`))
            .data.data
        : null;
      const lines: CartLine[] = [];
      const skipped: string[] = [];
      draft.lines.forEach((line, index) => {
        const product = products[index]!;
        const unit = product.units.find(
          (item) => item.id === line.unitId && item.isActive !== false,
        );
        if (!unit || !product.isActive) {
          skipped.push(line.productName);
          return;
        }
        const candidates = needsPrescription(product.drugClass)
          ? matchingPrescriptionItems(product.id, restoredPrescription)
          : [];
        lines.push({
          key: `${product.id}:${unit.id}:${Date.now()}:${index}`,
          product,
          unitId: unit.id,
          quantity: line.quantity,
          prescriptionItemId: candidates.length === 1 ? candidates[0]!.id : null,
          scanned: 0,
        });
      });
      resetSale();
      setCart(lines);
      setCustomer(draft.customer);
      setPrescription(
        restoredPrescription &&
          (restoredPrescription.status === "VERIFIED" ||
            restoredPrescription.status === "PARTIALLY_DISPENSED")
          ? restoredPrescription
          : null,
      );
      setDiscountType(draft.discount.type);
      setDiscountValue(draft.discount.value);
      setDiscountReason(draft.discount.reason);
      removeDraft(draft.id);
      if (skipped.length > 0)
        void message.warning(`Bỏ qua sản phẩm không còn bán: ${skipped.join(", ")}`);
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

  return (
    <div className="sale-page">
      <PageHeader
        icon={<ShoppingCartOutlined />}
        title="Bán thuốc"
        extra={
          <>
            <CashShiftBar />
            <div className="shortcut-hints">
              <span>
                <kbd>F2</kbd> Tìm thuốc
              </span>
              <span>
                <kbd>F9</kbd> Thanh toán
              </span>
            </div>
          </>
        }
      />

      <div className="pos-layout">
        <PosCatalog
          term={term}
          onTermChange={setTerm}
          searchRef={searchRef}
          onScanEnter={() => void handleScanEnter()}
          onAdd={(productId, unitId) => void addProduct(productId, { unitId })}
          cameraButton={
            <CameraScanButton
              type="text"
              title="Quét mã hộp thuốc bằng camera"
              accept={(raw) => productCodeFromScan(raw) || null}
              onDetected={(code) => void handleScanEnter(code)}
            />
          }
        />

        <section className="pos-panel pos-checkout-panel" aria-label="Đơn bán hiện tại">
          <div className="pos-checkout-head">
            <h2>Đơn bán hiện tại</h2>
            <Tag color="blue" variant="filled">
              Đơn mới
            </Tag>
            <span className="pos-head-actions">
              <PosDraftsMenu
                drafts={drafts}
                loading={restoringDraft}
                onOpen={requestOpenDraft}
                onRemove={removeDraft}
              />
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                disabled={cart.length === 0 && !customer && !prescription}
                onClick={confirmClear}
              >
                Xóa đơn
              </Button>
            </span>
          </div>

          <div className="pos-attach">
            <PosCustomerRow
              customer={customer}
              onChange={(next) => {
                setCustomer(next);
                if (!next) setRedeemPoints(0);
              }}
              search={customerSearch}
              onSearchChange={setCustomerSearch}
              onAddNew={can("customer.manage") ? () => setNewCustomerOpen(true) : undefined}
            />

            <PosPrescriptionField
              prescription={prescription}
              pending={prescriptionPending}
              canRead={can("prescription.read")}
              search={prescriptionSearch}
              onSearchChange={setPrescriptionSearch}
              onAttach={attachPrescription}
              onLoadErx={loadEPrescription}
              onClear={clearPrescription}
              onAddLines={() => prescription && void addPrescriptionLines(prescription, cart)}
            />
          </div>

          <PosCartLines
            cart={cart}
            prescription={prescription}
            scanning={scanning}
            onUpdate={updateLine}
            onRemove={(key) => setCart((current) => current.filter((item) => item.key !== key))}
          />

          {controlledLines.length > 0 ? (
            <ControlledBuyerCard
              productNames={[...new Set(controlledLines.map((line) => line.product.name))]}
              value={controlledBuyer}
              onChange={setControlledBuyer}
            />
          ) : null}

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
            <PosDiscount
              type={discountType}
              onTypeChange={setDiscountType}
              value={discountValue}
              onValueChange={setDiscountValue}
              reason={discountReason}
              onReasonChange={setDiscountReason}
              disabled={!can("sale.discount")}
              estimated={estimatedDiscount}
            />
            {loyaltyProgram?.enabled && customer ? (
              <PosLoyaltyBox
                program={loyaltyProgram}
                loading={customerLoyalty.isLoading}
                pointsAvailable={pointsAvailable}
                canRedeem={canRedeem}
                maxRedeem={maxRedeem}
                redeemPoints={redeemPoints}
                onRedeemChange={setRedeemPoints}
                appliedRedeem={appliedRedeem}
                loyaltyDiscount={loyaltyDiscount}
                eligibleSubtotal={loyaltyEligibleSubtotal}
              />
            ) : null}
            {appliedRedeem > 0 ? (
              <div className="pos-summary-row muted">
                <span>Đổi {formatNumber(appliedRedeem)} điểm</span>
                <span>−{money(loyaltyDiscount)}</span>
              </div>
            ) : null}
            <div className="pos-due">
              <span>Khách phải trả</span>
              <strong>{money(estimatedTotal)}</strong>
            </div>
          </div>

          <PosTender
            total={estimatedTotal}
            paymentMethod={paymentMethod}
            onMethodChange={setPaymentMethod}
            tendered={tendered}
            onTenderedChange={setTendered}
            change={estimatedChange}
            shortfall={shortfall}
          />

          <div className="pos-status-row">
            <Checkbox
              checked={printAfterPayment}
              onChange={(event) => setPrintAfterPayment(event.target.checked)}
            >
              In hóa đơn
            </Checkbox>
            {cart.some((line) => usageOf(line, prescription)) ? (
              <Checkbox
                checked={printLabels}
                onChange={(event) => setPrintLabels(event.target.checked)}
              >
                In nhãn cách dùng
              </Checkbox>
            ) : null}
            <SafetyStatus
              active={cart.length > 0}
              loading={safety.isFetching}
              failed={safety.isError}
              blockingCount={blocking.length}
              missingAckCount={missingAck.length}
            />
          </div>
          {cart.length > 0 && !canSell && !safety.isFetching ? (
            <p className="pos-blocked">
              <WarningFilled />{" "}
              {blocking.length > 0
                ? "Còn vấn đề chặn bán, xem mục Kiểm tra an toàn."
                : `Còn ${missingAck.length} cảnh báo cần ghi nhận trước khi bán.`}
            </p>
          ) : null}
          {unscanned > 0 ? (
            <p className="pos-scan-note">
              <BarcodeOutlined /> Còn {unscanned} thuốc chưa quét xác nhận
            </p>
          ) : null}
          <p className="pos-note">
            Số tạm tính. Máy chủ tính lại đơn giá, VAT và tổng tiền khi lập hóa đơn.
          </p>

          <div className="pos-actions">
            <Button
              size="large"
              icon={<FileTextOutlined />}
              disabled={cart.length === 0 || !storeId}
              onClick={saveDraft}
            >
              Lưu nháp
            </Button>
            <Button
              type="primary"
              size="large"
              className="pos-pay"
              disabled={!canSell}
              loading={checkout.isPending}
              onClick={() => checkout.mutate()}
            >
              {!checkout.isPending ? <CreditCardOutlined /> : null} Thanh toán ·{" "}
              {money(estimatedTotal)} <kbd>F9</kbd>
            </Button>
          </div>
        </section>
      </div>

      <NewCustomerModal
        open={newCustomerOpen}
        onClose={() => setNewCustomerOpen(false)}
        onCreated={(created) => {
          setCustomer(created);
          setNewCustomerOpen(false);
        }}
      />

      <SaleDoneModal
        invoice={done}
        onClose={() => setDone(null)}
        afterClose={() => searchRef.current?.focus()}
      />
    </div>
  );
}
