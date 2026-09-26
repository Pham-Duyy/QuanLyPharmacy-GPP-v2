import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { codeDay, nextDocumentCode } from "../../lib/document-code.js";
import { lockGoodsReceipts, lockSupplierReturn } from "../../lib/locks.js";
import type { AuthContext } from "../auth/auth.context.js";

type Tx = Prisma.TransactionClient;

/**
 * Trả hàng cho nhà cung cấp: hàng cận hạn được nhận lại, hàng lỗi, hàng thu
 * hồi hoặc giao sai.
 *
 * Lập nháp rồi mới xác nhận, giống phiếu nhập. Chỉ khi xác nhận mới trừ tồn
 * và ghi thẻ kho, vì lúc đó hàng mới thật sự rời khỏi kho. Tất toán bằng trừ
 * công nợ (mặc định), nhận lại tiền hoặc đổi hàng — chỉ cách đầu mới tác
 * động tới công nợ ở §9.1.
 */

export const SETTLEMENTS = ["DEDUCT_DEBT", "REFUND", "REPLACEMENT"] as const;
export type Settlement = (typeof SETTLEMENTS)[number];

const num = (value: bigint | null | undefined) => Number(value ?? 0n);

async function nextReturnCode(tx: Tx, storeId: string, storeCode: string): Promise<string> {
  return nextDocumentCode(tx, storeId, `TNCC-${storeCode}-${codeDay()}-`);
}

export type ReturnInput = {
  supplierId: string;
  reason: string;
  settlement: Settlement;
  note?: string | null;
  lines: Array<{ batchId: string; unitId: string; quantity: number; note?: string | null }>;
};

/** Lô còn tồn kèm nhà cung cấp đã mang lô đó về, để chọn khi lập phiếu trả. */
export async function listReturnable(storeId: string, query: { supplierId?: string | undefined; search?: string | undefined }) {
  const batches = await prisma.batch.findMany({
    where: {
      storeId,
      quantityOnHand: { gt: 0 },
      ...(query.search
        ? { OR: [{ batchNumber: { contains: query.search, mode: "insensitive" } }, { product: { name: { contains: query.search, mode: "insensitive" } } }, { product: { code: { contains: query.search, mode: "insensitive" } } }] }
        : {}),
    },
    orderBy: [{ expiryDate: "asc" }],
    take: 300,
    include: {
      product: { select: { id: true, code: true, name: true, units: { where: { isActive: true }, select: { id: true, name: true, conversionToBase: true }, orderBy: { conversionToBase: "asc" } } } },
    },
  });

  const sources = await prisma.goodsReceiptLine.findMany({
    where: { batchId: { in: batches.map((batch) => batch.id) }, goodsReceipt: { status: "CONFIRMED" } },
    select: { batchId: true, goodsReceiptId: true, goodsReceipt: { select: { code: true, receivedAt: true, supplier: { select: { id: true, name: true } } } } },
    orderBy: { goodsReceipt: { receivedAt: "desc" } },
  });
  const sourceByBatch = new Map<string, (typeof sources)[number]>();
  for (const line of sources) if (line.batchId && !sourceByBatch.has(line.batchId)) sourceByBatch.set(line.batchId, line);

  return batches
    .map((batch) => {
      const source = sourceByBatch.get(batch.id);
      return {
        batchId: batch.id,
        productId: batch.product.id,
        productCode: batch.product.code,
        productName: batch.product.name,
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        quantityOnHand: batch.quantityOnHand,
        batchStatus: batch.status,
        unitCost: batch.unitCost === null ? null : Math.round(Number(batch.unitCost)),
        units: batch.product.units,
        supplier: source?.goodsReceipt.supplier ?? null,
        goodsReceipt: source ? { id: source.goodsReceiptId, code: source.goodsReceipt.code } : null,
      };
    })
    .filter((item) => (query.supplierId ? item.supplier?.id === query.supplierId : true));
}

