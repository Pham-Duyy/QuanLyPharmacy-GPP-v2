/** Khung response chung của backend (contract §2.6). */
export type Envelope<T> = { success: true; data: T; requestId: string };

export type Paged<T> = { items: T[]; pagination: { page: number; limit: number; total: number } };

export type Money = number;

export type DashboardData = {
  generatedAt: string;
  days: 7 | 30;
  permissions: { sales: boolean; inventory: boolean; customers: boolean; storageLogs: boolean };
  sales: {
    today: {
      revenue: Money;
      invoiceCount: number;
      newCustomerCount: number;
      revenueChangePercent: number | null;
      invoiceChangePercent: number | null;
      newCustomerChangePercent: number | null;
    };
    trend: Array<{ date: string; revenue: Money; invoiceCount: number }>;
    topProducts: Array<{ productId: string; productName: string; quantity: number; revenue: Money }>;
  };
  inventory: {
    expiringBatches: Array<{ id: string; productId: string; productName: string; batchNumber: string; expiryDate: string; quantityOnHand: number }>;
    lowStockProducts: Array<{ productId: string; productName: string; stock: number; minimumStock: number }>;
    categoryStock: Array<{ categoryName: string; quantity: number; productCount: number }>;
    counts: { expired: number; expiring: number; lowStock: number };
  };
  notifications: Array<{ type: string; severity: "danger" | "warning" | "info"; title: string; href: string }>;
};

export type ProductUnit = {
  id: string;
  name: string;
  conversionToBase: number;
  isSellable?: boolean;
  isDefaultSaleUnit?: boolean;
  isActive?: boolean;
  barcodes?: string[];
  currentPrice?: CurrentPrice | null;
};

export type CurrentPrice = {
  salePrice: Money;
  vatRatePercent: string;
  isStoreOverride: boolean;
};

export type StockSummary = {
  sellable: number;
  quarantined: number;
  recalled: number;
  expired: number;
};

export type BatchListItem = {
  id: string;
  productId: string;
  productCode: string;
  productName: string;
  baseUnitName: string;
  batchNumber: string;
  manufactureDate: string | null;
  expiryDate: string;
  status: "AVAILABLE" | "QUARANTINED" | "RECALLED";
  quantityOnHand: number;
  shelfLocation: string | null;
  note: string | null;
  version: number;
  /** Chỉ có khi người xem có quyền stock.cost.read. */
  unitCost?: Money | null;
};

export type InventoryOverviewItem = {
  productId: string;
  code: string;
  name: string;
  categoryName: string;
  minStockBaseQuantity: number;
  stock: StockSummary;
};

export type StockMovementType =
  | "RECEIPT"
  | "OPENING_BALANCE"
  | "SALE"
  | "SALE_VOID"
  | "CUSTOMER_RETURN"
  | "ADJUSTMENT"
  | "DISPOSAL";

export type StockLedgerEntry = {
  id: string;
  occurredAt: string;
  type: StockMovementType;
  batchId: string;
  batchNumber: string;
  productId: string;
  productCode: string;
  productName: string;
  baseQuantity: number;
  balanceAfter: number;
  sourceType: string;
  sourceId: string;
  sourceLineId: string;
  userId: string | null;
  userName: string | null;
  note: string | null;
};

export type StockLedgerPage = { items: StockLedgerEntry[]; nextCursor: string | null };

export type ProductListItem = {
  id: string;
  code: string;
  name: string;
  productType: string;
  drugClass: string | null;
  categoryName: string;
  dosageForm: string | null;
  strengthText: string | null;
  ingredients: Array<{ name: string; strengthText: string | null }>;
  defaultUnit: ProductUnit | null;
  currentPrice: CurrentPrice | null;
  stock: StockSummary | null;
};

export type ProductDetail = {
  id: string;
  code: string;
  name: string;
  productType: string;
  drugClass: string | null;
  category: { id: string; name: string };
  minStockBaseQuantity: number;
  version: number;
  units: ProductUnit[];
  ingredients: Array<{ ingredientId: string; name: string; strengthText: string | null }>;
  stock: StockSummary | null;
};

export type CategoryItem = {
  id: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
  version: number;
};

export type ActiveIngredientItem = {
  id: string;
  name: string;
  atcCode: string | null;
};

