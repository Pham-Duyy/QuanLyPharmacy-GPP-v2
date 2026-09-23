import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";

/**
 * Sổ theo dõi thuốc kiểm soát đặc biệt (gây nghiện, hướng thần, tiền chất).
 *
 * Sổ được **sinh lại từ thẻ kho** mỗi lần xem, không phải một bảng ghi tay
 * song song: nhờ vậy sổ không bao giờ lệch với tồn kho thật, và không ai sửa
 * được sổ mà không để lại chứng từ.
 */

const MOVEMENT_LABEL: Record<string, string> = {
  OPENING_BALANCE: "Tồn đầu kỳ",
  RECEIPT: "Nhập từ nhà cung cấp",
  SALE: "Bán theo đơn",
  SALE_VOID: "Hủy hóa đơn, nhập lại",
  CUSTOMER_RETURN: "Khách trả lại",
  ADJUSTMENT: "Điều chỉnh sau kiểm kê",
  DISPOSAL: "Xuất hủy",
};

const RELATIONSHIP_LABEL: Record<string, string> = {
  SELF: "Chính người bệnh",
  RELATIVE: "Người nhà",
  CAREGIVER: "Người chăm sóc",
  OTHER: "Khác",
};

export type LedgerEntry = {
  occurredAt: Date;
  documentCode: string;
  documentType: string;
  description: string;
  inQuantity: number;
  outQuantity: number;
  balanceAfter: number;
  batchNumber: string;
  expiryDate: Date;
  /** Người bệnh trên đơn thuốc, hoặc nhà cung cấp khi nhập hàng. */
  partyName: string | null;
  buyerName: string | null;
  buyerIdNumber: string | null;
  buyerAddress: string | null;
  relationship: string | null;
  prescriptionCode: string | null;
  prescriberName: string | null;
  facilityName: string | null;
  handledBy: string | null;
};

export type LedgerProduct = {
  productId: string;
  code: string;
  name: string;
  strengthText: string | null;
  baseUnitName: string;
  openingBalance: number;
  totalIn: number;
  totalOut: number;
  closingBalance: number;
  /** Tồn kho thật hiện nay; phải khớp số cuối kỳ khi kỳ kết thúc ở hôm nay. */
  stockOnHand: number;
  entries: LedgerEntry[];
};

export type LedgerQuery = { storeId: string; from: Date; to: Date; productId?: string | undefined };

/** Danh sách thuốc kiểm soát đặc biệt có phát sinh hoặc đang còn tồn tại cửa hàng. */
export async function listControlledProducts(storeId: string) {
  const products = await prisma.product.findMany({
    where: { drugClass: "CONTROLLED" },
    orderBy: { name: "asc" },
    include: {
      units: { where: { conversionToBase: 1 }, select: { name: true } },
      batches: { where: { storeId }, select: { quantityOnHand: true } },
    },
  });
  return products.map((product) => ({
    id: product.id,
    code: product.code,
    name: product.name,
    strengthText: product.strengthText,
    baseUnitName: product.units[0]?.name ?? "",
    isActive: product.isActive,
    stockOnHand: product.batches.reduce((sum, batch) => sum + batch.quantityOnHand, 0),
  }));
}

/**
 * Dựng sổ cho từng thuốc trong kỳ. Số dư đầu kỳ tính bằng tổng mọi bút toán
 * trước ngày bắt đầu, nên kỳ nào cũng có số mang sang đúng như sổ giấy.
 */
