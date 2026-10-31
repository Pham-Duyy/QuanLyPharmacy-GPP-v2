import { prisma } from "../../db/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";
import { codeDay, nextDocumentCode } from "../../lib/document-code.js";
import { num } from "../../lib/numbers.js";
import type {
  CreatePurchaseOrderInput,
  PatchPurchaseOrderInput,
  PurchaseOrderStatus,
} from "./purchase-orders.schema.js";

/**
 * Đơn đặt hàng gửi nhà cung cấp (Phase 7, D32).
 *
 * Nháp → Đã gửi → Nhận một phần / Đã nhận đủ; hoặc Đã hủy. Số đã nhận không
 * lưu riêng mà tính từ phiếu nhập **đã xác nhận** lập từ đơn, chỉ dòng kiểm
 * nhập đạt — nên không thể lệch với tồn kho.
 */

type Tx = Prisma.TransactionClient;
type LineInput = CreatePurchaseOrderInput["lines"][number];

type ResolvedLine = {
  lineNo: number;
  productId: string;
  productUnitId: string;
  quantity: number;
  baseQuantity: number;
  unitPrice: bigint | null;
};

async function resolveLines(tx: Tx, lines: LineInput[]): Promise<ResolvedLine[]> {
  const units = await tx.productUnit.findMany({
    where: { id: { in: lines.map((line) => line.unitId) } },
    include: { product: { select: { id: true, name: true, isActive: true } } },
  });
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  return lines.map((line, index) => {
    const unit = byId.get(line.unitId);
    if (!unit || unit.productId !== line.productId)
      throw new AppError(
        422,
        "UNIT_NOT_IN_PRODUCT",
        `Dòng ${index + 1}: đơn vị không thuộc sản phẩm`,
      );
    if (!unit.product.isActive)
      throw AppError.validation(`Dòng ${index + 1}: ${unit.product.name} đã ngừng kinh doanh`);
    return {
      lineNo: index + 1,
      productId: line.productId,
      productUnitId: line.unitId,
      quantity: line.quantity,
      baseQuantity: line.quantity * unit.conversionToBase,
      unitPrice:
        line.unitPrice === null || line.unitPrice === undefined ? null : BigInt(line.unitPrice),
    };
  });
}

function estimate(lines: ResolvedLine[]): bigint {
  return lines.reduce(
    (sum, line) => sum + (line.unitPrice === null ? 0n : line.unitPrice * BigInt(line.quantity)),
    0n,
  );
}

async function assertSupplier(tx: Tx, supplierId: string) {
  const supplier = await tx.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) throw AppError.validation("Nhà cung cấp không tồn tại");
  if (!supplier.isActive)
    throw AppError.validation(`Nhà cung cấp "${supplier.name}" đang ngừng giao dịch`);
}

async function insertOrder(
  tx: Tx,
  storeId: string,
  storeCode: string,
  userId: string,
  input: CreatePurchaseOrderInput,
): Promise<string> {
  await assertSupplier(tx, input.supplierId);
  const lines = await resolveLines(tx, input.lines);
  const created = await tx.purchaseOrder.create({
    data: {
      storeId,
      code: await nextDocumentCode(tx, storeId, `DH-${storeCode}-${codeDay()}-`),
      supplierId: input.supplierId,
      expectedDate: input.expectedDate ?? null,
      note: input.note ?? null,
      estimatedAmount: estimate(lines),
      createdBy: userId,
      lines: { create: lines },
    },
  });
  return created.id;
}

export async function create(
  storeId: string,
  userId: string,
  input: CreatePurchaseOrderInput,
): Promise<string> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
  return prisma.$transaction((tx) => insertOrder(tx, storeId, store.code, userId, input));
}

/** Từ trang Đề xuất đặt hàng: gom theo nhà cung cấp, mỗi nhà cung cấp một đơn nháp. */
export async function createFromSuggestions(
  storeId: string,
  userId: string,
  items: Array<LineInput & { supplierId: string }>,
): Promise<string[]> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
  const bySupplier = new Map<string, LineInput[]>();
  for (const { supplierId, ...line } of items) {
    const group = bySupplier.get(supplierId) ?? [];
    if (group.some((existing) => existing.productId === line.productId))
      throw AppError.validation("Một mặt hàng được chọn hai lần cho cùng nhà cung cấp");
    group.push(line);
    bySupplier.set(supplierId, group);
  }
  return prisma.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const [supplierId, lines] of bySupplier) {
      ids.push(await insertOrder(tx, storeId, store.code, userId, { supplierId, lines }));
    }
    return ids;
  });
}

