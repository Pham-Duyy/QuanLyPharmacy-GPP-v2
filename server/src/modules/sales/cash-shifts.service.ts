import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { codeDay, nextDocumentCode } from "../../lib/document-code.js";
import { markIdempotentResource } from "../../lib/idempotency-context.js";
import { lockCashShift } from "../../lib/locks.js";
import { num } from "../../lib/numbers.js";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import type { AuthContext } from "../auth/auth.context.js";

/**
 * Ca thu ngân, chốt két (contract §14.5). Mỗi cửa hàng một két, chỉ nhập tổng
 * tiền. Tiền mặt dự kiến tính từ hóa đơn và phiếu trả đã có, theo thời gian
 * của ca; không chặn bán khi chưa mở ca. Chi trả nhà cung cấp không tính vào
 * két — lấy tiền két thì ghi một phiếu chi trong ca.
 */

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

export type ShiftTotals = {
  openingCash: number;
  /** Hóa đơn tiền mặt bán trong ca, kể cả hóa đơn bị hủy sau đó. */
  cashSales: number;
  /** Hóa đơn tiền mặt bị hủy trong ca: tiền đã trả lại khách. */
  cashVoided: number;
  /** Tiền mặt hoàn cho khách khi trả hàng trong ca. */
  cashRefunds: number;
  cashIn: number;
  cashOut: number;
  expectedCash: number;
  /** Hóa đơn bán trong ca chưa bị hủy, và doanh thu của chúng theo hình thức. */
  invoiceCount: number;
  salesByMethod: { CASH: number; BANK_TRANSFER: number; CARD: number };
  voidedCount: number;
  refundCount: number;
};

/** Tính số liệu của khoảng [from, to) tại một cửa hàng, cộng phiếu thu chi của ca. */
async function computeTotals(
  db: Db,
  storeId: string,
  shiftId: string,
  openingCash: number,
  from: Date,
  to: Date,
): Promise<ShiftTotals> {
  const [sold, voided, refunds, moves] = await Promise.all([
    db.$queryRaw<
      Array<{
        cash_sales: bigint;
        invoice_count: bigint;
        cash_kept: bigint;
        transfer_kept: bigint;
        card_kept: bigint;
      }>
    >(Prisma.sql`
      SELECT
        coalesce(sum(total_amount) FILTER (WHERE payment_method = 'CASH'), 0) AS cash_sales,
        count(*) FILTER (WHERE voided_at IS NULL) AS invoice_count,
        coalesce(sum(total_amount) FILTER (WHERE voided_at IS NULL AND payment_method = 'CASH'), 0) AS cash_kept,
        coalesce(sum(total_amount) FILTER (WHERE voided_at IS NULL AND payment_method = 'BANK_TRANSFER'), 0) AS transfer_kept,
        coalesce(sum(total_amount) FILTER (WHERE voided_at IS NULL AND payment_method = 'CARD'), 0) AS card_kept
      FROM invoices
      WHERE store_id = ${storeId}::uuid AND sold_at >= ${from} AND sold_at < ${to}
    `),
    db.$queryRaw<Array<{ cash_voided: bigint; voided_count: bigint }>>(Prisma.sql`
      SELECT
        coalesce(sum(total_amount) FILTER (WHERE payment_method = 'CASH'), 0) AS cash_voided,
        count(*) AS voided_count
      FROM invoices
      WHERE store_id = ${storeId}::uuid AND voided_at >= ${from} AND voided_at < ${to}
    `),
    db.$queryRaw<Array<{ cash_refunds: bigint; refund_count: bigint }>>(Prisma.sql`
      SELECT
        coalesce(sum(refund_amount) FILTER (WHERE refund_method = 'CASH'), 0) AS cash_refunds,
        count(*) AS refund_count
      FROM returns
      WHERE store_id = ${storeId}::uuid AND created_at >= ${from} AND created_at < ${to}
    `),
    db.cashMovement.groupBy({
      by: ["direction"],
      where: { shiftId, storeId },
      _sum: { amount: true },
    }),
  ]);
  const s = sold[0]!;
  const v = voided[0]!;
  const r = refunds[0]!;
  const moved = (direction: "IN" | "OUT") =>
    num(moves.find((row) => row.direction === direction)?._sum.amount);
  const cashSales = num(s.cash_sales);
  const cashVoided = num(v.cash_voided);
  const cashRefunds = num(r.cash_refunds);
  const cashIn = moved("IN");
  const cashOut = moved("OUT");
  return {
    openingCash,
    cashSales,
    cashVoided,
    cashRefunds,
    cashIn,
    cashOut,
    expectedCash: openingCash + cashSales - cashVoided - cashRefunds + cashIn - cashOut,
    invoiceCount: Number(s.invoice_count),
    salesByMethod: {
      CASH: num(s.cash_kept),
      BANK_TRANSFER: num(s.transfer_kept),
      CARD: num(s.card_kept),
    },
    voidedCount: Number(v.voided_count),
    refundCount: Number(r.refund_count),
  };
}