export async function buildLedger(query: LedgerQuery): Promise<LedgerProduct[]> {
  const { storeId, from, to } = query;
  const products = await prisma.product.findMany({
    where: { drugClass: "CONTROLLED", ...(query.productId ? { id: query.productId } : {}) },
    orderBy: { name: "asc" },
    include: {
      units: { where: { conversionToBase: 1 }, select: { name: true } },
      batches: { where: { storeId }, select: { quantityOnHand: true } },
    },
  });
  if (products.length === 0) return [];

  const productIds = products.map((product) => product.id);
  // Giờ Việt Nam: kỳ tính từ 00:00 ngày bắt đầu tới hết 23:59 ngày kết thúc.
  const start = new Date(from.getTime() - 7 * 3_600_000);
  const end = new Date(to.getTime() + 86_400_000 - 7 * 3_600_000);

  const [before, movements] = await Promise.all([
    prisma.stockMovement.groupBy({
      by: ["productId"],
      where: { storeId, productId: { in: productIds }, occurredAt: { lt: start } },
      _sum: { baseQuantity: true },
    }),
    prisma.stockMovement.findMany({
      where: { storeId, productId: { in: productIds }, occurredAt: { gte: start, lt: end } },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      include: { batch: { select: { batchNumber: true, expiryDate: true } }, user: { select: { fullName: true } } },
    }),
  ]);

  const documents = await loadDocuments(movements.map((movement) => ({ sourceType: movement.sourceType, sourceId: movement.sourceId })));
  const openingByProduct = new Map(before.map((row) => [row.productId, row._sum.baseQuantity ?? 0]));

  return products.map((product) => {
    const opening = openingByProduct.get(product.id) ?? 0;
    let balance = opening;
    let totalIn = 0;
    let totalOut = 0;

    const entries = movements
      .filter((movement) => movement.productId === product.id)
      .map((movement) => {
        balance += movement.baseQuantity;
        if (movement.baseQuantity > 0) totalIn += movement.baseQuantity;
        else totalOut += -movement.baseQuantity;
        const document = documents.get(`${movement.sourceType}:${movement.sourceId}`);
        return {
          occurredAt: movement.occurredAt,
          documentCode: document?.code ?? "—",
          documentType: movement.sourceType,
          description: MOVEMENT_LABEL[movement.type] ?? movement.type,
          inQuantity: movement.baseQuantity > 0 ? movement.baseQuantity : 0,
          outQuantity: movement.baseQuantity < 0 ? -movement.baseQuantity : 0,
          balanceAfter: balance,
          batchNumber: movement.batch.batchNumber,
          expiryDate: movement.batch.expiryDate,
          partyName: document?.partyName ?? null,
          buyerName: document?.buyerName ?? null,
          buyerIdNumber: document?.buyerIdNumber ?? null,
          buyerAddress: document?.buyerAddress ?? null,
          relationship: document?.relationship ?? null,
          prescriptionCode: document?.prescriptionCode ?? null,
          prescriberName: document?.prescriberName ?? null,
          facilityName: document?.facilityName ?? null,
          handledBy: movement.user?.fullName ?? null,
        } satisfies LedgerEntry;
      });

    return {
      productId: product.id,
      code: product.code,
      name: product.name,
      strengthText: product.strengthText,
      baseUnitName: product.units[0]?.name ?? "",
      openingBalance: opening,
      totalIn,
      totalOut,
      closingBalance: balance,
      stockOnHand: product.batches.reduce((sum, batch) => sum + batch.quantityOnHand, 0),
      entries,
    };
  });
}

type DocumentInfo = {
  code: string;
  partyName: string | null;
  buyerName: string | null;
  buyerIdNumber: string | null;
  buyerAddress: string | null;
  relationship: string | null;
  prescriptionCode: string | null;
  prescriberName: string | null;
  facilityName: string | null;
};

