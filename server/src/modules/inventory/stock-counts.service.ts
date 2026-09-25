import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { codeDay, nextDocumentCode } from "../../lib/document-code.js";
import { lockStockCount } from "../../lib/locks.js";
import type { AuthContext } from "../auth/auth.context.js";
import type { OpenCountInput, SaveCountsInput } from "./stock-counts.schema.js";

type Tx = Prisma.TransactionClient;

const COMMIT_TIMEOUT_MS = 60_000;

async function nextCountCode(tx: Tx, storeId: string, storeCode: string): Promise<string> {
  return nextDocumentCode(tx, storeId, `KK-${storeCode}-${codeDay()}-`);
}

/**
 * Mở đợt kiểm kê: chụp danh sách lô đang có tồn trong phạm vi đã chọn.
 * Lô biệt trữ vẫn phải đếm vì hàng vẫn nằm trên kệ, chỉ là chưa bán được.
 */
export async function openCount(storeId: string, userId: string, input: OpenCountInput): Promise<string> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });

  let scopeLabel: string | null = null;
  if (input.scopeType === "CATEGORY") {
    const category = await prisma.category.findUnique({ where: { id: input.scopeValue! } });
    if (!category) throw AppError.notFound("Không tìm thấy nhóm hàng cần kiểm kê");
    scopeLabel = category.name;
  } else if (input.scopeType === "SHELF") {
    scopeLabel = input.scopeValue!;
  }

  const batches = await prisma.batch.findMany({
    where: {
      storeId,
      quantityOnHand: { gt: 0 },
      ...(input.scopeType === "CATEGORY" ? { product: { categoryId: input.scopeValue! } } : {}),
      ...(input.scopeType === "SHELF" ? { shelfLocation: { equals: input.scopeValue!, mode: "insensitive" } } : {}),
    },
    include: { product: { select: { name: true } } },
    orderBy: [{ shelfLocation: "asc" }, { expiryDate: "asc" }],
  });
  if (batches.length === 0) {
    throw AppError.validation("Phạm vi này chưa có lô nào còn tồn để kiểm kê");
  }

  // Xếp theo kệ rồi tên thuốc: người đếm đi dọc kệ, không phải nhảy qua lại.
  const sorted = [...batches].sort(
    (a, b) =>
      (a.shelfLocation ?? "zzz").localeCompare(b.shelfLocation ?? "zzz", "vi") ||
      a.product.name.localeCompare(b.product.name, "vi") ||
      a.expiryDate.getTime() - b.expiryDate.getTime(),
  );

  return prisma.$transaction(
    async (tx) => {
      // Mỗi cửa hàng chỉ được có một đợt đang đếm. Kiểm tra ngay trong
      // transaction; chỉ mục một phần stock_counts_one_open_per_store là chốt
      // chặn cuối nếu hai người bấm mở cùng lúc.
      const open = await tx.stockCount.findFirst({ where: { storeId, status: "COUNTING" } });
      if (open) {
        throw AppError.invalidState(`Đang có đợt kiểm kê ${open.code} chưa chốt. Chốt hoặc hủy đợt đó trước khi mở đợt mới.`);
      }

      const count = await tx.stockCount.create({
        data: {
          storeId,
          code: await nextCountCode(tx, storeId, store.code),
          scopeType: input.scopeType,
          scopeValue: input.scopeValue ?? null,
          scopeLabel,
          note: input.note ?? null,
          createdBy: userId,
          lines: {
            create: sorted.map((batch, index) => ({
              lineNo: index + 1,
              batchId: batch.id,
              productId: batch.productId,
              shelfLocation: batch.shelfLocation,
              systemBaseQuantityAtOpen: batch.quantityOnHand,
            })),
          },
        },
      });
      return count.id;
    },
    { timeout: COMMIT_TIMEOUT_MS, maxWait: 10_000 },
  );
}