export async function createDraft(storeId: string, auth: AuthContext, input: ReturnInput): Promise<string> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) throw AppError.notFound("Không tìm thấy nhà cung cấp");

  return prisma.$transaction(async (tx) => {
    const batches = await tx.batch.findMany({
      where: { id: { in: input.lines.map((line) => line.batchId) }, storeId },
      include: { product: { select: { units: { where: { isActive: true }, select: { id: true, productId: true, conversionToBase: true } } } } },
    });
    const byId = new Map(batches.map((batch) => [batch.id, batch]));

    // Lô này về từ phiếu nhập nào: dùng để trừ đúng khoản công nợ khi tất toán.
    const sources = await tx.goodsReceiptLine.findMany({
      where: { batchId: { in: input.lines.map((line) => line.batchId) }, goodsReceipt: { status: "CONFIRMED", supplierId: input.supplierId } },
      select: { batchId: true, goodsReceiptId: true },
      orderBy: { goodsReceipt: { receivedAt: "desc" } },
    });
    const receiptByBatch = new Map<string, string>();
    for (const line of sources) if (line.batchId && !receiptByBatch.has(line.batchId)) receiptByBatch.set(line.batchId, line.goodsReceiptId);

    const lines = input.lines.map((line, index) => {
      const batch = byId.get(line.batchId);
      if (!batch) throw AppError.notFound(`Dòng ${index + 1}: không tìm thấy lô trong kho cửa hàng`);
      const unit = batch.product.units.find((item) => item.id === line.unitId);
      if (!unit || unit.productId !== batch.productId) {
        throw new AppError(422, "UNIT_NOT_IN_PRODUCT", `Dòng ${index + 1}: đơn vị không thuộc sản phẩm của lô`);
      }
      const baseQuantity = line.quantity * unit.conversionToBase;
      if (baseQuantity > batch.quantityOnHand) {
        throw new AppError(409, "INSUFFICIENT_STOCK", `Dòng ${index + 1}: lô chỉ còn ${batch.quantityOnHand}, không trả ${baseQuantity} được`);
      }
      const unitCost = batch.unitCost === null ? 0 : Math.round(Number(batch.unitCost));
      return {
        lineNo: index + 1,
        batchId: batch.id,
        productId: batch.productId,
        productUnitId: unit.id,
        quantity: line.quantity,
        baseQuantity,
        unitCost: BigInt(unitCost),
        lineValue: BigInt(unitCost * baseQuantity),
        goodsReceiptId: receiptByBatch.get(batch.id) ?? null,
        note: line.note ?? null,
      };
    });

    const created = await tx.supplierReturn.create({
      data: {
        storeId,
        supplierId: input.supplierId,
        code: await nextReturnCode(tx, storeId, store.code),
        reason: input.reason,
        settlement: input.settlement,
        note: input.note ?? null,
        totalValue: lines.reduce((sum, line) => sum + line.lineValue, 0n),
        createdBy: auth.userId,
        lines: { create: lines },
      },
    });
    return created.id;
  });
}

/** Xác nhận: trừ tồn từng lô và ghi thẻ kho. Đây là lúc hàng rời khỏi kho. */
export async function confirmReturn(storeId: string, returnId: string, auth: AuthContext): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockSupplierReturn(tx, storeId, returnId);
    const existing = await tx.supplierReturn.findFirst({ where: { id: returnId, storeId }, include: { lines: true } });
    if (!existing) throw AppError.notFound("Không tìm thấy phiếu trả hàng");

    // Trả hàng trừ thẳng vào công nợ thì phải khóa đúng những phiếu nhập đó,
    // để một lần thanh toán đang chạy song song không tính trên số nợ cũ.
    if (existing.settlement === "DEDUCT_DEBT") {
      const receiptIds = [
        ...new Set(existing.lines.map((line) => line.goodsReceiptId).filter((id): id is string => Boolean(id))),
      ];
      await lockGoodsReceipts(tx, storeId, receiptIds);
      await assertDeductible(tx, storeId, returnId, existing.lines, receiptIds);
    }

    const moved = await tx.supplierReturn.updateMany({
      where: { id: returnId, storeId, status: "DRAFT" },
      data: { status: "CONFIRMED", confirmedBy: auth.userId, confirmedAt: new Date(), version: { increment: 1 } },
    });
    if (moved.count === 0) throw new AppError(409, "INVALID_STATE", `Phiếu đang ở trạng thái ${existing.status}, không xác nhận lại được`);

    for (const line of existing.lines) {
      // Đọc lại tồn ngay trước khi trừ: từ lúc lập nháp tới giờ có thể đã bán bớt.
      const batch = await tx.batch.findUniqueOrThrow({ where: { id: line.batchId } });
      if (batch.quantityOnHand < line.baseQuantity) {
        throw new AppError(409, "INSUFFICIENT_STOCK", `Lô ${batch.batchNumber} chỉ còn ${batch.quantityOnHand}, không trả ${line.baseQuantity} được`);
      }
      const updated = await tx.batch.update({ where: { id: line.batchId }, data: { quantityOnHand: { decrement: line.baseQuantity } } });
      await tx.stockMovement.create({
        data: {
          storeId,
          batchId: line.batchId,
          productId: line.productId,
          type: "SUPPLIER_RETURN",
          baseQuantity: -line.baseQuantity,
          balanceAfter: updated.quantityOnHand,
          sourceType: "SUPPLIER_RETURN",
          sourceId: returnId,
          sourceLineId: line.id,
          userId: auth.userId,
          note: existing.reason,
        },
      });
    }

    await tx.auditLog.create({
      data: {
        storeId,
        actorId: auth.userId,
        action: "SUPPLIER_RETURN_CONFIRM",
        resourceType: "supplier_return",
        resourceId: returnId,
        after: { code: existing.code, lines: existing.lines.length, totalValue: num(existing.totalValue), settlement: existing.settlement },
      },
    });
  });
}