// --- Kho: phiếu nhập -------------------------------------------------------

export type SupplierListItem = {
  id: string;
  name: string;
  phone: string | null;
  taxCode: string | null;
  licenseNumber: string | null;
  address: string | null;
  isActive: boolean;
  version: number;
};

export type GoodsReceiptLine = {
  id: string;
  lineNo: number;
  productId: string;
  productCode: string;
  productName: string;
  unitId: string;
  unitName: string;
  conversionToBase: number;
  quantity: number;
  baseQuantity: number;
  unitCost: Money;
  lineCost: Money;
  batchNumber: string;
  manufactureDate: string | null;
  expiryDate: string;
  batchId: string | null;
};

export type GoodsReceiptDetail = {
  id: string;
  type: "PURCHASE" | "OPENING_BALANCE";
  code: string;
  status: "DRAFT" | "CONFIRMED" | "CANCELLED";
  supplier: { id: string; name: string } | null;
  supplierInvoiceNumber: string | null;
  supplierInvoiceDate: string | null;
  receivedAt: string;
  note: string | null;
  totalCost: Money;
  version: number;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  lines: GoodsReceiptLine[];
};

export type GoodsReceiptListItem = {
  id: string;
  code: string;
  status: GoodsReceiptDetail["status"];
  supplierName: string | null;
  receivedAt: string;
  totalCost: Money;
  lineCount: number;
};

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

// --- Trả hàng (contract §15) -----------------------------------------------

export type ReturnLine = {
  id: string;
  lineNo: number;
  productName: string;
  unitName: string;
  quantity: number;
  baseQuantity: number;
  refundAmount: Money;
  batchNumber: string;
  expiryDate: string;
};

export type ReturnDetail = {
  id: string;
  code: string;
  invoice: { id: string; code: string; returnStatus: string };
  reason: string | null;
  disposition: "RESTOCK" | "DISPOSE";
  refundMethod: string | null;
  refundAmount: Money;
  businessDate: string;
  createdAt: string;
  createdBy: { id: string; fullName: string };
  lines: ReturnLine[];
};

export type ReturnListItem = {
  id: string;
  code: string;
  invoiceCode: string;
  disposition: "RESTOCK" | "DISPOSE";
  refundAmount: Money;
  createdAt: string;
  createdByName: string;
  lineCount: number;
};

// --- Đơn thuốc (contract §12) -----------------------------------------------

export type PrescriptionStatus =
  | "DRAFT"
  | "PENDING_REVIEW"
  | "VERIFIED"
  | "PARTIALLY_DISPENSED"
  | "DISPENSED"
  | "REJECTED";

export type PrescriptionItem = {
  id: string;
  lineNo: number;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  drugClass: string | null;
  drugNameText: string;
  unitId: string | null;
  unitName: string | null;
  quantity: number;
  baseQuantity: number | null;
  dosageInstruction: string | null;
  dispensedBaseQuantity: number;
};

export type PrescriptionDetail = {
  id: string;
  code: string;
  externalCode: string | null;
  status: PrescriptionStatus;
  customer: { id: string; fullName: string | null; phone: string | null } | null;
  prescriberName: string | null;
  facilityName: string | null;
  diagnosisText: string | null;
  prescribedDate: string;
  validUntil: string;
  createdBy: { id: string; fullName: string };
  verifiedBy: { id: string; fullName: string } | null;
  verifiedAt: string | null;
  rejectedReason: string | null;
  version: number;
  images: Array<{
    id: string;
    versionNo: number;
    contentType: string;
    uploadedAt: string;
    /** URL có chữ ký, hạn ngắn — xem xong nhớ tải lại chi tiết đơn nếu quá 5 phút (contract §12). */
    url: string;
  }>;
  items: PrescriptionItem[];
};

export type PrescriptionListItem = {
  id: string;
  code: string;
  status: PrescriptionStatus;
  customer: { fullName: string | null } | null;
  createdAt: string;
  prescribedDate: string;
  validUntil: string;
  _count: { items: number };
};

// --- Khách hàng (contract §11) ----------------------------------------------

export type CustomerSearchItem = {
  id: string;
  fullName: string | null;
  /** Che bớt ở kết quả tìm kiếm, xem chi tiết mới thấy đầy đủ. */
  phone: string | null;
};

