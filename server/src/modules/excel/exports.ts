import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { businessDateNow } from "../../lib/settings.js";
import type { AuthContext } from "../auth/auth.context.js";
import { getCurrentPrices, getStockSummary } from "../catalog/products.service.js";
import { DRUG_CLASS_LABEL, PRODUCT_COLUMNS, PRODUCT_TYPE_LABEL } from "./import-products.js";
import { buildLedger } from "../controlled/controlled.service.js";
import { CUSTOMER_COLUMNS, SUPPLIER_COLUMNS } from "./import-partners.js";
import type { ColumnDef, SheetSpec } from "./workbook.js";

export type ExportContext = { auth: AuthContext; storeId: string | null; from: Date; to: Date };

export type ExportDefinition = {
  type: string;
  title: string;
  permission: string[];
  needsStore: boolean;
  /** Có lọc theo khoảng ngày không (hóa đơn, phiếu nhập…). */
  dated: boolean;
  /** Ghi audit mỗi lần xuất (dữ liệu cá nhân của khách). */
  audited?: boolean;
  build(ctx: ExportContext): Promise<SheetSpec[]>;
};

const num = (value: bigint | number | null | undefined) => (value === null || value === undefined ? null : Number(value));
const GENDER: Record<string, string> = { MALE: "Nam", FEMALE: "Nữ", OTHER: "Khác" };
const PAYMENT: Record<string, string> = { CASH: "Tiền mặt", BANK_TRANSFER: "Chuyển khoản", CARD: "Thẻ" };
const BATCH_STATUS: Record<string, string> = { AVAILABLE: "Bán được", QUARANTINED: "Biệt trữ", RECALLED: "Thu hồi", DISPOSED: "Đã hủy" };
const RECEIPT_STATUS: Record<string, string> = { DRAFT: "Nháp", CONFIRMED: "Đã nhập kho", CANCELLED: "Đã hủy" };

/**
 * Excel không có múi giờ và exceljs ghi Date theo UTC: dời thời điểm sang
 * giờ Việt Nam để ô hiện đúng giờ bán/nhận hàng tại cửa hàng.
 */
const vnTime = (date: Date | null) => (date ? new Date(date.getTime() + 7 * 3_600_000) : null);

/** Mốc bắt đầu một ngày theo giờ Việt Nam (UTC+7) cho cột thời điểm. */
function vnStart(date: Date): Date {
  return new Date(date.getTime() - 7 * 3_600_000);
}

function requireStore(ctx: ExportContext): string {
  if (!ctx.storeId) throw new AppError(400, "STORE_REQUIRED", "Chọn cửa hàng trước khi xuất dữ liệu này");
  return ctx.storeId;
}

