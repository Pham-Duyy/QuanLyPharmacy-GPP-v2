import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { businessDateNow } from "../../lib/settings.js";
import type { AuthContext } from "../auth/auth.context.js";

/**
 * Cảnh báo hàng cận hạn, kèm kế hoạch xử lý từng lô.
 *
 * Hàng cận hạn là tiền đang treo: nếu không trả nhà cung cấp, đẩy bán hoặc
 * giảm giá kịp thì tới hạn phải hủy, mất trắng. Vì vậy danh sách không chỉ
 * đếm lô mà còn quy ra giá trị tồn, và mỗi lô có một kế hoạch có người chịu
 * trách nhiệm cùng ngày hẹn.
 */

export const EXPIRY_ACTIONS = ["RETURN_SUPPLIER", "PRIORITIZE_SALE", "DISCOUNT", "DISPOSE"] as const;
export type ExpiryAction = (typeof EXPIRY_ACTIONS)[number];

/** Mốc chia nhóm theo số ngày còn lại. */
export const BUCKETS = [
  { key: "EXPIRED", label: "Đã hết hạn", maxDays: -1 },
  { key: "D30", label: "Còn dưới 30 ngày", maxDays: 30 },
  { key: "D60", label: "Còn 31 – 60 ngày", maxDays: 60 },
  { key: "D90", label: "Còn 61 – 90 ngày", maxDays: 90 },
] as const;

export type BucketKey = (typeof BUCKETS)[number]["key"];

export type ExpiryPlanView = {
  id: string;
  action: ExpiryAction;
  status: string;
  dueDate: Date | null;
  note: string | null;
  outcome: string | null;
  createdByName: string;
  createdAt: Date;
  resolvedByName: string | null;
  resolvedAt: Date | null;
  /** Đã quá ngày hẹn mà chưa xong: phải báo lại cho người phụ trách. */
  overdue: boolean;
  version: number;
};

export type ExpiryRow = {
  batchId: string;
  productId: string;
  productCode: string;
  productName: string;
  batchNumber: string;
  expiryDate: Date;
  daysLeft: number;
  bucket: BucketKey;
  quantityOnHand: number;
  baseUnitName: string;
  shelfLocation: string | null;
  batchStatus: string;
  /** Giá trị tồn theo giá vốn lô; null khi không có quyền xem giá vốn hoặc lô chưa có giá vốn. */
  stockValue: number | null;
  lastSupplier: { id: string; name: string } | null;
  plan: ExpiryPlanView | null;
};

export type ExpiryQuery = { horizonDays: number; bucket?: BucketKey | undefined; onlyWithoutPlan: boolean };

function bucketOf(daysLeft: number): BucketKey {
  if (daysLeft < 0) return "EXPIRED";
  if (daysLeft <= 30) return "D30";
  if (daysLeft <= 60) return "D60";
  return "D90";
}

export async function listExpiring(storeId: string, auth: AuthContext, query: ExpiryQuery) {
  const today = businessDateNow();
  const limit = new Date(today.getTime() + query.horizonDays * 86_400_000);
  const showCost = auth.can("stock.cost.read");

  const batches = await prisma.batch.findMany({
    where: { storeId, quantityOnHand: { gt: 0 }, expiryDate: { lte: limit } },
    orderBy: [{ expiryDate: "asc" }],
    include: {
      product: {
        select: { id: true, code: true, name: true, units: { where: { conversionToBase: 1 }, select: { name: true } } },
      },
      expiryPlans: {
        where: { status: "PLANNED" },
        include: { createdByUser: { select: { fullName: true } }, resolvedByUser: { select: { fullName: true } } },
      },
    },
  });

  // Nhà cung cấp của lô, để biết gọi ai khi muốn trả hàng.
  const receiptLines = await prisma.goodsReceiptLine.findMany({
    where: { batchId: { in: batches.map((batch) => batch.id) } },
    select: { batchId: true, goodsReceipt: { select: { receivedAt: true, supplier: { select: { id: true, name: true } } } } },
    orderBy: { goodsReceipt: { receivedAt: "desc" } },
  });
  const supplierByBatch = new Map<string, { id: string; name: string }>();
  for (const line of receiptLines) {
    const supplier = line.goodsReceipt.supplier;
    if (supplier && line.batchId && !supplierByBatch.has(line.batchId)) supplierByBatch.set(line.batchId, supplier);
  }

  const rows: ExpiryRow[] = batches.map((batch) => {
    const daysLeft = Math.round((batch.expiryDate.getTime() - today.getTime()) / 86_400_000);
    const unitCost = batch.unitCost === null ? null : Number(batch.unitCost);
    const plan = batch.expiryPlans[0];
    return {
      batchId: batch.id,
      productId: batch.productId,
      productCode: batch.product.code,
      productName: batch.product.name,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      daysLeft,
      bucket: bucketOf(daysLeft),
      quantityOnHand: batch.quantityOnHand,
      baseUnitName: batch.product.units[0]?.name ?? "",
      shelfLocation: batch.shelfLocation,
      batchStatus: batch.status,
      stockValue: showCost && unitCost !== null ? Math.round(unitCost * batch.quantityOnHand) : null,
      lastSupplier: supplierByBatch.get(batch.id) ?? null,
      plan: plan
        ? {
            id: plan.id,
            action: plan.action as ExpiryAction,
            status: plan.status,
            dueDate: plan.dueDate,
            note: plan.note,
            outcome: plan.outcome,
            createdByName: plan.createdByUser.fullName,
            createdAt: plan.createdAt,
            resolvedByName: plan.resolvedByUser?.fullName ?? null,
            resolvedAt: plan.resolvedAt,
            overdue: Boolean(plan.dueDate && plan.dueDate.getTime() < today.getTime()),
            version: plan.version,
          }
        : null,
    };
  });

  const filtered = rows.filter((row) => (query.bucket ? row.bucket === query.bucket : true) && (query.onlyWithoutPlan ? !row.plan : true));
  return { items: filtered, summary: summarize(rows, showCost) };
}