export type CustomerDetail = {
  id: string;
  fullName: string | null;
  phone: string | null;
  birthYear: number | null;
  gender: "MALE" | "FEMALE" | "OTHER" | null;
  note: string | null;
  hasHealthConsent: boolean;
  isAnonymized: boolean;
  version: number;
};

export type CustomerAllergyItem = { ingredientId: string; ingredientName: string; note: string | null };

export type CustomerHealthProfile = {
  hasHealthConsent: boolean;
  healthDataConsentAt: string | null;
  chronicConditions: string | null;
  note: string | null;
  allergies: CustomerAllergyItem[];
};

export type CustomerInvoiceHistoryItem = {
  id: string;
  code: string;
  storeCode: string;
  storeName: string;
  status: "COMPLETED" | "VOIDED";
  soldAt: string;
  totalAmount: Money;
  lineCount: number;
};

// --- Điều chỉnh tồn kho (contract §10.3) ------------------------------------

export type AdjustmentReasonCode =
  | "COUNT_DIFFERENCE"
  | "DAMAGED"
  | "EXPIRED_DISPOSAL"
  | "RECALL_DISPOSAL"
  | "OTHER";

export type StockAdjustmentStatus = "DRAFT" | "APPROVED" | "REJECTED" | "CANCELLED";

export type StockAdjustmentListItem = {
  id: string;
  code: string;
  status: StockAdjustmentStatus;
  reason: string | null;
  createdByName: string;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  createdAt: string;
  lineCount: number;
};

export type StockAdjustmentLine = {
  id: string;
  lineNo: number;
  batchId: string;
  batchNumber: string;
  unitName: string;
  reasonCode: AdjustmentReasonCode;
  countedQuantity: number | null;
  quantity: number | null;
  systemBaseQuantityAtCount: number | null;
  deltaBaseQuantity: number | null;
};

export type StockAdjustmentDetail = {
  id: string;
  code: string;
  status: StockAdjustmentStatus;
  reason: string | null;
  createdBy: { id: string; fullName: string };
  approvedBy: { id: string; fullName: string } | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  version: number;
  lines: StockAdjustmentLine[];
};

// --- Sổ nhiệt độ – độ ẩm (contract §17) -------------------------------------

export type StorageLocationItem = {
  id: string;
  code: string;
  name: string;
  minTempC: number | null;
  maxTempC: number | null;
  maxHumidityPercent: number | null;
};

export type StorageLogItem = {
  id: string;
  storageLocation: { id: string; code: string; name: string };
  recordedAt: string;
  businessDate: string;
  temperatureC: number;
  humidityPercent: number | null;
  outOfRange: boolean;
  note: string | null;
  recordedBy: { id: string; fullName: string };
  correctsLogId: string | null;
};

export type StorageLogSummaryDay = {
  businessDate: string;
  count: number;
  expectedCount: number;
  hasOutOfRange: boolean;
};

export type StorageLogSummaryLocation = {
  locationId: string;
  locationCode: string;
  locationName: string;
  days: StorageLogSummaryDay[];
};

// --- Người dùng và vai trò (contract §21) -----------------------------------

export type UserRoleAssignment = {
  roleCode: string;
  roleName: string;
  storeId: string | null;
  storeName?: string | null;
};

export type UserListItem = {
  id: string;
  username: string;
  fullName: string;
  phone: string | null;
  isActive: boolean;
  roles: UserRoleAssignment[];
};

export type UserDetail = {
  id: string;
  username: string;
  fullName: string;
  phone: string | null;
  practiceCertificateNumber: string | null;
  mustChangePassword: boolean;
  isActive: boolean;
  defaultStoreId: string | null;
  version: number;
  roles: UserRoleAssignment[];
};

export type RoleItem = {
  code: string;
  name: string;
  description: string | null;
  permissions: string[];
};

// --- Cửa hàng (contract §21) -------------------------------------------------

export type StoreDetail = {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  gppCertificateNumber: string | null;
  licenseNumber: string | null;
  isActive: boolean;
  version: number;
  permissions: string[];
};

// --- Audit log (contract §18) -----------------------------------------------

export type AuditLogItem = {
  id: string;
  occurredAt: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
};

export type AuditLogPage = { items: AuditLogItem[]; nextCursor: string | null };
