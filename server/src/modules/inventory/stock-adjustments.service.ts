import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthContext } from "../auth/auth.context.js";
import type { CreateAdjustmentInput } from "./stock-adjustments.schema.js";

type Tx = Prisma.TransactionClient;

async function nextAdjustmentCode(tx: Tx, storeId: string, storeCode: string): Promise<string> {
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" })
    .format(new Date())
    .replace(/-/g, "");
  const prefix = `DC-${storeCode}-${day}-`;
  const countToday = await tx.stockAdjustment.count({
    where: { storeId, code: { startsWith: prefix } },
  });
  return `${prefix}${String(countToday + 1).padStart(4, "0")}`;
}

/**
 * Lập phiếu điều chỉnh `DRAFT`, chưa đụng tới tồn (contract §10.3).
 *
 * Với dòng `COUNT_DIFFERENCE`, tồn hệ thống của lô được chụp lại **ngay lúc
 * lập phiếu** (`systemBaseQuantityAtCount`). Đây là mốc để tính chênh lệch
 * khi duyệt, không phải tồn tại thời điểm duyệt — nhờ vậy các giao dịch bán
 * xảy ra giữa lúc đếm và lúc duyệt không bị mất (P4).
 */
export async function createDraft(
  storeId: string,
  userId: string,
  input: CreateAdjustmentInput,
): Promise<string> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });

  return prisma.$transaction(async (tx) => {
    const batches = await tx.batch.findMany({
      where: { id: { in: input.lines.map((line) => line.batchId) }, storeId },
    });
    const batchById = new Map(batches.map((batch) => [batch.id, batch]));

    const units = await tx.productUnit.findMany({
      where: { id: { in: input.lines.map((line) => line.unitId) } },
    });
    const unitById = new Map(units.map((unit) => [unit.id, unit]));

    const lines = input.lines.map((line, index) => {
      const batch = batchById.get(line.batchId);
      if (!batch) throw AppError.notFound(`Dòng ${index + 1}: không tìm thấy lô`);

      const unit = unitById.get(line.unitId);
      if (!unit || unit.productId !== batch.productId) {
        throw new AppError(
          422,
          "UNIT_NOT_IN_PRODUCT",
          `Dòng ${index + 1}: đơn vị tính không thuộc sản phẩm của lô đã chọn`,
        );
      }

      return {
        lineNo: index + 1,
        batchId: batch.id,
        productUnitId: unit.id,
        reasonCode: line.reasonCode,
        countedQuantity: line.countedQuantity ?? null,
        quantity: line.quantity ?? null,
        systemBaseQuantityAtCount:
          line.reasonCode === "COUNT_DIFFERENCE" ? batch.quantityOnHand : null,
      };
    });

    const adjustment = await tx.stockAdjustment.create({
      data: {
        storeId,
        code: await nextAdjustmentCode(tx, storeId, store.code),
        reason: input.reason ?? null,
        createdBy: userId,
        lines: { create: lines },
      },
    });

    return adjustment.id;
  });
}

/**
 * Duyệt phiếu: áp dụng **chênh lệch**, không gán tồn bằng số đếm (P4).
 *
 * - `COUNT_DIFFERENCE`: chênh lệch = số đếm quy đổi ra đơn vị nhỏ nhất − tồn
 *   đã chụp lúc lập. Cộng chênh lệch này vào tồn **hiện tại** của lô (không
 *   phải gán bằng số đếm), nên các đơn bán phát sinh giữa hai mốc vẫn đúng.
 * - Các lý do còn lại: xuất thẳng số lượng quy đổi ra đơn vị nhỏ nhất.
 *
 * Người duyệt phải khác người lập (P4), kiểm tra trước khi chuyển trạng thái.
 */