export const productsExport: ExportDefinition = {
  type: "products",
  title: "Danh mục thuốc & sản phẩm",
  permission: ["catalog.read"],
  needsStore: false,
  dated: false,
  async build(ctx) {
    const products = await prisma.product.findMany({
      orderBy: { code: "asc" },
      include: {
        category: { select: { name: true } },
        ingredients: { include: { ingredient: { select: { name: true } } } },
        units: { where: { isActive: true }, include: { barcodes: true }, orderBy: { conversionToBase: "asc" } },
      },
    });
    const unitIds = products.flatMap((product) => product.units.map((unit) => unit.id));
    const [prices, stock] = await Promise.all([
      getCurrentPrices(unitIds, null),
      ctx.storeId ? getStockSummary(products.map((product) => product.id), ctx.storeId) : Promise.resolve(new Map<string, { sellable: number }>()),
    ]);
    const columns: ColumnDef[] = [...PRODUCT_COLUMNS, ...(ctx.storeId ? [{ key: "stock", header: "Tồn bán được (cửa hàng đang chọn)", kind: "int" as const, width: 16 }] : [])];

    return [
      {
        name: "Sản phẩm",
        columns,
        rows: products.map((product) => {
          const base = product.units.find((unit) => unit.conversionToBase === 1);
          const large = product.units.filter((unit) => unit.conversionToBase > 1).at(-1);
          const basePrice = base ? prices.get(base.id) : undefined;
          const largePrice = large ? prices.get(large.id) : undefined;
          return {
            code: product.code,
            name: product.name,
            productType: PRODUCT_TYPE_LABEL[product.productType],
            drugClass: product.drugClass ? DRUG_CLASS_LABEL[product.drugClass] : null,
            category: product.category.name,
            ingredients: product.ingredients.map((item) => item.ingredient.name).join("; "),
            strengthText: product.strengthText,
            dosageForm: product.dosageForm,
            packagingText: product.packagingText,
            registrationNumber: product.registrationNumber,
            manufacturer: product.manufacturer,
            countryOfOrigin: product.countryOfOrigin,
            storageCondition: product.storageCondition,
            minStock: product.minStockBaseQuantity,
            baseUnit: base?.name,
            basePrice: num(basePrice?.salePrice),
            baseBarcode: base?.barcodes[0]?.barcode ?? null,
            largeUnit: large?.name ?? null,
            largeConversion: large?.conversionToBase ?? null,
            largePrice: num(largePrice?.salePrice),
            largeBarcode: large?.barcodes[0]?.barcode ?? null,
            vat: basePrice ? Number(basePrice.vatRatePercent) : null,
            status: product.isActive ? "Đang kinh doanh" : "Ngừng kinh doanh",
            stock: stock.get(product.id)?.sellable ?? 0,
          };
        }),
      },
    ];
  },
};

export const suppliersExport: ExportDefinition = {
  type: "suppliers",
  title: "Nhà cung cấp",
  permission: ["catalog.read"],
  needsStore: false,
  dated: false,
  async build() {
    const suppliers = await prisma.supplier.findMany({ orderBy: { name: "asc" } });
    return [
      {
        name: "Nhà cung cấp",
        columns: SUPPLIER_COLUMNS,
        rows: suppliers.map((item) => ({ ...item, status: item.isActive ? "Đang giao dịch" : "Ngừng giao dịch" })),
      },
    ];
  },
};

export const customersExport: ExportDefinition = {
  type: "customers",
  title: "Khách hàng",
  // Có số điện thoại đầy đủ để gọi chăm sóc: cần quyền dữ liệu nhạy cảm và ghi audit.
  permission: ["customer.sensitive"],
  needsStore: false,
  dated: false,
  audited: true,
  async build() {
    const customers = await prisma.customer.findMany({ where: { isAnonymized: false }, orderBy: { code: "asc" } });
    return [
      {
        name: "Khách hàng",
        columns: [...CUSTOMER_COLUMNS, { key: "createdAt", header: "Ngày tạo", kind: "date", width: 12 }],
        rows: customers.map((item) => ({ ...item, gender: item.gender ? GENDER[item.gender] : null, createdAt: vnTime(item.createdAt) })),
      },
    ];
  },
};