const SHIFT_INCLUDE = {
  openedByUser: { select: { id: true, fullName: true } },
  closedByUser: { select: { id: true, fullName: true } },
  movements: {
    orderBy: { createdAt: "asc" },
    include: { createdByUser: { select: { fullName: true } } },
  },
} satisfies Prisma.CashShiftInclude;

type ShiftRow = Prisma.CashShiftGetPayload<{ include: typeof SHIFT_INCLUDE }>;

async function toView(db: Db, shift: ShiftRow) {
  // Ca đã chốt dùng số chụp lại lúc chốt; ca đang mở tính tới hiện tại.
  const totals =
    shift.status === "CLOSED" && shift.summary
      ? (shift.summary as unknown as ShiftTotals)
      : await computeTotals(
          db,
          shift.storeId,
          shift.id,
          num(shift.openingCash),
          shift.openedAt,
          new Date(),
        );
  return {
    id: shift.id,
    code: shift.code,
    status: shift.status as "OPEN" | "CLOSED",
    openedAt: shift.openedAt,
    openedBy: shift.openedByUser,
    closedAt: shift.closedAt,
    closedBy: shift.closedByUser,
    countedCash: shift.countedCash === null ? null : num(shift.countedCash),
    difference: shift.difference === null ? null : num(shift.difference),
    closeNote: shift.closeNote,
    totals,
    movements: shift.movements.map((move) => ({
      id: move.id,
      direction: move.direction as "IN" | "OUT",
      amount: num(move.amount),
      reason: move.reason,
      createdAt: move.createdAt,
      createdByName: move.createdByUser.fullName,
    })),
  };
}

export type ShiftView = Awaited<ReturnType<typeof toView>>;

/**
 * Ca đang mở của cửa hàng. Chưa mở ca thì báo kèm số tiền đếm được lúc chốt
 * ca trước và tiền mặt đã bán từ lúc đó — tổng hai số là tiền đang có trong
 * két, giao diện điền sẵn làm tiền đầu ca.
 */
export async function current(storeId: string) {
  const openShift = await prisma.cashShift.findFirst({
    where: { storeId, status: "OPEN" },
    include: SHIFT_INCLUDE,
  });
  if (openShift)
    return { shift: await toView(prisma, openShift), outsideShift: null, lastCountedCash: null };

  const last = await prisma.cashShift.findFirst({
    where: { storeId, status: "CLOSED" },
    orderBy: { closedAt: "desc" },
    select: { closedAt: true, countedCash: true },
  });
  if (!last?.closedAt) return { shift: null, outsideShift: null, lastCountedCash: null };
  const [row] = await prisma.$queryRaw<Array<{ invoice_count: bigint; cash: bigint }>>(Prisma.sql`
    SELECT count(*) AS invoice_count, coalesce(sum(total_amount), 0) AS cash
    FROM invoices
    WHERE store_id = ${storeId}::uuid AND payment_method = 'CASH' AND voided_at IS NULL
      AND sold_at >= ${last.closedAt}
  `);
  const invoiceCount = Number(row!.invoice_count);
  return {
    shift: null,
    lastCountedCash: num(last.countedCash),
    outsideShift: invoiceCount
      ? { since: last.closedAt, invoiceCount, cash: num(row!.cash) }
      : null,
  };
}

export async function open(storeId: string, auth: AuthContext, openingCash: number) {
  const id = await withMappedErrors(
    () =>
      prisma.$transaction(async (tx) => {
        const store = await tx.store.findUniqueOrThrow({ where: { id: storeId } });
        const shift = await tx.cashShift.create({
          data: {
            storeId,
            code: await nextDocumentCode(tx, storeId, `CA-${store.code}-${codeDay()}-`),
            openedBy: auth.userId,
            openingCash: BigInt(openingCash),
          },
        });
        await markIdempotentResource(tx, "cash_shift", shift.id);
        await tx.auditLog.create({
          data: {
            storeId,
            actorId: auth.userId,
            action: "CASH_SHIFT_OPEN",
            resourceType: "cash_shift",
            resourceId: shift.id,
            after: { code: shift.code, openingCash },
          },
        });
        return shift.id;
      }),
    { conflictMessage: "Cửa hàng đang có ca mở; chốt ca đó trước khi mở ca mới" },
  );
  return detail(storeId, id);
}

