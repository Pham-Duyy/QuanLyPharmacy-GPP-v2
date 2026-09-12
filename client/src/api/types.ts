/** Khung response chung của backend (contract §2.6). */
export type Envelope<T> = { success: true; data: T; requestId: string };

export type Paged<T> = { items: T[]; pagination: { page: number; limit: number; total: number } };

export type Money = number;

export type ProductUnit = {
  id: string;
  name: string;
  conversionToBase: number;
  isDefaultSaleUnit?: boolean;
  currentPrice?: CurrentPrice | null;
};

export type CurrentPrice = {
  salePrice: Money;
  vatRatePercent: string;
  isStoreOverride: boolean;
};

export type StockSummary = { sellable: number; quarantined: number; expired: number };

export type ProductListItem = {
  id: string;
  code: string;
  name: string;
  productType: string;
  drugClass: string | null;
  categoryName: string;
  defaultUnit: ProductUnit | null;
  currentPrice: CurrentPrice | null;
  stock: StockSummary | null;
};

export type ProductDetail = ProductListItem & { units: ProductUnit[] };

// --- Kiểm tra an toàn (contract §13) ---------------------------------------

export type Blocking = {
  code: string;
  productId: string;
  message: string;
  requestedBaseQuantity?: number;
  sellableBaseQuantity?: number;
};

export type Warning = {
  code: string;
  severity: "INFO" | "MEDIUM" | "HIGH";
  requiresAck: boolean;
  productIds: string[];
  message: string;
  source: string;
  sourceVersion: string;
};

export type NotChecked = { productId: string; reason: string };

export type SafetyResult = {
  blocking: Blocking[];
  warnings: Warning[];
  notChecked: NotChecked[];
};

// --- Hóa đơn (contract §14) -------------------------------------------------

export type InvoiceAllocation = {
  id: string;
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  baseQuantity: number;
  returnedBaseQuantity: number;
};

export type InvoiceLine = {
  id: string;
  lineNo: number;
  productId: string;
  productName: string;
  unitId: string;
  unitName: string;
  conversionToBase: number;
  quantity: number;
  baseQuantity: number;
  unitPrice: Money;
  vatRatePercent: string;
  discountAmount: Money;
  lineTotal: Money;
  batchOverrideReason: string | null;
  allocations: InvoiceAllocation[];
};

export type Invoice = {
  id: string;
  code: string;
  status: "COMPLETED" | "VOIDED";
  returnStatus: "NONE" | "PARTIAL" | "FULL";
  customer: { id: string; fullName: string | null; phone: string | null } | null;
  seller: { id: string; fullName: string };
  soldAt: string;
  businessDate: string;
  subtotal: Money;
  discountAmount: Money;
  discountReason: string | null;
  vatAmount: Money;
  totalAmount: Money;
  paymentMethod: string;
  amountTendered: Money | null;
  changeAmount: Money | null;
  voidReason: string | null;
  lines: InvoiceLine[];
};

export type InvoiceListItem = {
  id: string;
  code: string;
  status: "COMPLETED" | "VOIDED";
  returnStatus: string;
  customerName: string | null;
  sellerName: string;
  soldAt: string;
  totalAmount: Money;
  lineCount: number;
};

/** Định dạng tiền Việt, dùng thống nhất toàn giao diện. */
export function formatVnd(value: Money | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("vi-VN").format(value) + " ₫";
}