/**
 * Khóa đợt kiểm kê rồi đọc trạng thái **trong cùng transaction**.
 *
 * Trước đây việc kiểm tra nằm ngoài transaction: hai người bấm "Chốt đợt"
 * cùng lúc đều thấy đợt còn mở nên sinh ra hai phiếu điều chỉnh cho một đợt,
 * và số đếm vẫn ghi được sau khi đợt đã chốt.
 */
async function requireOpenCountTx(tx: Tx, storeId: string, countId: string) {
  await lockStockCount(tx, storeId, countId);
  const count = await tx.stockCount.findFirst({ where: { id: countId, storeId } });
  if (!count) throw AppError.notFound("Không tìm thấy đợt kiểm kê");
  if (count.status !== "COUNTING") throw AppError.invalidState(`Đợt kiểm kê đã ${count.status === "CLOSED" ? "chốt" : "hủy"}, không sửa được nữa`);
  return count;
}

/** Thêm lô phát hiện trên kệ nhưng hệ thống báo hết tồn hoặc ngoài phạm vi đợt. */
export async function addLine(storeId: string, countId: string, batchId: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await requireOpenCountTx(tx, storeId, countId);
    const batch = await tx.batch.findFirst({ where: { id: batchId, storeId } });
    if (!batch) throw AppError.notFound("Không tìm thấy lô trong kho cửa hàng này");

    const existing = await tx.stockCountLine.findFirst({ where: { stockCountId: countId, batchId } });
    if (existing) return existing.id;

    const last = await tx.stockCountLine.findFirst({ where: { stockCountId: countId }, orderBy: { lineNo: "desc" }, select: { lineNo: true } });
    const line = await tx.stockCountLine.create({
      data: {
        stockCountId: countId,
        lineNo: (last?.lineNo ?? 0) + 1,
        batchId,
        productId: batch.productId,
        shelfLocation: batch.shelfLocation,
        systemBaseQuantityAtOpen: batch.quantityOnHand,
      },
    });
    return line.id;
  });
}

export type SaveResult = { saved: number; cleared: number };

/**
 * Ghi số đếm. Mốc so sánh của từng dòng là tồn hệ thống **tại thời điểm ghi
 * số đếm**, không phải lúc mở đợt: hàng bán ra sau khi đếm xong một mặt
 * hàng không bị tính thành thất thoát.
 */
export async function saveCounts(storeId: string, countId: string, userId: string, input: SaveCountsInput): Promise<SaveResult> {
  const lineIds = input.entries.map((entry) => entry.lineId);
  const lines = await prisma.stockCountLine.findMany({
    where: { id: { in: lineIds }, stockCountId: countId },
    include: { batch: { select: { id: true, productId: true, quantityOnHand: true } } },
  });
  const byId = new Map(lines.map((line) => [line.id, line]));

  const unitIds = [...new Set(input.entries.map((entry) => entry.unitId).filter((value): value is string => Boolean(value)))];
  const units = await prisma.productUnit.findMany({ where: { id: { in: unitIds } } });
  const unitById = new Map(units.map((unit) => [unit.id, unit]));

  let saved = 0;
  let cleared = 0;
  const now = new Date();

  await prisma.$transaction(
    async (tx) => {
      // Đợt có thể vừa bị chốt hoặc hủy ngay trước lệnh ghi này.
      await requireOpenCountTx(tx, storeId, countId);

      for (const entry of input.entries) {
        const line = byId.get(entry.lineId);
        if (!line) throw AppError.notFound(`Không tìm thấy dòng kiểm kê ${entry.lineId}`);

        if (entry.clear) {
          await tx.stockCountLine.update({
            where: { id: line.id },
            data: {
              countedUnitId: null,
              countedQuantity: null,
              countedBaseQuantity: null,
              countedAt: null,
              countedBy: null,
              systemBaseQuantityAtCount: null,
              ...(entry.note === undefined ? {} : { note: entry.note ?? null }),
            },
          });
          cleared++;
          continue;
        }

        if (entry.quantity === null || entry.quantity === undefined) {
          throw AppError.validation("Thiếu số lượng đếm được");
        }
        const unit = entry.unitId ? unitById.get(entry.unitId) : undefined;
        if (!unit) throw AppError.validation("Thiếu đơn vị đếm");
        if (unit.productId !== line.productId) {
          throw new AppError(422, "UNIT_NOT_IN_PRODUCT", "Đơn vị đếm không thuộc sản phẩm của lô");
        }

        // Đọc lại tồn ngay lúc ghi, không dùng số đã đọc ở đầu hàm.
        const batch = await tx.batch.findUniqueOrThrow({ where: { id: line.batchId }, select: { quantityOnHand: true } });
        await tx.stockCountLine.update({
          where: { id: line.id },
          data: {
            countedUnitId: unit.id,
            countedQuantity: entry.quantity,
            countedBaseQuantity: entry.quantity * unit.conversionToBase,
            countedAt: now,
            countedBy: userId,
            systemBaseQuantityAtCount: batch.quantityOnHand,
            ...(entry.note === undefined ? {} : { note: entry.note ?? null }),
          },
        });
        saved++;
      }
    },
    { timeout: COMMIT_TIMEOUT_MS, maxWait: 10_000 },
  );

  return { saved, cleared };
}

