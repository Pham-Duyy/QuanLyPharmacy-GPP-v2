import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { dateKey } from "../../lib/dates.js";
import { businessDateNow } from "../../lib/settings.js";
import type { AuthContext } from "../auth/auth.context.js";
import { splitUnits, UNIT_FIELDS, type PackUnit } from "../catalog/pack-units.js";

/**
 * Cảnh báo hàng cận hạn, kèm kế hoạch xử lý từng lô.
 *
 * Hàng cận hạn là tiền đang treo: nếu không trả nhà cung cấp, đẩy bán hoặc
 * giảm giá kịp thì tới hạn phải hủy, mất trắng. Vì vậy danh sách không chỉ
 * đếm lô mà còn quy ra giá trị tồn, và mỗi lô có một kế hoạch có người chịu
 * trách nhiệm cùng ngày hẹn.
 */

export const EXPIRY_ACTIONS = [
  "RETURN_SUPPLIER",
  "PRIORITIZE_SALE",
  "DISCOUNT",
  "DISPOSE",
] as const;
type ExpiryAction = (typeof EXPIRY_ACTIONS)[number];

/** Mốc chia nhóm theo số ngày còn lại. */
const BUCKETS = [
  { key: "EXPIRED", label: "Đã hết hạn", maxDays: 0 },
  { key: "D30", label: "Còn dưới 30 ngày", maxDays: 30 },
  { key: "D60", label: "Còn 31 – 60 ngày", maxDays: 60 },
  { key: "D90", label: "Còn 61 – 90 ngày", maxDays: 90 },
] as const;

export type BucketKey = (typeof BUCKETS)[number]["key"];