export const inventoryExport: ExportDefinition = {
  type: "inventory",
  title: "Tồn kho theo lô",
  permission: ["stock.read"],
  needsStore: true,
  dated: false,
  async build(ctx) {
    const storeId = requireStore(ctx);
    const showCost = ctx.auth.can("stock.cost.read");
    const today = businessDateNow();
    const batches = await prisma.batch.findMany({
      where: { storeId, quantityOnHand: { gt: 0 } },
      orderBy: [{ expiryDate: "asc" }],
      include: { product: { include: { category: { select: { name: true } }, units: { where: { conversionToBase: 1 }, select: { name: true } } } } },
    });
    const columns: ColumnDef[] = [
      { key: "code", header: "Mã sản phẩm", width: 14 },
      { key: "name", header: "Tên sản phẩm", width: 36 },
      { key: "category", header: "Nhóm hàng", width: 20 },
      { key: "batchNumber", header: "Số lô", width: 14 },
      { key: "manufactureDate", header: "Ngày sản xuất", kind: "date", width: 13 },
      { key: "expiryDate", header: "Hạn dùng", kind: "date", width: 13 },
      { key: "daysLeft", header: "Còn (ngày)", kind: "int", width: 10 },
      { key: "quantity", header: "Tồn (đơn vị cơ bản)", kind: "int", width: 14 },
      { key: "unit", header: "Đơn vị cơ bản", width: 12 },
      { key: "status", header: "Trạng thái lô", width: 13 },
      { key: "shelf", header: "Vị trí kệ", width: 12 },
      ...(showCost
        ? [
            { key: "unitCost", header: "Giá vốn / đơn vị cơ bản", kind: "money" as const, width: 16 },
            { key: "value", header: "Giá trị tồn", kind: "money" as const, width: 16 },
          ]
        : []),
    ];
    return [
      {
        name: "Tồn kho",
        columns,
        rows: batches.map((batch) => {
          const cost = batch.unitCost === null ? null : Number(batch.unitCost);
          return {
            code: batch.product.code,
            name: batch.product.name,
            category: batch.product.category.name,
            batchNumber: batch.batchNumber,
            manufactureDate: batch.manufactureDate,
            expiryDate: batch.expiryDate,
            daysLeft: Math.round((batch.expiryDate.getTime() - today.getTime()) / 86_400_000),
            quantity: batch.quantityOnHand,
            unit: batch.product.units[0]?.name ?? "",
            status: batch.expiryDate.getTime() <= today.getTime() ? "Hết hạn" : (BATCH_STATUS[batch.status] ?? batch.status),
            shelf: batch.shelfLocation,
            unitCost: cost === null ? null : Math.round(cost),
            value: cost === null ? null : Math.round(cost * batch.quantityOnHand),
          };
        }),
      },
    ];
  },
};

/**
 * Bảng kiểm kê của đợt đang mở, để in ra đếm tay. Cố ý **không in tồn hệ
 * thống**: thấy số sẵn thì người đếm dễ chép theo thay vì đếm thật.
 */
export const stockCountExport: ExportDefinition = {
  type: "stock-count",
  title: "Bảng kiểm kê đang mở",
  permission: ["stock.read"],
  needsStore: true,
  dated: false,
  async build(ctx) {
    const storeId = requireStore(ctx);
    const count = await prisma.stockCount.findFirst({ where: { storeId, status: "COUNTING" } });
    if (!count) throw new AppError(409, "INVALID_STATE", "Cửa hàng chưa có đợt kiểm kê nào đang mở");

    const lines = await prisma.stockCountLine.findMany({
      where: { stockCountId: count.id },
      orderBy: { lineNo: "asc" },
      include: {
        batch: { select: { batchNumber: true, expiryDate: true } },
        product: { select: { code: true, name: true } },
      },
    });

    return [
      {
        name: "Bảng kiểm kê",
        columns: [
          { key: "lineNo", header: "STT", kind: "int", width: 6 },
          { key: "shelfLocation", header: "Vị trí kệ", width: 12 },
          { key: "productCode", header: "Mã sản phẩm", width: 14 },
          { key: "productName", header: "Tên sản phẩm", width: 36 },
          { key: "batchNumber", header: "Số lô", width: 14 },
          { key: "expiryDate", header: "Hạn dùng", kind: "date", width: 12 },
          { key: "unit", header: "Đơn vị đếm", width: 12 },
          { key: "counted", header: "Số đếm được", kind: "int", width: 14 },
          { key: "note", header: "Ghi chú", width: 26 },
        ],
        rows: lines.map((line) => ({
          lineNo: line.lineNo,
          shelfLocation: line.shelfLocation,
          productCode: line.product.code,
          productName: line.product.name,
          batchNumber: line.batch.batchNumber,
          expiryDate: line.batch.expiryDate,
          unit: "",
          counted: null,
          note: line.note,
        })),
      },
    ];
  },
};