export type CloseResult = { countId: string; adjustmentId: string | null; differenceLines: number };

/**
 * Chốt đợt: các dòng có chênh lệch được đưa sang một phiếu điều chỉnh tồn
 * `DRAFT` để người khác duyệt (P4 — người duyệt khác người lập). Dòng chưa
 * đếm **không** bị coi là đếm được 0; chúng chỉ đơn giản không vào phiếu.
 */
export async function closeCount(storeId: string, countId: string, auth: AuthContext, note: string | null): Promise<CloseResult> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });

  return prisma.$transaction(
    async (tx) => {
      const count = await requireOpenCountTx(tx, storeId, countId);

      const lines = await tx.stockCountLine.findMany({
        where: { stockCountId: countId, countedBaseQuantity: { not: null } },
        include: { batch: { select: { productId: true } } },
        orderBy: { lineNo: "asc" },
      });
      if (lines.length === 0) throw AppError.validation("Chưa đếm dòng nào, không chốt được đợt kiểm kê");

      const differences = lines.filter((line) => line.countedBaseQuantity !== line.systemBaseQuantityAtCount);
      let adjustmentId: string | null = null;

      if (differences.length > 0) {
        const adjustmentCode = await nextDocumentCode(tx, storeId, `DC-${store.code}-${codeDay()}-`);

        const adjustment = await tx.stockAdjustment.create({
          data: {
            storeId,
            code: adjustmentCode,
            status: "DRAFT",
            reason: `Chênh lệch kiểm kê ${count.code}${note ? ` — ${note}` : ""}`,
            createdBy: auth.userId,
            lines: {
              create: differences.map((line, index) => ({
                lineNo: index + 1,
                batchId: line.batchId,
                // Ghi số đếm theo đúng đơn vị người đếm đã dùng, để người
                // duyệt đối chiếu được với biên bản kiểm kê.
                productUnitId: line.countedUnitId!,
                reasonCode: "COUNT_DIFFERENCE",
                countedQuantity: line.countedQuantity!,
                systemBaseQuantityAtCount: line.systemBaseQuantityAtCount!,
              })),
            },
          },
        });
        adjustmentId = adjustment.id;
      }

      // Chuyển trạng thái có điều kiện: đợt phải còn COUNTING đúng lúc ghi.
      const moved = await tx.stockCount.updateMany({
        where: { id: countId, storeId, status: "COUNTING" },
        data: {
          status: "CLOSED",
          closedBy: auth.userId,
          closedAt: new Date(),
          adjustmentId,
          ...(note ? { note } : {}),
          version: { increment: 1 },
        },
      });
      if (moved.count === 0) throw AppError.invalidState("Đợt kiểm kê vừa được chốt hoặc hủy bởi người khác");

      await tx.auditLog.create({
        data: {
          storeId,
          actorId: auth.userId,
          action: "STOCK_COUNT_CLOSE",
          resourceType: "stock_count",
          resourceId: countId,
          after: { code: count.code, countedLines: lines.length, differenceLines: differences.length, adjustmentId },
        },
      });

      return { countId, adjustmentId, differenceLines: differences.length };
    },
    { timeout: COMMIT_TIMEOUT_MS, maxWait: 10_000 },
  );
}