export async function update(
  storeId: string,
  id: string,
  input: PatchPurchaseOrderInput,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const order = await tx.purchaseOrder.findFirst({ where: { id, storeId } });
    if (!order) throw AppError.notFound("Không tìm thấy đơn đặt hàng");
    if (order.status !== "DRAFT")
      throw AppError.invalidState("Chỉ sửa được đơn còn nháp; đơn đã gửi thì hủy và lập đơn mới");
    if (order.version !== input.version)
      throw new AppError(409, "VERSION_CONFLICT", "Đơn vừa được sửa ở nơi khác, hãy tải lại");
    if (input.supplierId) await assertSupplier(tx, input.supplierId);
    const lines = input.lines ? await resolveLines(tx, input.lines) : null;
    if (lines) await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id } });
    await tx.purchaseOrder.update({
      where: { id },
      data: {
        ...(input.supplierId ? { supplierId: input.supplierId } : {}),
        ...(input.expectedDate !== undefined ? { expectedDate: input.expectedDate } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(lines ? { estimatedAmount: estimate(lines), lines: { create: lines } } : {}),
        version: { increment: 1 },
      },
    });
  });
}

/** Đánh dấu đã gửi. Email gửi xong mới gọi; gửi lỗi thì đơn vẫn là nháp. */
export async function markSent(
  storeId: string,
  id: string,
  userId: string,
  via: "EMAIL" | "MANUAL",
  to: string | null,
): Promise<void> {
  const moved = await prisma.purchaseOrder.updateMany({
    where: { id, storeId, status: "DRAFT" },
    data: {
      status: "SENT",
      sentAt: new Date(),
      sentBy: userId,
      sentVia: via,
      sentTo: to,
      version: { increment: 1 },
    },
  });
  if (moved.count === 1) return;
  const order = await prisma.purchaseOrder.findFirst({ where: { id, storeId } });
  if (!order) throw AppError.notFound("Không tìm thấy đơn đặt hàng");
  // Gửi lại email cho đơn đã gửi: ghi nhận người nhận mới, giữ trạng thái.
  if (via === "EMAIL" && order.status !== "CANCELLED") {
    await prisma.purchaseOrder.update({
      where: { id },
      data: { sentTo: to, sentVia: via, version: { increment: 1 } },
    });
    return;
  }
  throw AppError.invalidState("Đơn đã gửi rồi");
}

export async function cancel(
  storeId: string,
  id: string,
  userId: string,
  reason: string,
): Promise<void> {
  const moved = await prisma.purchaseOrder.updateMany({
    where: { id, storeId, status: { in: ["DRAFT", "SENT", "PARTIAL"] } },
    data: {
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancelledBy: userId,
      cancelReason: reason,
      version: { increment: 1 },
    },
  });
  if (moved.count === 1) return;
  const order = await prisma.purchaseOrder.findFirst({ where: { id, storeId } });
  if (!order) throw AppError.notFound("Không tìm thấy đơn đặt hàng");
  throw AppError.invalidState(
    order.status === "RECEIVED" ? "Đơn đã nhận đủ hàng, không hủy được" : "Đơn đã hủy rồi",
  );
}

/** Số đã nhận (đơn vị nhỏ nhất) theo sản phẩm, từ phiếu nhập đã xác nhận, dòng đạt kiểm nhập. */
async function receivedByProduct(tx: Tx, orderId: string): Promise<Map<string, number>> {
  const rows = await tx.goodsReceiptLine.groupBy({
    by: ["productId"],
    where: {
      passed: true,
      goodsReceipt: { purchaseOrderId: orderId, status: "CONFIRMED" },
    },
    _sum: { baseQuantity: true },
  });
  return new Map(rows.map((row) => [row.productId, row._sum.baseQuantity ?? 0]));
}

/**
 * Tính lại trạng thái sau khi một phiếu nhập gắn với đơn được xác nhận. Gọi
 * trong giao dịch xác nhận phiếu. Đơn đã hủy giữ nguyên.
 */
export async function refreshStatus(tx: Tx, orderId: string): Promise<void> {
  const order = await tx.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { lines: true },
  });
  if (!order || order.status === "CANCELLED" || order.status === "DRAFT") return;
  const received = await receivedByProduct(tx, orderId);
  const anyReceived = [...received.values()].some((value) => value > 0);
  const allReceived = order.lines.every(
    (line) => (received.get(line.productId) ?? 0) >= line.baseQuantity,
  );
  const status: PurchaseOrderStatus = allReceived ? "RECEIVED" : anyReceived ? "PARTIAL" : "SENT";
  if (status !== order.status)
    await tx.purchaseOrder.update({
      where: { id: orderId },
      data: { status, version: { increment: 1 } },
    });
}