export const invoicesExport: ExportDefinition = {
  type: "invoices",
  title: "Hóa đơn bán hàng",
  permission: ["invoice.read"],
  needsStore: true,
  dated: true,
  async build(ctx) {
    const storeId = requireStore(ctx);
    const invoices = await prisma.invoice.findMany({
      where: { storeId, businessDate: { gte: ctx.from, lte: ctx.to } },
      orderBy: { soldAt: "asc" },
      include: {
        customer: { select: { code: true, fullName: true } },
        seller: { select: { fullName: true } },
        prescription: { select: { code: true } },
        lines: {
          orderBy: { lineNo: "asc" },
          include: { product: { select: { code: true } }, allocations: { include: { batch: { select: { batchNumber: true, expiryDate: true } } } } },
        },
      },
    });
    return [
      {
        name: "Hóa đơn",
        columns: [
          { key: "code", header: "Số hóa đơn", width: 22 },
          { key: "soldAt", header: "Thời gian", kind: "datetime", width: 16 },
          { key: "customerCode", header: "Mã KH", width: 10 },
          { key: "customer", header: "Khách hàng", width: 24 },
          { key: "prescription", header: "Đơn thuốc", width: 18 },
          { key: "seller", header: "Người bán", width: 20 },
          { key: "subtotal", header: "Tiền hàng", kind: "money", width: 14 },
          { key: "discount", header: "Giảm giá", kind: "money", width: 12 },
          { key: "vat", header: "Trong đó VAT", kind: "money", width: 12 },
          { key: "total", header: "Tổng thanh toán", kind: "money", width: 15 },
          { key: "payment", header: "Hình thức", width: 13 },
          { key: "status", header: "Trạng thái", width: 12 },
        ],
        rows: invoices.map((invoice) => ({
          code: invoice.code,
          soldAt: vnTime(invoice.soldAt),
          customerCode: invoice.customer?.code ?? null,
          customer: invoice.customer?.fullName ?? "Khách lẻ",
          prescription: invoice.prescription?.code ?? null,
          seller: invoice.seller.fullName,
          subtotal: num(invoice.subtotal),
          discount: num(invoice.discountAmount),
          vat: num(invoice.vatAmount),
          total: num(invoice.totalAmount),
          payment: PAYMENT[invoice.paymentMethod] ?? invoice.paymentMethod,
          status: invoice.status === "VOIDED" ? "Đã hủy" : "Hoàn tất",
        })),
      },
      {
        name: "Chi tiết",
        columns: [
          { key: "code", header: "Số hóa đơn", width: 22 },
          { key: "date", header: "Ngày", kind: "date", width: 12 },
          { key: "productCode", header: "Mã sản phẩm", width: 13 },
          { key: "productName", header: "Tên thuốc", width: 34 },
          { key: "unit", header: "Đơn vị", width: 9 },
          { key: "quantity", header: "Số lượng", kind: "int", width: 9 },
          { key: "unitPrice", header: "Đơn giá", kind: "money", width: 12 },
          { key: "lineTotal", header: "Thành tiền", kind: "money", width: 13 },
          { key: "batches", header: "Lô xuất (FEFO)", width: 22 },
          { key: "status", header: "Trạng thái", width: 11 },
        ],
        rows: invoices.flatMap((invoice) =>
          invoice.lines.map((line) => ({
            code: invoice.code,
            date: invoice.businessDate,
            productCode: line.product.code,
            productName: line.productName,
            unit: line.unitName,
            quantity: line.quantity,
            unitPrice: num(line.unitPrice),
            lineTotal: num(line.lineTotal),
            batches: line.allocations.map((item) => item.batch.batchNumber).join(", "),
            status: invoice.status === "VOIDED" ? "Đã hủy" : "Hoàn tất",
          })),
        ),
      },
    ];
  },
};

