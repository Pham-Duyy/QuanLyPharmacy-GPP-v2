import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthContext } from "../auth/auth.context.js";
import type { CreateRecallInput } from "./recalls.schema.js";

type Tx = Prisma.TransactionClient;

/**
 * Tạo thông báo thu hồi (contract §16). Thu hồi là tài nguyên toàn chuỗi,
 * không gắn `storeId` — một công văn thu hồi từ nhà sản xuất áp cho lô đó
 * ở bất kỳ cửa hàng nào đang có, không riêng một cửa hàng.
 *
 * Với mỗi dòng `{ productId, batchNumber }`, mọi lô khớp còn `AVAILABLE`
 * hoặc `QUARANTINED` (ở bất kỳ cửa hàng nào) đều chuyển sang `RECALLED`.
 * Số lô không có trong kho vẫn được ghi lại để đối chiếu (`batchId = null`).
 */
export async function createRecall(auth: AuthContext, input: CreateRecallInput): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const recall = await tx.recall.create({
      data: {
        documentNumber: input.documentNumber,
        issuedBy: input.issuedBy ?? null,
        issuedAt: input.issuedAt,
        reason: input.reason ?? null,
        createdBy: auth.userId,
      },
    });

    for (const item of input.items) {
      const matched = await tx.batch.findMany({
        where: {
          productId: item.productId,
          batchNumber: item.batchNumber,
          status: { in: ["AVAILABLE", "QUARANTINED"] },
        },
      });

      for (const batch of matched) {
        await tx.batch.update({
          where: { id: batch.id },
          data: { status: "RECALLED", recallId: recall.id },
        });
      }

      // RecallItem chỉ lưu được một batchId; nếu cùng số lô tồn tại ở nhiều
      // cửa hàng (chuỗi mở rộng), lô đầu tiên được ghi ở đây, nhưng MỌI lô
      // khớp đều đã chuyển RECALLED ở trên và tra được qua Batch.recallId.
      await tx.recallItem.create({
        data: {
          recallId: recall.id,
          productId: item.productId,
          batchNumber: item.batchNumber,
          batchId: matched[0]?.id ?? null,
        },
      });
    }

    await tx.auditLog.create({
      data: {
        actorId: auth.userId,
        action: "RECALL_CREATE",
        resourceType: "recall",
        resourceId: recall.id,
        after: { documentNumber: recall.documentNumber, itemCount: input.items.length },
      },
    });

    return recall.id;
  });
}

/** Tổng tồn còn lại của các lô bị một thu hồi ảnh hưởng, để biết đóng được chưa. */
async function remainingStock(tx: Tx, recallId: string): Promise<number> {
  const result = await tx.batch.aggregate({
    where: { recallId },
    _sum: { quantityOnHand: true },
  });
  return result._sum.quantityOnHand ?? 0;
}

/**
 * Đóng thông báo thu hồi (contract §16): chỉ đóng được khi tồn của mọi lô
 * bị ảnh hưởng đã bằng 0 — nghĩa là đã bán hết trước khi bị thu hồi, hoặc
 * đã xuất khỏi kho bằng phiếu điều chỉnh lý do RECALL_DISPOSAL (§10.3).
 */
export async function closeRecall(recallId: string, auth: AuthContext): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.recall.findUnique({ where: { id: recallId } });
    if (!existing) throw AppError.notFound("Không tìm thấy thông báo thu hồi");

    const remaining = await remainingStock(tx, recallId);
    if (remaining > 0) {
      throw new AppError(
        409,
        "INVALID_STATE",
        `Các lô bị thu hồi còn tồn ${remaining} đơn vị nhỏ nhất, chưa xuất hết khỏi kho`,
        [{ remainingBaseQuantity: remaining }],
      );
    }

    const moved = await tx.recall.updateMany({
      where: { id: recallId, status: "OPEN" },
      data: { status: "CLOSED", closedBy: auth.userId, closedAt: new Date() },
    });
    if (moved.count === 0) {
      throw new AppError(
        409,
        "INVALID_STATE",
        `Thu hồi đang ở trạng thái ${existing.status}, không đóng lại được`,
      );
    }

    await tx.auditLog.create({
      data: {
        actorId: auth.userId,
        action: "RECALL_CLOSE",
        resourceType: "recall",
        resourceId: recallId,
      },
    });
  });
}