export function summarize(rows: ExpiryRow[], showCost: boolean) {
  const byBucket = Object.fromEntries(
    BUCKETS.map((bucket) => {
      const items = rows.filter((row) => row.bucket === bucket.key);
      return [
        bucket.key,
        {
          label: bucket.label,
          batches: items.length,
          quantity: items.reduce((sum, row) => sum + row.quantityOnHand, 0),
          value: showCost ? items.reduce((sum, row) => sum + (row.stockValue ?? 0), 0) : null,
          withoutPlan: items.filter((row) => !row.plan).length,
        },
      ];
    }),
  );

  return {
    byBucket,
    totalBatches: rows.length,
    withoutPlan: rows.filter((row) => !row.plan).length,
    overduePlans: rows.filter((row) => row.plan?.overdue).length,
    totalValue: showCost ? rows.reduce((sum, row) => sum + (row.stockValue ?? 0), 0) : null,
  };
}

export type PlanInput = { batchId: string; action: ExpiryAction; dueDate?: Date | null; note?: string | null };

/** Lập kế hoạch xử lý cho một lô. Lô đang có kế hoạch mở thì cập nhật kế hoạch đó. */
export async function savePlan(storeId: string, auth: AuthContext, input: PlanInput): Promise<string> {
  const batch = await prisma.batch.findFirst({ where: { id: input.batchId, storeId } });
  if (!batch) throw AppError.notFound("Không tìm thấy lô trong kho cửa hàng này");

  const existing = await prisma.batch
    .findFirst({ where: { id: input.batchId }, select: { expiryPlans: { where: { status: "PLANNED" }, select: { id: true } } } })
    .then((row) => row?.expiryPlans[0]);

  const plan = existing
    ? await prisma.batchExpiryPlan.update({
        where: { id: existing.id },
        data: { action: input.action, dueDate: input.dueDate ?? null, note: input.note ?? null, version: { increment: 1 } },
      })
    : await prisma.batchExpiryPlan.create({
        data: {
          batchId: input.batchId,
          storeId,
          action: input.action,
          dueDate: input.dueDate ?? null,
          note: input.note ?? null,
          createdBy: auth.userId,
        },
      });

  await prisma.auditLog.create({
    data: {
      storeId,
      actorId: auth.userId,
      action: existing ? "EXPIRY_PLAN_UPDATE" : "EXPIRY_PLAN_CREATE",
      resourceType: "batch_expiry_plan",
      resourceId: plan.id,
      after: { batchNumber: batch.batchNumber, action: input.action, dueDate: input.dueDate ?? null, note: input.note ?? null },
    },
  });
  return plan.id;
}

export async function closePlan(storeId: string, planId: string, auth: AuthContext, status: "DONE" | "CANCELLED", outcome: string | null): Promise<void> {
  const plan = await prisma.batchExpiryPlan.findFirst({ where: { id: planId, storeId }, include: { batch: { select: { batchNumber: true } } } });
  if (!plan) throw AppError.notFound("Không tìm thấy kế hoạch xử lý");
  if (plan.status !== "PLANNED") throw AppError.invalidState("Kế hoạch này đã đóng rồi");

  await prisma.$transaction(async (tx) => {
    await tx.batchExpiryPlan.update({
      where: { id: planId },
      data: { status, outcome, resolvedBy: auth.userId, resolvedAt: new Date(), version: { increment: 1 } },
    });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: auth.userId,
        action: status === "DONE" ? "EXPIRY_PLAN_DONE" : "EXPIRY_PLAN_CANCEL",
        resourceType: "batch_expiry_plan",
        resourceId: planId,
        after: { batchNumber: plan.batch.batchNumber, action: plan.action, outcome },
      },
    });
  });
}

/** Lịch sử xử lý của một lô, để biết trước đó đã làm gì. */
export async function planHistory(storeId: string, batchId: string) {
  return prisma.batchExpiryPlan.findMany({
    where: { storeId, batchId },
    orderBy: { createdAt: "desc" },
    include: { createdByUser: { select: { fullName: true } }, resolvedByUser: { select: { fullName: true } } },
  });
}