export const rxSalesExport: ExportDefinition = {
  type: "rx-sales",
  title: "Sổ theo dõi bán thuốc kê đơn",
  permission: ["prescription.read"],
  needsStore: true,
  dated: true,
  async build(ctx) {
    const storeId = requireStore(ctx);
    const lines = await prisma.invoiceLine.findMany({
      where: {
        invoice: { storeId, status: "COMPLETED", businessDate: { gte: ctx.from, lte: ctx.to } },
        product: { drugClass: { in: ["RX", "CONTROLLED"] } },
      },
      orderBy: [{ invoice: { soldAt: "asc" } }, { lineNo: "asc" }],
      include: {
        product: { select: { code: true, drugClass: true, ingredients: { include: { ingredient: { select: { name: true } } } } } },
        allocations: { include: { batch: { select: { batchNumber: true, expiryDate: true } } } },
        invoice: {
          select: {
            code: true,
            soldAt: true,
            customer: { select: { fullName: true, birthYear: true } },
            seller: { select: { fullName: true } },
            pharmacist: { select: { fullName: true } },
            prescription: { select: { code: true, externalCode: true, prescriberName: true, facilityName: true, prescribedDate: true, diagnosisText: true } },
          },
        },
      },
    });
    return [
      {
        name: "Bán thuốc kê đơn",
        columns: [
          { key: "soldAt", header: "Thời gian bán", kind: "datetime", width: 16 },
          { key: "invoice", header: "Số hóa đơn", width: 22 },
          { key: "patient", header: "Người bệnh", width: 22 },
          { key: "birthYear", header: "Năm sinh", kind: "int", width: 9 },
          { key: "prescription", header: "Mã đơn thuốc", width: 16 },
          { key: "externalCode", header: "Mã đơn điện tử", width: 16 },
          { key: "prescribedDate", header: "Ngày kê đơn", kind: "date", width: 12 },
          { key: "prescriber", header: "Người kê đơn", width: 20 },
          { key: "facility", header: "Cơ sở khám chữa bệnh", width: 24 },
          { key: "diagnosis", header: "Chẩn đoán", width: 24 },
          { key: "productCode", header: "Mã thuốc", width: 11 },
          { key: "productName", header: "Tên thuốc", width: 30 },
          { key: "ingredients", header: "Hoạt chất", width: 20 },
          { key: "drugClass", header: "Phân loại", width: 16 },
          { key: "quantity", header: "Số lượng", kind: "int", width: 9 },
          { key: "unit", header: "Đơn vị", width: 9 },
          { key: "batches", header: "Số lô", width: 16 },
          { key: "expiry", header: "Hạn dùng", width: 14 },
          { key: "dispenser", header: "Người bán / dược sĩ", width: 22 },
        ],
        rows: lines.map((line) => {
          const rx = line.invoice.prescription;
          return {
            soldAt: vnTime(line.invoice.soldAt),
            invoice: line.invoice.code,
            patient: line.invoice.customer?.fullName ?? null,
            birthYear: line.invoice.customer?.birthYear ?? null,
            prescription: rx?.code ?? "(không có đơn)",
            externalCode: rx?.externalCode ?? null,
            prescribedDate: rx?.prescribedDate ?? null,
            prescriber: rx?.prescriberName ?? null,
            facility: rx?.facilityName ?? null,
            diagnosis: rx?.diagnosisText ?? null,
            productCode: line.product.code,
            productName: line.productName,
            ingredients: line.product.ingredients.map((item) => item.ingredient.name).join("; "),
            drugClass: DRUG_CLASS_LABEL[line.product.drugClass ?? ""] ?? "",
            quantity: line.quantity,
            unit: line.unitName,
            batches: line.allocations.map((item) => item.batch.batchNumber).join(", "),
            expiry: line.allocations.map((item) => item.batch.expiryDate.toISOString().slice(0, 10).split("-").reverse().join("/")).join(", "),
            dispenser: line.invoice.pharmacist?.fullName ?? line.invoice.seller.fullName,
          };
        }),
      },
    ];
  },
};