export async function cancelCount(storeId: string, countId: string, auth: AuthContext, reason: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const count = await requireOpenCountTx(tx, storeId, countId);
    const moved = await tx.stockCount.updateMany({
      where: { id: countId, storeId, status: "COUNTING" },
      data: { status: "CANCELLED", closedBy: auth.userId, closedAt: new Date(), note: reason ?? count.note, version: { increment: 1 } },
    });
    if (moved.count === 0) throw AppError.invalidState("Đợt kiểm kê vừa được chốt hoặc hủy bởi người khác");
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: auth.userId,
        action: "STOCK_COUNT_CANCEL",
        resourceType: "stock_count",
        resourceId: countId,
        after: { code: count.code, reason },
      },
    });
  });
}

export type CountLineView = {
  id: string;
  lineNo: number;
  batchId: string;
  productId: string;
  productCode: string;
  productName: string;
  batchNumber: string;
  expiryDate: Date;
  shelfLocation: string | null;
  baseUnitName: string;
  units: Array<{ id: string; name: string; conversionToBase: number }>;
  systemBaseQuantityAtOpen: number;
  systemBaseQuantityNow: number;
  systemBaseQuantityAtCount: number | null;
  countedUnitId: string | null;
  countedQuantity: number | null;
  countedBaseQuantity: number | null;
  countedAt: Date | null;
  countedByName: string | null;
  differenceBaseQuantity: number | null;
  /** Giá trị chênh lệch theo giá vốn lô; null khi không có quyền xem giá vốn. */
  differenceValue: number | null;
  note: string | null;
};

export async function getDetail(storeId: string, countId: string, auth: AuthContext) {
  const count = await prisma.stockCount.findFirst({
    where: { id: countId, storeId },
    include: {
      createdByUser: { select: { fullName: true } },
      closedByUser: { select: { fullName: true } },
      adjustment: { select: { id: true, code: true, status: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          countedByUser: { select: { fullName: true } },
          batch: { select: { batchNumber: true, expiryDate: true, quantityOnHand: true, unitCost: true, shelfLocation: true } },
          product: {
            select: {
              code: true,
              name: true,
              units: { where: { isActive: true }, select: { id: true, name: true, conversionToBase: true }, orderBy: { conversionToBase: "asc" } },
            },
          },
        },
      },
    },
  });
  if (!count) throw AppError.notFound("Không tìm thấy đợt kiểm kê");

  const showCost = auth.can("stock.cost.read");
  const lines: CountLineView[] = count.lines.map((line) => {
    const difference = line.countedBaseQuantity === null || line.systemBaseQuantityAtCount === null ? null : line.countedBaseQuantity - line.systemBaseQuantityAtCount;
    const unitCost = line.batch.unitCost === null ? null : Number(line.batch.unitCost);
    return {
      id: line.id,
      lineNo: line.lineNo,
      batchId: line.batchId,
      productId: line.productId,
      productCode: line.product.code,
      productName: line.product.name,
      batchNumber: line.batch.batchNumber,
      expiryDate: line.batch.expiryDate,
      shelfLocation: line.shelfLocation ?? line.batch.shelfLocation,
      baseUnitName: line.product.units.find((unit) => unit.conversionToBase === 1)?.name ?? "",
      units: line.product.units,
      systemBaseQuantityAtOpen: line.systemBaseQuantityAtOpen,
      systemBaseQuantityNow: line.batch.quantityOnHand,
      systemBaseQuantityAtCount: line.systemBaseQuantityAtCount,
      countedUnitId: line.countedUnitId,
      countedQuantity: line.countedQuantity,
      countedBaseQuantity: line.countedBaseQuantity,
      countedAt: line.countedAt,
      countedByName: line.countedByUser?.fullName ?? null,
      differenceBaseQuantity: difference,
      differenceValue: showCost && difference !== null && unitCost !== null ? Math.round(difference * unitCost) : null,
      note: line.note,
    };
  });

  return { count: toHeader(count), lines, summary: summarize(lines, showCost) };
}