export async function approve(storeId: string, adjustmentId: string, auth: AuthContext) {
  await prisma.$transaction(
    async (tx) => {
      const existing = await tx.stockAdjustment.findFirst({
        where: { id: adjustmentId, storeId },
        include: { lines: { include: { productUnit: true } } },
      });
      if (!existing) throw AppError.notFound("Không tìm thấy phiếu điều chỉnh");

      if (existing.createdBy === auth.userId) {
        throw new AppError(
          422,
          "SELF_APPROVAL_NOT_ALLOWED",
          "Người duyệt phải khác người lập phiếu",
        );
      }

      const moved = await tx.stockAdjustment.updateMany({
        where: { id: adjustmentId, storeId, status: "DRAFT" },
        data: { status: "APPROVED", approvedBy: auth.userId, approvedAt: new Date() },
      });
      if (moved.count === 0) {
        throw new AppError(
          409,
          "INVALID_STATE",
          `Phiếu đang ở trạng thái ${existing.status}, không duyệt được`,
        );
      }

      for (const line of existing.lines) {
        // Đọc lại tồn ngay trước khi áp dụng: nếu phiếu có nhiều dòng cùng
        // một lô, dòng sau phải thấy đúng kết quả của dòng trước trong cùng
        // giao dịch, không dùng lại bản chụp đầu vòng lặp.
        const batch = await tx.batch.findUniqueOrThrow({ where: { id: line.batchId } });

        let delta: number;
        let movementType: "ADJUSTMENT" | "DISPOSAL";

        if (line.reasonCode === "COUNT_DIFFERENCE") {
          const countedBase = line.countedQuantity! * line.productUnit.conversionToBase;
          delta = countedBase - line.systemBaseQuantityAtCount!;
          movementType = "ADJUSTMENT";
        } else {
          const quantityBase = line.quantity! * line.productUnit.conversionToBase;
          if (batch.quantityOnHand < quantityBase) {
            throw new AppError(
              409,
              "INSUFFICIENT_STOCK",
              `Lô hiện chỉ còn ${batch.quantityOnHand}, không xuất hủy ${quantityBase} được`,
            );
          }
          delta = -quantityBase;
          movementType = "DISPOSAL";
        }

        await tx.stockAdjustmentLine.update({
          where: { id: line.id },
          data: { deltaBaseQuantity: delta },
        });

        // Đếm khớp tồn hệ thống: chênh lệch bằng 0, không có gì để ghi thẻ
        // kho (CHECK base_quantity <> 0 cũng chặn ở tầng CSDL).
        if (delta === 0) continue;

        const updated = await tx.batch.update({
          where: { id: line.batchId },
          data: { quantityOnHand: { increment: delta } },
        });

        await tx.stockMovement.create({
          data: {
            storeId,
            batchId: line.batchId,
            productId: updated.productId,
            type: movementType,
            baseQuantity: delta,
            balanceAfter: updated.quantityOnHand,
            sourceType: "STOCK_ADJUSTMENT",
            sourceId: adjustmentId,
            sourceLineId: line.id,
            userId: auth.userId,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          storeId,
          actorId: auth.userId,
          action: "STOCK_ADJUSTMENT_APPROVE",
          resourceType: "stock_adjustment",
          resourceId: adjustmentId,
        },
      });
    },
    { timeout: 20_000 },
  );
}

export async function reject(
  storeId: string,
  adjustmentId: string,
  auth: AuthContext,
  reason: string,
): Promise<void> {
  const moved = await prisma.stockAdjustment.updateMany({
    where: { id: adjustmentId, storeId, status: "DRAFT" },
    data: { status: "REJECTED", rejectedReason: reason },
  });

  if (moved.count === 0) {
    const existing = await prisma.stockAdjustment.findFirst({
      where: { id: adjustmentId, storeId },
    });
    if (!existing) throw AppError.notFound("Không tìm thấy phiếu điều chỉnh");
    throw new AppError(
      409,
      "INVALID_STATE",
      `Phiếu đang ở trạng thái ${existing.status}, không từ chối được`,
    );
  }

  await prisma.auditLog.create({
    data: {
      storeId,
      actorId: auth.userId,
      action: "STOCK_ADJUSTMENT_REJECT",
      resourceType: "stock_adjustment",
      resourceId: adjustmentId,
      reason,
    },
  });
}

/** Chỉ người lập được hủy phiếu nháp của chính mình (contract §10.3). */
export async function cancel(
  storeId: string,
  adjustmentId: string,
  auth: AuthContext,
): Promise<void> {
  const existing = await prisma.stockAdjustment.findFirst({ where: { id: adjustmentId, storeId } });
  if (!existing) throw AppError.notFound("Không tìm thấy phiếu điều chỉnh");

  if (existing.createdBy !== auth.userId) {
    throw new AppError(403, "FORBIDDEN", "Chỉ người lập phiếu mới hủy được");
  }

  const moved = await prisma.stockAdjustment.updateMany({
    where: { id: adjustmentId, storeId, status: "DRAFT" },
    data: { status: "CANCELLED" },
  });
  if (moved.count === 0) {
    throw new AppError(
      409,
      "INVALID_STATE",
      `Phiếu đang ở trạng thái ${existing.status}, chỉ hủy được phiếu còn nháp`,
    );
  }

  await prisma.auditLog.create({
    data: {
      storeId,
      actorId: auth.userId,
      action: "STOCK_ADJUSTMENT_CANCEL",
      resourceType: "stock_adjustment",
      resourceId: adjustmentId,
    },
  });
}

export async function getDetail(storeId: string, adjustmentId: string) {
  const adjustment = await prisma.stockAdjustment.findFirst({
    where: { id: adjustmentId, storeId },
    include: {
      createdByUser: { select: { id: true, fullName: true } },
      approvedByUser: { select: { id: true, fullName: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          batch: { select: { batchNumber: true, productId: true } },
          productUnit: { select: { name: true, conversionToBase: true } },
        },
      },
    },
  });
  if (!adjustment) throw AppError.notFound("Không tìm thấy phiếu điều chỉnh");

  return {
    id: adjustment.id,
    code: adjustment.code,
    status: adjustment.status,
    reason: adjustment.reason,
    createdBy: adjustment.createdByUser,
    approvedBy: adjustment.approvedByUser,
    approvedAt: adjustment.approvedAt,
    rejectedReason: adjustment.rejectedReason,
    version: adjustment.version,
    createdAt: adjustment.createdAt,
    lines: adjustment.lines.map((line) => ({
      id: line.id,
      lineNo: line.lineNo,
      batchId: line.batchId,
      batchNumber: line.batch.batchNumber,
      unitName: line.productUnit.name,
      reasonCode: line.reasonCode,
      countedQuantity: line.countedQuantity,
      quantity: line.quantity,
      systemBaseQuantityAtCount: line.systemBaseQuantityAtCount,
      deltaBaseQuantity: line.deltaBaseQuantity,
    })),
  };
}

export async function list(storeId: string, query: { status?: string; from?: Date; to?: Date }) {
  const rows = await prisma.stockAdjustment.findMany({
    where: {
      storeId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to ? { createdAt: { gte: query.from, lte: query.to } } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { lines: true } },
      createdByUser: { select: { fullName: true } },
      approvedByUser: { select: { fullName: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    status: row.status,
    reason: row.reason,
    createdByName: row.createdByUser.fullName,
    approvedByName: row.approvedByUser?.fullName ?? null,
    approvedAt: row.approvedAt,
    rejectedReason: row.rejectedReason,
    createdAt: row.createdAt,
    lineCount: row._count.lines,
  }));
}