/**
 * Sổ theo dõi thuốc kiểm soát đặc biệt: một sheet tổng hợp số dư và một
 * sheet chi tiết từng lần xuất nhập kèm người mua, đơn thuốc, người kê.
 */
export const controlledLedgerExport: ExportDefinition = {
  type: "controlled-ledger",
  title: "Sổ thuốc kiểm soát đặc biệt",
  permission: ["controlled.read"],
  needsStore: true,
  dated: true,
  audited: true,
  async build(ctx) {
    const storeId = requireStore(ctx);
    const ledger = await buildLedger({ storeId, from: ctx.from, to: ctx.to });

    return [
      {
        name: "Tổng hợp",
        columns: [
          { key: "code", header: "Mã thuốc", width: 12 },
          { key: "name", header: "Tên thuốc", width: 34 },
          { key: "strengthText", header: "Hàm lượng", width: 12 },
          { key: "baseUnitName", header: "Đơn vị", width: 10 },
          { key: "openingBalance", header: "Tồn đầu kỳ", kind: "int", width: 12 },
          { key: "totalIn", header: "Nhập trong kỳ", kind: "int", width: 13 },
          { key: "totalOut", header: "Xuất trong kỳ", kind: "int", width: 13 },
          { key: "closingBalance", header: "Tồn cuối kỳ", kind: "int", width: 12 },
          { key: "stockOnHand", header: "Tồn kho hiện tại", kind: "int", width: 15 },
        ],
        rows: ledger.map((product) => ({
          code: product.code,
          name: product.name,
          strengthText: product.strengthText,
          baseUnitName: product.baseUnitName,
          openingBalance: product.openingBalance,
          totalIn: product.totalIn,
          totalOut: product.totalOut,
          closingBalance: product.closingBalance,
          stockOnHand: product.stockOnHand,
        })),
      },
      {
        name: "Chi tiết",
        columns: [
          { key: "productName", header: "Tên thuốc", width: 30 },
          { key: "occurredAt", header: "Thời gian", kind: "datetime", width: 16 },
          { key: "documentCode", header: "Số chứng từ", width: 22 },
          { key: "description", header: "Diễn giải", width: 22 },
          { key: "inQuantity", header: "Nhập", kind: "int", width: 8 },
          { key: "outQuantity", header: "Xuất", kind: "int", width: 8 },
          { key: "balanceAfter", header: "Tồn sau", kind: "int", width: 10 },
          { key: "batchNumber", header: "Số lô", width: 14 },
          { key: "expiryDate", header: "Hạn dùng", kind: "date", width: 12 },
          { key: "partyName", header: "Người bệnh / nhà cung cấp", width: 26 },
          { key: "buyerName", header: "Người mua", width: 22 },
          { key: "buyerIdNumber", header: "Số giấy tờ tùy thân", width: 18 },
          { key: "buyerAddress", header: "Địa chỉ người mua", width: 32 },
          { key: "relationship", header: "Quan hệ với người bệnh", width: 18 },
          { key: "prescriptionCode", header: "Đơn thuốc", width: 16 },
          { key: "prescriberName", header: "Người kê đơn", width: 20 },
          { key: "facilityName", header: "Cơ sở khám chữa bệnh", width: 24 },
          { key: "handledBy", header: "Người thực hiện", width: 20 },
        ],
        rows: ledger.flatMap((product) =>
          product.entries.map((entry) => ({ ...entry, productName: product.name, occurredAt: vnTime(entry.occurredAt) })),
        ),
      },
    ];
  },
};