/** Kiểm tra đơn khi lập phiếu nhập từ đơn: đúng cửa hàng, đã gửi, đúng nhà cung cấp. */
export async function assertReceivable(
  tx: Tx,
  storeId: string,
  orderId: string,
  supplierId: string,
): Promise<void> {
  const order = await tx.purchaseOrder.findFirst({ where: { id: orderId, storeId } });
  if (!order) throw AppError.validation("Đơn đặt hàng không tồn tại ở cửa hàng này");
  if (order.status !== "SENT" && order.status !== "PARTIAL")
    throw AppError.invalidState("Chỉ lập phiếu nhập từ đơn đã gửi và chưa nhận đủ");
  if (order.supplierId !== supplierId)
    throw AppError.validation("Nhà cung cấp của phiếu nhập khác nhà cung cấp của đơn đặt hàng");
}

export async function getDetail(storeId: string, id: string) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id, storeId },
    include: {
      supplier: true,
      store: { select: { code: true, name: true, address: true, phone: true } },
      createdByUser: { select: { fullName: true } },
      sentByUser: { select: { fullName: true } },
      cancelledByUser: { select: { fullName: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          product: { select: { code: true, name: true } },
          productUnit: { select: { name: true, conversionToBase: true } },
        },
      },
      goodsReceipts: {
        orderBy: { createdAt: "asc" },
        select: { id: true, code: true, status: true, receivedAt: true, totalCost: true },
      },
    },
  });
  if (!order) throw AppError.notFound("Không tìm thấy đơn đặt hàng");
  const received = await receivedByProduct(prisma, id);
  const baseUnits = await prisma.productUnit.findMany({
    where: { productId: { in: order.lines.map((line) => line.productId) }, conversionToBase: 1 },
    select: { productId: true, name: true },
  });
  const baseName = new Map(baseUnits.map((unit) => [unit.productId, unit.name]));

  return {
    id: order.id,
    code: order.code,
    status: order.status as PurchaseOrderStatus,
    store: order.store,
    supplier: {
      id: order.supplier.id,
      name: order.supplier.name,
      taxCode: order.supplier.taxCode,
      phone: order.supplier.phone,
      email: order.supplier.email,
      address: order.supplier.address,
    },
    expectedDate: order.expectedDate,
    note: order.note,
    estimatedAmount: num(order.estimatedAmount),
    createdAt: order.createdAt,
    createdBy: order.createdByUser,
    sentAt: order.sentAt,
    sentBy: order.sentByUser,
    sentVia: order.sentVia,
    sentTo: order.sentTo,
    cancelledAt: order.cancelledAt,
    cancelledBy: order.cancelledByUser,
    cancelReason: order.cancelReason,
    version: order.version,
    lines: order.lines.map((line) => {
      const receivedBase = received.get(line.productId) ?? 0;
      const remainingBase = Math.max(line.baseQuantity - receivedBase, 0);
      return {
        id: line.id,
        lineNo: line.lineNo,
        productId: line.productId,
        productCode: line.product.code,
        productName: line.product.name,
        unitId: line.productUnitId,
        unitName: line.productUnit.name,
        conversionToBase: line.productUnit.conversionToBase,
        baseUnitName: baseName.get(line.productId) ?? line.productUnit.name,
        quantity: line.quantity,
        baseQuantity: line.baseQuantity,
        unitPrice: line.unitPrice === null ? null : num(line.unitPrice),
        lineAmount: line.unitPrice === null ? null : num(line.unitPrice) * line.quantity,
        receivedBaseQuantity: receivedBase,
        remainingBaseQuantity: remainingBase,
        /** Số còn thiếu quy về đơn vị đặt, làm tròn lên để điền sẵn phiếu nhập. */
        remainingQuantity: Math.ceil(remainingBase / line.productUnit.conversionToBase),
      };
    }),
    goodsReceipts: order.goodsReceipts.map((receipt) => ({
      ...receipt,
      totalCost: num(receipt.totalCost),
    })),
  };
}

export type PurchaseOrderDetail = Awaited<ReturnType<typeof getDetail>>;

export async function list(
  storeId: string,
  query: {
    status?: string | undefined;
    supplierId?: string | undefined;
    search?: string | undefined;
    skip: number;
    take: number;
  },
) {
  const where: Prisma.PurchaseOrderWhereInput = {
    storeId,
    ...(query.status ? { status: { in: query.status.split(",") } } : {}),
    ...(query.supplierId ? { supplierId: query.supplierId } : {}),
    ...(query.search
      ? {
          OR: [
            { code: { contains: query.search, mode: "insensitive" } },
            { supplier: { name: { contains: query.search, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: query.skip,
      take: query.take,
      include: {
        supplier: { select: { name: true } },
        _count: { select: { lines: true } },
      },
    }),
    prisma.purchaseOrder.count({ where }),
  ]);
  return {
    items: items.map((order) => ({
      id: order.id,
      code: order.code,
      status: order.status,
      supplierName: order.supplier.name,
      expectedDate: order.expectedDate,
      estimatedAmount: num(order.estimatedAmount),
      lineCount: order._count.lines,
      createdAt: order.createdAt,
      sentAt: order.sentAt,
      sentVia: order.sentVia,
    })),
    total,
  };
}