/**
 * "Trừ vào công nợ" chỉ trừ được vào phần **còn nợ** của đúng phiếu nhập đó.
 *
 * Nếu phiếu nhập đã trả đủ tiền (hoặc phần còn nợ ít hơn giá trị hàng trả),
 * khoản chênh lệch là tiền nhà cung cấp nợ lại nhà thuốc — sổ công nợ hiện
 * tại không có chỗ ghi khoản đó, và `outstanding` bị kẹp về 0 nên tiền sẽ
 * **biến mất khỏi sổ**. Vì vậy chặn ngay tại đây và yêu cầu chọn hình thức
 * tất toán khác (nhận lại tiền hoặc đổi hàng).
 */
async function assertDeductible(
  tx: Tx,
  storeId: string,
  returnId: string,
  lines: Array<{ goodsReceiptId: string | null; lineValue: bigint }>,
  receiptIds: string[],
): Promise<void> {
  const creditByReceipt = new Map<string, number>();
  for (const line of lines) {
    if (!line.goodsReceiptId) continue;
    creditByReceipt.set(line.goodsReceiptId, (creditByReceipt.get(line.goodsReceiptId) ?? 0) + num(line.lineValue));
  }
  if (creditByReceipt.size === 0) return;

  const receipts = await tx.goodsReceipt.findMany({
    where: { id: { in: receiptIds }, storeId },
    include: {
      paymentAllocations: { where: { payment: { status: "ACTIVE" } }, select: { amount: true } },
      supplierReturnLines: {
        where: { supplierReturn: { status: "CONFIRMED", settlement: "DEDUCT_DEBT", id: { not: returnId } } },
        select: { lineValue: true },
      },
    },
  });

  for (const receipt of receipts) {
    const credit = creditByReceipt.get(receipt.id) ?? 0;
    if (credit === 0) continue;
    const paid = receipt.paymentAllocations.reduce((sum, item) => sum + num(item.amount), 0);
    const credited = receipt.supplierReturnLines.reduce((sum, item) => sum + num(item.lineValue), 0);
    const remaining = num(receipt.totalCost) - paid - credited;
    if (credit > remaining) {
      throw new AppError(
        422,
        "DEBT_CREDIT_EXCEEDED",
        `Phiếu nhập ${receipt.code} chỉ còn nợ ${Math.max(0, remaining).toLocaleString("vi-VN")} đ, không trừ ${credit.toLocaleString("vi-VN")} đ được. Chọn hình thức nhận lại tiền hoặc đổi hàng cho phần vượt.`,
      );
    }
  }
}