type CountHeaderSource = {
  id: string;
  code: string;
  status: string;
  scopeType: string;
  scopeLabel: string | null;
  note: string | null;
  startedAt: Date;
  closedAt: Date | null;
  createdByUser: { fullName: string };
  closedByUser: { fullName: string } | null;
  adjustment?: { id: string; code: string; status: string } | null;
  _count?: { lines: number };
};

function toHeader(count: CountHeaderSource) {
  return {
    id: count.id,
    code: count.code,
    status: count.status,
    scopeType: count.scopeType,
    scopeLabel: count.scopeLabel,
    note: count.note,
    startedAt: count.startedAt,
    closedAt: count.closedAt,
    createdByName: count.createdByUser.fullName,
    closedByName: count.closedByUser?.fullName ?? null,
    adjustment: count.adjustment ?? null,
  };
}

export function summarize(lines: CountLineView[], showCost: boolean) {
  const counted = lines.filter((line) => line.countedBaseQuantity !== null);
  const differences = counted.filter((line) => (line.differenceBaseQuantity ?? 0) !== 0);
  const surplus = differences.filter((line) => line.differenceBaseQuantity! > 0);
  const shortage = differences.filter((line) => line.differenceBaseQuantity! < 0);
  return {
    totalLines: lines.length,
    countedLines: counted.length,
    pendingLines: lines.length - counted.length,
    differenceLines: differences.length,
    surplusLines: surplus.length,
    shortageLines: shortage.length,
    surplusBaseQuantity: surplus.reduce((sum, line) => sum + line.differenceBaseQuantity!, 0),
    shortageBaseQuantity: shortage.reduce((sum, line) => sum + Math.abs(line.differenceBaseQuantity!), 0),
    differenceValue: showCost ? differences.reduce((sum, line) => sum + (line.differenceValue ?? 0), 0) : null,
  };
}

export async function list(storeId: string, query: { status?: string }) {
  const counts = await prisma.stockCount.findMany({
    where: { storeId, ...(query.status ? { status: query.status } : {}) },
    orderBy: { startedAt: "desc" },
    take: 50,
    include: {
      createdByUser: { select: { fullName: true } },
      closedByUser: { select: { fullName: true } },
      adjustment: { select: { id: true, code: true, status: true } },
      _count: { select: { lines: true } },
      lines: { select: { countedBaseQuantity: true, systemBaseQuantityAtCount: true } },
    },
  });

  return counts.map((count) => {
    const counted = count.lines.filter((line) => line.countedBaseQuantity !== null);
    return {
      ...toHeader(count),
      totalLines: count._count.lines,
      countedLines: counted.length,
      differenceLines: counted.filter((line) => line.countedBaseQuantity !== line.systemBaseQuantityAtCount).length,
    };
  });
}

/** Đợt đang đếm của cửa hàng, để giao diện mở thẳng vào việc đang dở. */
export async function getOpen(storeId: string) {
  const open = await prisma.stockCount.findFirst({ where: { storeId, status: "COUNTING" }, select: { id: true, code: true } });
  return open ?? null;
}