/** Phiếu thu/chi tiền mặt khác trong ca: chỉ ghi khi ca còn mở, không sửa, không xóa. */
export async function addMovement(
  storeId: string,
  shiftId: string,
  auth: AuthContext,
  input: { direction: "IN" | "OUT"; amount: number; reason: string },
) {
  await prisma.$transaction(async (tx) => {
    await lockCashShift(tx, storeId, shiftId);
    const shift = await tx.cashShift.findUniqueOrThrow({ where: { id: shiftId } });
    if (shift.status !== "OPEN")
      throw AppError.invalidState("Ca đã chốt, không ghi thu chi được nữa");
    const move = await tx.cashMovement.create({
      data: {
        shiftId,
        storeId,
        direction: input.direction,
        amount: BigInt(input.amount),
        reason: input.reason,
        createdBy: auth.userId,
      },
    });
    await markIdempotentResource(tx, "cash_movement", move.id);
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: auth.userId,
        action: input.direction === "IN" ? "CASH_IN" : "CASH_OUT",
        resourceType: "cash_shift",
        resourceId: shiftId,
        reason: input.reason,
        after: { amount: input.amount },
      },
    });
  });
  return detail(storeId, shiftId);
}

/**
 * Chốt ca: tính tiền mặt dự kiến tới đúng lúc chốt, so với số người chốt đếm
 * được. Lệch tiền thì bắt buộc ghi lý do. Số liệu được chụp lại vào ca, nên
 * hủy hóa đơn cũ về sau không làm đổi phiếu chốt đã in.
 */
export async function close(
  storeId: string,
  shiftId: string,
  auth: AuthContext,
  input: { countedCash: number; note?: string | null | undefined },
) {
  await prisma.$transaction(async (tx) => {
    await lockCashShift(tx, storeId, shiftId);
    const shift = await tx.cashShift.findUniqueOrThrow({ where: { id: shiftId } });
    if (shift.status !== "OPEN") throw AppError.invalidState("Ca này đã chốt");
    const closedAt = new Date();
    const totals = await computeTotals(
      tx,
      storeId,
      shiftId,
      num(shift.openingCash),
      shift.openedAt,
      closedAt,
    );
    const difference = input.countedCash - totals.expectedCash;
    const note = input.note?.trim() || null;
    if (difference !== 0 && !note) {
      throw new AppError(
        422,
        "VALIDATION_ERROR",
        "Tiền thực tế lệch với dự kiến, ghi lý do trước khi chốt ca",
        [{ field: "note", message: "Ghi lý do chênh lệch" }],
      );
    }
    await tx.cashShift.update({
      where: { id: shiftId },
      data: {
        status: "CLOSED",
        closedAt,
        closedBy: auth.userId,
        expectedCash: BigInt(totals.expectedCash),
        countedCash: BigInt(input.countedCash),
        difference: BigInt(difference),
        closeNote: note,
        summary: totals as unknown as Prisma.InputJsonValue,
      },
    });
    await markIdempotentResource(tx, "cash_shift", shiftId);
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: auth.userId,
        action: "CASH_SHIFT_CLOSE",
        resourceType: "cash_shift",
        resourceId: shiftId,
        reason: note,
        after: { expectedCash: totals.expectedCash, countedCash: input.countedCash, difference },
      },
    });
  });
  return detail(storeId, shiftId);
}

export async function list(
  storeId: string,
  query: { from?: Date | undefined; to?: Date | undefined },
) {
  const rows = await prisma.cashShift.findMany({
    where: {
      storeId,
      ...(query.from || query.to
        ? {
            openedAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lt: query.to } : {}),
            },
          }
        : {}),
    },
    orderBy: { openedAt: "desc" },
    take: 200,
    include: {
      openedByUser: { select: { fullName: true } },
      closedByUser: { select: { fullName: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    status: row.status as "OPEN" | "CLOSED",
    openedAt: row.openedAt,
    openedByName: row.openedByUser.fullName,
    openingCash: num(row.openingCash),
    closedAt: row.closedAt,
    closedByName: row.closedByUser?.fullName ?? null,
    expectedCash: row.expectedCash === null ? null : num(row.expectedCash),
    countedCash: row.countedCash === null ? null : num(row.countedCash),
    difference: row.difference === null ? null : num(row.difference),
  }));
}

export async function detail(storeId: string, shiftId: string): Promise<ShiftView> {
  const shift = await prisma.cashShift.findFirst({
    where: { id: shiftId, storeId },
    include: SHIFT_INCLUDE,
  });
  if (!shift) throw AppError.notFound("Không tìm thấy ca thu ngân");
  return toView(prisma, shift);
}