/** Lấy một lượt thông tin chứng từ gốc của các bút toán, tránh N+1 truy vấn. */
async function loadDocuments(sources: Array<{ sourceType: string; sourceId: string }>): Promise<Map<string, DocumentInfo>> {
  const byType = new Map<string, Set<string>>();
  for (const source of sources) {
    const bucket = byType.get(source.sourceType) ?? new Set<string>();
    bucket.add(source.sourceId);
    byType.set(source.sourceType, bucket);
  }
  const result = new Map<string, DocumentInfo>();

  const invoiceIds = [...(byType.get("INVOICE") ?? [])];
  if (invoiceIds.length > 0) {
    const invoices = await prisma.invoice.findMany({
      where: { id: { in: invoiceIds } },
      include: {
        customer: { select: { fullName: true } },
        controlledSale: true,
        prescription: { select: { code: true, prescriberName: true, facilityName: true } },
      },
    });
    for (const invoice of invoices) {
      result.set(`INVOICE:${invoice.id}`, {
        code: invoice.code,
        partyName: invoice.customer?.fullName ?? null,
        buyerName: invoice.controlledSale?.buyerName ?? null,
        buyerIdNumber: invoice.controlledSale?.buyerIdNumber ?? null,
        buyerAddress: invoice.controlledSale?.buyerAddress ?? null,
        relationship: invoice.controlledSale ? (RELATIONSHIP_LABEL[invoice.controlledSale.relationship] ?? invoice.controlledSale.relationship) : null,
        prescriptionCode: invoice.prescription?.code ?? null,
        prescriberName: invoice.prescription?.prescriberName ?? null,
        facilityName: invoice.prescription?.facilityName ?? null,
      });
    }
  }

  const receiptIds = [...(byType.get("GOODS_RECEIPT") ?? [])];
  if (receiptIds.length > 0) {
    const receipts = await prisma.goodsReceipt.findMany({ where: { id: { in: receiptIds } }, include: { supplier: { select: { name: true } } } });
    for (const receipt of receipts) {
      result.set(`GOODS_RECEIPT:${receipt.id}`, {
        code: receipt.code,
        partyName: receipt.supplier?.name ?? (receipt.type === "OPENING_BALANCE" ? "Tồn đầu kỳ" : null),
        buyerName: null,
        buyerIdNumber: null,
        buyerAddress: null,
        relationship: null,
        prescriptionCode: null,
        prescriberName: null,
        facilityName: null,
      });
    }
  }

  const returnIds = [...(byType.get("RETURN") ?? [])];
  if (returnIds.length > 0) {
    const returns = await prisma.return.findMany({ where: { id: { in: returnIds } }, include: { invoice: { select: { code: true, customer: { select: { fullName: true } } } } } });
    for (const item of returns) {
      result.set(`RETURN:${item.id}`, {
        code: item.code,
        partyName: item.invoice.customer?.fullName ?? `Trả từ ${item.invoice.code}`,
        buyerName: null,
        buyerIdNumber: null,
        buyerAddress: null,
        relationship: null,
        prescriptionCode: null,
        prescriberName: null,
        facilityName: null,
      });
    }
  }

  const adjustmentIds = [...(byType.get("STOCK_ADJUSTMENT") ?? [])];
  if (adjustmentIds.length > 0) {
    const adjustments = await prisma.stockAdjustment.findMany({ where: { id: { in: adjustmentIds } }, include: { approvedByUser: { select: { fullName: true } } } });
    for (const adjustment of adjustments) {
      result.set(`STOCK_ADJUSTMENT:${adjustment.id}`, {
        code: adjustment.code,
        partyName: adjustment.reason,
        buyerName: null,
        buyerIdNumber: null,
        buyerAddress: null,
        relationship: null,
        prescriptionCode: null,
        prescriberName: null,
        facilityName: null,
      });
    }
  }

  return result;
}

/** Kiểm tra sổ khớp kho: dùng khi xem sổ tới hôm nay hoặc khi thanh tra hỏi. */
export function reconcile(ledger: LedgerProduct[], periodEndsToday: boolean) {
  return ledger
    .filter((product) => periodEndsToday && product.closingBalance !== product.stockOnHand)
    .map((product) => ({ productId: product.productId, name: product.name, closingBalance: product.closingBalance, stockOnHand: product.stockOnHand }));
}

export function requireControlledAccess(canRead: boolean): void {
  if (!canRead) throw new AppError(403, "FORBIDDEN", "Bạn không có quyền xem sổ thuốc kiểm soát đặc biệt");
}