export async function cancelReturn(storeId: string, returnId: string, auth: AuthContext, reason: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Khóa và kiểm tra trong transaction: trước đây phiếu vừa được xác nhận
    // (đã trừ tồn) vẫn có thể bị lệnh hủy chạy song song ghi đè thành CANCELLED.
    await lockSupplierReturn(tx, storeId, returnId);
    const existing = await tx.supplierReturn.findFirst({ where: { id: returnId, storeId } });
    if (!existing) throw AppError.notFound("Không tìm thấy phiếu trả hàng");
    if (existing.status !== "DRAFT") {
      throw AppError.invalidState("Chỉ hủy được phiếu còn nháp. Phiếu đã xác nhận thì lập phiếu nhập bù nếu nhà cung cấp trả hàng lại.");
    }

    const moved = await tx.supplierReturn.updateMany({
      where: { id: returnId, storeId, status: "DRAFT" },
      data: { status: "CANCELLED", cancelledBy: auth.userId, cancelledAt: new Date(), cancelReason: reason, version: { increment: 1 } },
    });
    if (moved.count === 0) throw AppError.invalidState("Phiếu vừa đổi trạng thái, không hủy được nữa");
    await tx.auditLog.create({
      data: { storeId, actorId: auth.userId, action: "SUPPLIER_RETURN_CANCEL", resourceType: "supplier_return", resourceId: returnId, reason, before: { code: existing.code } },
    });
  });
}

export async function getDetail(storeId: string, returnId: string) {
  const found = await prisma.supplierReturn.findFirst({
    where: { id: returnId, storeId },
    include: {
      supplier: { select: { id: true, name: true, phone: true } },
      createdByUser: { select: { fullName: true } },
      confirmedByUser: { select: { fullName: true } },
      cancelledByUser: { select: { fullName: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          batch: { select: { batchNumber: true, expiryDate: true, quantityOnHand: true } },
          product: { select: { code: true, name: true } },
          productUnit: { select: { name: true, conversionToBase: true } },
          goodsReceipt: { select: { id: true, code: true } },
        },
      },
    },
  });
  if (!found) throw AppError.notFound("Không tìm thấy phiếu trả hàng");
  return toView(found);
}

type ReturnRow = Awaited<ReturnType<typeof prisma.supplierReturn.findFirstOrThrow>> & {
  supplier: { id: string; name: string; phone: string | null };
  createdByUser: { fullName: string };
  confirmedByUser: { fullName: string } | null;
  cancelledByUser: { fullName: string } | null;
  lines: Array<{
    id: string;
    lineNo: number;
    batchId: string;
    quantity: number;
    baseQuantity: number;
    unitCost: bigint;
    lineValue: bigint;
    note: string | null;
    batch: { batchNumber: string; expiryDate: Date; quantityOnHand: number };
    product: { code: string; name: string };
    productUnit: { name: string; conversionToBase: number };
    goodsReceipt: { id: string; code: string } | null;
  }>;
};

function toView(row: ReturnRow) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    reason: row.reason,
    settlement: row.settlement,
    note: row.note,
    totalValue: num(row.totalValue),
    returnedAt: row.returnedAt,
    supplier: row.supplier,
    createdByName: row.createdByUser.fullName,
    confirmedByName: row.confirmedByUser?.fullName ?? null,
    confirmedAt: row.confirmedAt,
    cancelledByName: row.cancelledByUser?.fullName ?? null,
    cancelReason: row.cancelReason,
    version: row.version,
    lines: row.lines.map((line) => ({
      id: line.id,
      lineNo: line.lineNo,
      batchId: line.batchId,
      productCode: line.product.code,
      productName: line.product.name,
      batchNumber: line.batch.batchNumber,
      expiryDate: line.batch.expiryDate,
      quantityOnHand: line.batch.quantityOnHand,
      unitName: line.productUnit.name,
      quantity: line.quantity,
      baseQuantity: line.baseQuantity,
      unitCost: num(line.unitCost),
      lineValue: num(line.lineValue),
      goodsReceipt: line.goodsReceipt,
      note: line.note,
    })),
  };
}

export async function list(storeId: string, query: { status?: string | undefined; supplierId?: string | undefined }) {
  const rows = await prisma.supplierReturn.findMany({
    where: { storeId, ...(query.status ? { status: query.status } : {}), ...(query.supplierId ? { supplierId: query.supplierId } : {}) },
    orderBy: { returnedAt: "desc" },
    take: 100,
    include: {
      supplier: { select: { id: true, name: true, phone: true } },
      createdByUser: { select: { fullName: true } },
      confirmedByUser: { select: { fullName: true } },
      cancelledByUser: { select: { fullName: true } },
      _count: { select: { lines: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    status: row.status,
    reason: row.reason,
    settlement: row.settlement,
    totalValue: num(row.totalValue),
    returnedAt: row.returnedAt,
    supplier: row.supplier,
    createdByName: row.createdByUser.fullName,
    confirmedByName: row.confirmedByUser?.fullName ?? null,
    lineCount: row._count.lines,
  }));
}