export const goodsReceiptsExport: ExportDefinition = {
  type: "goods-receipts",
  title: "Phiếu nhập hàng",
  permission: ["goods_receipt.read"],
  needsStore: true,
  dated: true,
  async build(ctx) {
    const storeId = requireStore(ctx);
    const receipts = await prisma.goodsReceipt.findMany({
      where: { storeId, receivedAt: { gte: vnStart(ctx.from), lt: vnStart(new Date(ctx.to.getTime() + 86_400_000)) } },
      orderBy: { receivedAt: "asc" },
      include: {
        supplier: { select: { name: true, taxCode: true } },
        createdByUser: { select: { fullName: true } },
        confirmedByUser: { select: { fullName: true } },
        lines: { orderBy: { lineNo: "asc" }, include: { product: { select: { code: true, name: true } }, productUnit: { select: { name: true } } } },
      },
    });
    return [
      {
        name: "Phiếu nhập",
        columns: [
          { key: "code", header: "Số phiếu", width: 22 },
          { key: "receivedAt", header: "Thời gian nhận", kind: "datetime", width: 16 },
          { key: "type", header: "Loại", width: 13 },
          { key: "supplier", header: "Nhà cung cấp", width: 30 },
          { key: "taxCode", header: "MST NCC", width: 14 },
          { key: "invoiceNumber", header: "Số HĐ NCC", width: 13 },
          { key: "invoiceDate", header: "Ngày HĐ NCC", kind: "date", width: 12 },
          { key: "goods", header: "Tiền hàng", kind: "money", width: 14 },
          { key: "discount", header: "Chiết khấu", kind: "money", width: 12 },
          { key: "vat", header: "Thuế GTGT", kind: "money", width: 12 },
          { key: "total", header: "Tổng cộng", kind: "money", width: 14 },
          { key: "status", header: "Trạng thái", width: 13 },
          { key: "createdBy", header: "Người lập", width: 18 },
          { key: "confirmedBy", header: "Người kiểm nhập", width: 18 },
        ],
        rows: receipts.map((receipt) => ({
          code: receipt.code,
          receivedAt: vnTime(receipt.receivedAt),
          type: receipt.type === "OPENING_BALANCE" ? "Tồn đầu kỳ" : "Mua hàng",
          supplier: receipt.supplier?.name ?? null,
          taxCode: receipt.supplier?.taxCode ?? null,
          invoiceNumber: receipt.supplierInvoiceNumber,
          invoiceDate: receipt.supplierInvoiceDate,
          goods: num(receipt.goodsAmount),
          discount: num(receipt.discountAmount),
          vat: num(receipt.vatAmount),
          total: num(receipt.totalCost),
          status: RECEIPT_STATUS[receipt.status] ?? receipt.status,
          createdBy: receipt.createdByUser.fullName,
          confirmedBy: receipt.confirmedByUser?.fullName ?? null,
        })),
      },
      {
        name: "Chi tiết",
        columns: [
          { key: "code", header: "Số phiếu", width: 22 },
          { key: "productCode", header: "Mã sản phẩm", width: 13 },
          { key: "productName", header: "Tên sản phẩm", width: 32 },
          { key: "unit", header: "Đơn vị", width: 9 },
          { key: "quantity", header: "Số lượng", kind: "int", width: 9 },
          { key: "unitCost", header: "Đơn giá nhập", kind: "money", width: 13 },
          { key: "lineCost", header: "Thành tiền", kind: "money", width: 13 },
          { key: "batchNumber", header: "Số lô", width: 14 },
          { key: "manufactureDate", header: "Ngày sản xuất", kind: "date", width: 13 },
          { key: "expiryDate", header: "Hạn dùng", kind: "date", width: 13 },
        ],
        rows: receipts.flatMap((receipt) =>
          receipt.lines.map((line) => ({
            code: receipt.code,
            productCode: line.product.code,
            productName: line.product.name,
            unit: line.productUnit.name,
            quantity: line.quantity,
            unitCost: num(line.unitCost),
            lineCost: num(line.lineCost),
            batchNumber: line.batchNumber,
            manufactureDate: line.manufactureDate,
            expiryDate: line.expiryDate,
          })),
        ),
      },
    ];
  },
};