export async function getDetail(recallId: string) {
  const recall = await prisma.recall.findUnique({
    where: { id: recallId },
    include: {
      items: {
        include: {
          product: { select: { code: true, name: true } },
          batch: { select: { id: true, storeId: true, status: true, quantityOnHand: true } },
        },
      },
      createdByUser: { select: { id: true, fullName: true } },
      closedByUser: { select: { id: true, fullName: true } },
    },
  });
  if (!recall) throw AppError.notFound("Không tìm thấy thông báo thu hồi");

  // Nguồn thật của "lô bị ảnh hưởng" là Batch.recallId, không phải RecallItem.batchId,
  // vì một dòng RecallItem chỉ giữ được một batchId dù có thể khớp nhiều lô (nhiều cửa hàng).
  const affectedBatches = await prisma.batch.findMany({
    where: { recallId },
    include: { store: { select: { code: true, name: true } } },
  });

  return {
    id: recall.id,
    documentNumber: recall.documentNumber,
    issuedBy: recall.issuedBy,
    issuedAt: recall.issuedAt,
    reason: recall.reason,
    status: recall.status,
    createdBy: recall.createdByUser,
    closedBy: recall.closedByUser,
    closedAt: recall.closedAt,
    items: recall.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      productCode: item.product.code,
      productName: item.product.name,
      batchNumber: item.batchNumber,
      foundInStock: item.batch !== null,
    })),
    affectedBatches: affectedBatches.map((batch) => ({
      id: batch.id,
      storeCode: batch.store.code,
      storeName: batch.store.name,
      status: batch.status,
      quantityOnHand: batch.quantityOnHand,
    })),
    remainingBaseQuantity: affectedBatches.reduce((sum, batch) => sum + batch.quantityOnHand, 0),
  };
}

/**
 * Hóa đơn và khách hàng đã mua các lô bị thu hồi, để liên hệ thu hồi hàng.
 * Mỗi lần xem đều ghi audit vì đây là dữ liệu liên hệ khách hàng (contract §18).
 */
export async function getAffectedSales(recallId: string, auth: AuthContext) {
  const recall = await prisma.recall.findUnique({ where: { id: recallId } });
  if (!recall) throw AppError.notFound("Không tìm thấy thông báo thu hồi");

  const allocations = await prisma.invoiceAllocation.findMany({
    where: { batch: { recallId } },
    include: {
      batch: { select: { batchNumber: true } },
      invoiceLine: {
        include: {
          invoice: {
            include: {
              customer: { select: { id: true, fullName: true, phone: true } },
              store: { select: { code: true, name: true } },
            },
          },
        },
      },
    },
    orderBy: { id: "asc" },
  });

  await prisma.auditLog.create({
    data: {
      actorId: auth.userId,
      action: "RECALL_AFFECTED_SALES_VIEW",
      resourceType: "recall",
      resourceId: recallId,
    },
  });

  return allocations.map((allocation) => ({
    invoiceId: allocation.invoiceLine.invoice.id,
    invoiceCode: allocation.invoiceLine.invoice.code,
    storeCode: allocation.invoiceLine.invoice.store.code,
    soldAt: allocation.invoiceLine.invoice.soldAt,
    customer: allocation.invoiceLine.invoice.customer,
    productName: allocation.invoiceLine.productName,
    batchNumber: allocation.batch.batchNumber,
    baseQuantity: allocation.baseQuantity,
  }));
}

export async function list(query: { status?: string }) {
  return prisma.recall.findMany({
    where: query.status ? { status: query.status } : {},
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { items: true } } },
  });
}