type ExpiryPlanView = {
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

/**
 * Cách xếp các lô trong cùng một nhóm. `quantity` so theo đơn vị cơ sở (viên,
 * gói…) nên chỉ so được giữa các thuốc cùng đơn vị; `value` cần quyền xem giá vốn.
 */
export const EXPIRY_SORTS = ["quantity", "expiry", "value"] as const;
type ExpirySort = (typeof EXPIRY_SORTS)[number];

/** Nhóm hiển thị: "EXPIRED" cho mọi lô đã hết hạn, còn lại là tháng hết hạn "YYYY-MM". */
type ExpiryGroup = {
  key: string;
  label: string;
  batches: number;
  /** Tổng giá trị tồn cả nhóm; null khi không có quyền xem giá vốn. */
  value: number | null;
  /** Số lô chưa có giá vốn: khi lớn hơn 0 thì `value` chưa đủ. */
  withoutCost: number;
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
  group: string;
  quantityOnHand: number;
  baseUnitName: string;
  /** Đơn vị lớn (hộp, vỉ…) để giao diện quy đổi số tồn khi đối chiếu kệ. */
  packUnits: PackUnit[];
  shelfLocation: string | null;
  batchStatus: string;
  /** Giá trị tồn theo giá vốn lô; null khi không có quyền xem giá vốn hoặc lô chưa có giá vốn. */
  stockValue: number | null;
  lastSupplier: { id: string; name: string } | null;
  plan: ExpiryPlanView | null;
};

export type ExpiryQuery = {
  horizonDays: number;
  bucket?: BucketKey | undefined;
  onlyWithoutPlan: boolean;
  sort: ExpirySort;
};

/** Hết hạn từ chính ngày ghi trên bao bì (còn 0 ngày), cùng cách tính với quầy bán. */
function bucketOf(daysLeft: number): BucketKey {
  if (daysLeft <= 0) return "EXPIRED";
  if (daysLeft <= 30) return "D30";
  if (daysLeft <= 60) return "D60";
  return "D90";
}

/** Lô hết hạn gom chung một nhóm dù hết từ tháng nào: phải tách khỏi khu bán ngay. */
function groupOf(bucket: BucketKey, expiryDate: Date): string {
  return bucket === "EXPIRED" ? "EXPIRED" : dateKey(expiryDate).slice(0, 7);
}

function groupLabel(key: string): string {
  if (key === "EXPIRED") return "Đã hết hạn";
  const [year, month] = key.split("-");
  return `Tháng ${month}/${year}`;
}

type Compare = (a: ExpiryRow, b: ExpiryRow) => number;
const byExpiry: Compare = (a, b) => a.expiryDate.getTime() - b.expiryDate.getTime();
const byQuantity: Compare = (a, b) => b.quantityOnHand - a.quantityOnHand;
// Lô chưa có giá vốn xuống cuối, không coi như giá trị 0.
const byValue: Compare = (a, b) => (b.stockValue ?? -1) - (a.stockValue ?? -1);
const WITHIN_GROUP: Record<ExpirySort, Compare[]> = {
  quantity: [byQuantity, byExpiry],
  expiry: [byExpiry, byQuantity],
  value: [byValue, byExpiry],
};

/**
 * Nhóm "Đã hết hạn" đứng đầu, rồi các tháng tăng dần; trong nhóm xếp theo
 * `sort`. Chỉ là cách xem danh sách: quầy bán vẫn xuất lô theo FEFO.
 */
function compareRows(sort: ExpirySort): Compare {
  const rank = (row: ExpiryRow) => (row.group === "EXPIRED" ? "" : row.group);
  return (a, b) => {
    if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
    for (const compare of WITHIN_GROUP[sort]) {
      const result = compare(a, b);
      if (result !== 0) return result;
    }
    return a.batchNumber.localeCompare(b.batchNumber) || a.productCode.localeCompare(b.productCode);
  };
}

export async function listExpiring(storeId: string, auth: AuthContext, query: ExpiryQuery) {
  const today = businessDateNow();
  const limit = new Date(today.getTime() + query.horizonDays * 86_400_000);
  const showCost = auth.can("stock.cost.read");
  // Thứ tự theo giá trị cũng để lộ giá vốn, nên chặn cả ở đây chứ không chỉ ẩn nút.
  if (query.sort === "value" && !showCost)
    throw new AppError(403, "FORBIDDEN", "Sắp theo giá trị tồn cần quyền xem giá vốn");

  const batches = await prisma.batch.findMany({
    where: { storeId, quantityOnHand: { gt: 0 }, expiryDate: { lte: limit } },
    include: {
      product: {
        select: {
          id: true,
          code: true,
          name: true,
          units: UNIT_FIELDS,
        },
      },
      expiryPlans: {
        where: { status: "PLANNED" },
        include: {
          createdByUser: { select: { fullName: true } },
          resolvedByUser: { select: { fullName: true } },
        },
      },
    },
  });

  // Nhà cung cấp của lô, để biết gọi ai khi muốn trả hàng.
  const receiptLines = await prisma.goodsReceiptLine.findMany({
    where: { batchId: { in: batches.map((batch) => batch.id) } },
    select: {
      batchId: true,
      goodsReceipt: {
        select: { receivedAt: true, supplier: { select: { id: true, name: true } } },
      },
    },
    orderBy: { goodsReceipt: { receivedAt: "desc" } },
  });
  const supplierByBatch = new Map<string, { id: string; name: string }>();
  for (const line of receiptLines) {
    const supplier = line.goodsReceipt.supplier;
    if (supplier && line.batchId && !supplierByBatch.has(line.batchId))
      supplierByBatch.set(line.batchId, supplier);
  }

  const rows: ExpiryRow[] = batches.map((batch) => {
    const daysLeft = Math.round((batch.expiryDate.getTime() - today.getTime()) / 86_400_000);
    const unitCost = batch.unitCost === null ? null : Number(batch.unitCost);
    const plan = batch.expiryPlans[0];
    const bucket = bucketOf(daysLeft);
    const units = splitUnits(batch.product.units);
    return {
      batchId: batch.id,
      productId: batch.productId,
      productCode: batch.product.code,
      productName: batch.product.name,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      daysLeft,
      bucket,
      group: groupOf(bucket, batch.expiryDate),
      quantityOnHand: batch.quantityOnHand,
      baseUnitName: units.baseUnitName ?? "",
      packUnits: units.packUnits,
      shelfLocation: batch.shelfLocation,
      batchStatus: batch.status,
      stockValue:
        showCost && unitCost !== null ? Math.round(unitCost * batch.quantityOnHand) : null,
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

  // Gom nhóm sau khi lọc: tổng ở tiêu đề nhóm là của cả nhóm trong kết quả lọc.
  const filtered = rows
    .filter(
      (row) =>
        (query.bucket ? row.bucket === query.bucket : true) &&
        (query.onlyWithoutPlan ? !row.plan : true),
    )
    .sort(compareRows(query.sort));
  return {
    items: filtered,
    groups: groupsOf(filtered, showCost),
    summary: summarize(rows, showCost),
  };
}

/** Các nhóm theo đúng thứ tự trong `items`; nhóm không còn lô nào thì không có. */
function groupsOf(rows: ExpiryRow[], showCost: boolean): ExpiryGroup[] {
  const groups = new Map<string, ExpiryGroup>();
  for (const row of rows) {
    const group = groups.get(row.group) ?? {
      key: row.group,
      label: groupLabel(row.group),
      batches: 0,
      value: showCost ? 0 : null,
      withoutCost: 0,
    };
    group.batches += 1;
    if (showCost && row.stockValue === null) group.withoutCost += 1;
    if (group.value !== null) group.value += row.stockValue ?? 0;
    groups.set(row.group, group);
  }
  return [...groups.values()];
}

function summarize(rows: ExpiryRow[], showCost: boolean) {
  const byBucket = Object.fromEntries(
    BUCKETS.map((bucket) => {
      const items = rows.filter((row) => row.bucket === bucket.key);
      // Không cộng số lượng: viên, chai, tuýp của các thuốc khác nhau không cộng được.
      return [
        bucket.key,
        {
          label: bucket.label,
          batches: items.length,
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

export type PlanInput = {
  batchId: string;
  action: ExpiryAction;
  dueDate?: Date | null;
  note?: string | null;
};

/** Lập kế hoạch xử lý cho một lô. Lô đang có kế hoạch mở thì cập nhật kế hoạch đó. */
export async function savePlan(
  storeId: string,
  auth: AuthContext,
  input: PlanInput,
): Promise<string> {
  const batch = await prisma.batch.findFirst({ where: { id: input.batchId, storeId } });
  if (!batch) throw AppError.notFound("Không tìm thấy lô trong kho cửa hàng này");

  const existing = await prisma.batch
    .findFirst({
      where: { id: input.batchId },
      select: { expiryPlans: { where: { status: "PLANNED" }, select: { id: true } } },
    })
    .then((row) => row?.expiryPlans[0]);

  const plan = existing
    ? await prisma.batchExpiryPlan.update({
        where: { id: existing.id },
        data: {
          action: input.action,
          dueDate: input.dueDate ?? null,
          note: input.note ?? null,
          version: { increment: 1 },
        },
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
      after: {
        batchNumber: batch.batchNumber,
        action: input.action,
        dueDate: input.dueDate ?? null,
        note: input.note ?? null,
      },
    },
  });
  return plan.id;
}

export async function closePlan(
  storeId: string,
  planId: string,
  auth: AuthContext,
  status: "DONE" | "CANCELLED",
  outcome: string | null,
): Promise<void> {
  const plan = await prisma.batchExpiryPlan.findFirst({
    where: { id: planId, storeId },
    include: { batch: { select: { batchNumber: true } } },
  });
  if (!plan) throw AppError.notFound("Không tìm thấy kế hoạch xử lý");
  if (plan.status !== "PLANNED") throw AppError.invalidState("Kế hoạch này đã đóng rồi");

  await prisma.$transaction(async (tx) => {
    await tx.batchExpiryPlan.update({
      where: { id: planId },
      data: {
        status,
        outcome,
        resolvedBy: auth.userId,
        resolvedAt: new Date(),
        version: { increment: 1 },
      },
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
    include: {
      createdByUser: { select: { fullName: true } },
      resolvedByUser: { select: { fullName: true } },
    },
  });
}
