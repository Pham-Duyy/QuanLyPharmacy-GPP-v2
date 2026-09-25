import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
function percentageChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

type Totals = {
  revenue: number;
  refund: number;
  cogs: number;
  restockedCost: number;
  invoiceCount: number;
};

/**
 * Doanh thu = hóa đơn COMPLETED trong kỳ trừ tiền hoàn của phiếu trả lập
 * trong kỳ (contract §19, P13). Giá vốn lấy theo **giá vốn đã chụp lúc xuất
 * hàng** (`invoice_allocations.unit_cost`), nên nhập thêm cùng lô với giá
 * khác về sau không làm đổi lãi gộp của kỳ đã chốt. Dữ liệu phát sinh trước
 * bản nâng cấp 20260926090000 không có giá vốn chụp sẵn nên lùi về giá vốn
 * hiện tại của lô. Phần hàng trả về bán lại được (RESTOCK) được trừ ra theo
 * đúng giá vốn của lần bán gốc; hàng trả để tiêu hủy vẫn tính là giá vốn đã mất.
 */
async function getTotals(storeId: string, from: Date, to: Date): Promise<Totals> {
  const [revenueRow] = await prisma.$queryRaw<
    Array<{ revenue: bigint; invoice_count: bigint }>
  >(Prisma.sql`
    SELECT COALESCE(SUM(total_amount), 0)::bigint AS revenue, COUNT(*)::bigint AS invoice_count
    FROM invoices
    WHERE store_id = ${storeId}::uuid AND status = 'COMPLETED' AND business_date >= ${from}::date AND business_date < ${to}::date
  `);
  const [refundRow] = await prisma.$queryRaw<Array<{ refund: bigint }>>(Prisma.sql`
    SELECT COALESCE(SUM(refund_amount), 0)::bigint AS refund
    FROM returns
    WHERE store_id = ${storeId}::uuid AND business_date >= ${from}::date AND business_date < ${to}::date
  `);
  const [cogsRow] = await prisma.$queryRaw<Array<{ cogs: number }>>(Prisma.sql`
    SELECT COALESCE(SUM(ia.base_quantity * COALESCE(ia.unit_cost, b.unit_cost, 0)), 0)::float8 AS cogs
    FROM invoice_allocations ia
    JOIN invoice_lines il ON il.id = ia.invoice_line_id
    JOIN invoices i ON i.id = il.invoice_id
    JOIN batches b ON b.id = ia.batch_id
    WHERE i.store_id = ${storeId}::uuid AND i.status = 'COMPLETED' AND i.business_date >= ${from}::date AND i.business_date < ${to}::date
  `);
  const [restockRow] = await prisma.$queryRaw<Array<{ restocked_cost: number }>>(Prisma.sql`
    SELECT COALESCE(SUM(rl.base_quantity * COALESCE(ia.unit_cost, b.unit_cost, 0)), 0)::float8 AS restocked_cost
    FROM return_lines rl
    JOIN returns r ON r.id = rl.return_id
    JOIN invoice_allocations ia ON ia.id = rl.invoice_allocation_id
    JOIN batches b ON b.id = ia.batch_id
    WHERE r.store_id = ${storeId}::uuid AND r.disposition = 'RESTOCK' AND r.business_date >= ${from}::date AND r.business_date < ${to}::date
  `);

  return {
    revenue: Number(revenueRow?.revenue ?? 0n),
    refund: Number(refundRow?.refund ?? 0n),
    cogs: cogsRow?.cogs ?? 0,
    restockedCost: restockRow?.restocked_cost ?? 0,
    invoiceCount: Number(revenueRow?.invoice_count ?? 0n),
  };
}

function netOf(totals: Totals): { netRevenue: number; grossProfit: number } {
  const netRevenue = totals.revenue - totals.refund;
  const netCogs = totals.cogs - totals.restockedCost;
  return { netRevenue, grossProfit: netRevenue - netCogs };
}

type DailyRow = {
  date: string;
  revenue: number;
  refund: number;
  cogs: number;
  restockedCost: number;
};

async function getDailyTrend(storeId: string, from: Date, to: Date): Promise<DailyRow[]> {
  const [revenueRows, refundRows, cogsRows, restockRows] = await Promise.all([
    prisma.$queryRaw<Array<{ date: Date; revenue: bigint }>>(Prisma.sql`
      SELECT business_date AS date, COALESCE(SUM(total_amount), 0)::bigint AS revenue
      FROM invoices
      WHERE store_id = ${storeId}::uuid AND status = 'COMPLETED' AND business_date >= ${from}::date AND business_date < ${to}::date
      GROUP BY business_date
    `),
    prisma.$queryRaw<Array<{ date: Date; refund: bigint }>>(Prisma.sql`
      SELECT business_date AS date, COALESCE(SUM(refund_amount), 0)::bigint AS refund
      FROM returns
      WHERE store_id = ${storeId}::uuid AND business_date >= ${from}::date AND business_date < ${to}::date
      GROUP BY business_date
    `),
    prisma.$queryRaw<Array<{ date: Date; cogs: number }>>(Prisma.sql`
      SELECT i.business_date AS date, COALESCE(SUM(ia.base_quantity * COALESCE(ia.unit_cost, b.unit_cost, 0)), 0)::float8 AS cogs
      FROM invoice_allocations ia
      JOIN invoice_lines il ON il.id = ia.invoice_line_id
      JOIN invoices i ON i.id = il.invoice_id
      JOIN batches b ON b.id = ia.batch_id
      WHERE i.store_id = ${storeId}::uuid AND i.status = 'COMPLETED' AND i.business_date >= ${from}::date AND i.business_date < ${to}::date
      GROUP BY i.business_date
    `),
    prisma.$queryRaw<Array<{ date: Date; restocked_cost: number }>>(Prisma.sql`
      SELECT r.business_date AS date, COALESCE(SUM(rl.base_quantity * COALESCE(ia.unit_cost, b.unit_cost, 0)), 0)::float8 AS restocked_cost
      FROM return_lines rl
      JOIN returns r ON r.id = rl.return_id
      JOIN invoice_allocations ia ON ia.id = rl.invoice_allocation_id
      JOIN batches b ON b.id = ia.batch_id
      WHERE r.store_id = ${storeId}::uuid AND r.disposition = 'RESTOCK' AND r.business_date >= ${from}::date AND r.business_date < ${to}::date
      GROUP BY r.business_date
    `),
  ]);

  const revenueByDate = new Map(
    revenueRows.map((row) => [toDateKey(row.date), Number(row.revenue)]),
  );
  const refundByDate = new Map(refundRows.map((row) => [toDateKey(row.date), Number(row.refund)]));
  const cogsByDate = new Map(cogsRows.map((row) => [toDateKey(row.date), row.cogs]));
  const restockByDate = new Map(
    restockRows.map((row) => [toDateKey(row.date), row.restocked_cost]),
  );

  const days: DailyRow[] = [];
  const dayCount = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  for (let i = 0; i < dayCount; i++) {
    const key = toDateKey(addDays(from, i));
    days.push({
      date: key,
      revenue: revenueByDate.get(key) ?? 0,
      refund: refundByDate.get(key) ?? 0,
      cogs: cogsByDate.get(key) ?? 0,
      restockedCost: restockByDate.get(key) ?? 0,
    });
  }
  return days;
}

type TopProductRow = {
  product_id: string;
  product_name: string;
  quantity: number;
  revenue: bigint;
};
type CategoryRow = { category_name: string; revenue: bigint };
type PaymentRow = { payment_method: string; amount: bigint; count: bigint };
type StaffRow = { seller_id: string; revenue: bigint; invoice_count: bigint };

/** Báo cáo kinh doanh theo khoảng ngày tùy chọn — không nằm trong danh sách endpoint gốc của §19, dùng dữ liệu thật sẵn có (giá vốn theo lô, phân bổ hóa đơn), không có số minh họa. */
export async function getReportsSummary(storeId: string, from: Date, to: Date) {
  const periodDays = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  const previousFrom = addDays(from, -periodDays);
  const previousTo = from;

  const [current, previous, trend, topProductRows, categoryRows, paymentRows, staffRows] =
    await Promise.all([
      getTotals(storeId, from, to),
      getTotals(storeId, previousFrom, previousTo),
      getDailyTrend(storeId, from, to),
      prisma.$queryRaw<TopProductRow[]>(Prisma.sql`
      SELECT il.product_id::text, MAX(il.product_name) AS product_name, SUM(il.base_quantity)::int AS quantity, SUM(il.line_total)::bigint AS revenue
      FROM invoice_lines il
      JOIN invoices i ON i.id = il.invoice_id
      WHERE i.store_id = ${storeId}::uuid AND i.status = 'COMPLETED' AND i.business_date >= ${from}::date AND i.business_date < ${to}::date
      GROUP BY il.product_id
      ORDER BY revenue DESC
      LIMIT 10
    `),
      prisma.$queryRaw<CategoryRow[]>(Prisma.sql`
      SELECT c.name AS category_name, SUM(il.line_total)::bigint AS revenue
      FROM invoice_lines il
      JOIN invoices i ON i.id = il.invoice_id
      JOIN products p ON p.id = il.product_id
      JOIN categories c ON c.id = p.category_id
      WHERE i.store_id = ${storeId}::uuid AND i.status = 'COMPLETED' AND i.business_date >= ${from}::date AND i.business_date < ${to}::date
      GROUP BY c.id, c.name
      ORDER BY revenue DESC
      LIMIT 8
    `),
      prisma.$queryRaw<PaymentRow[]>(Prisma.sql`
      SELECT payment_method, SUM(total_amount)::bigint AS amount, COUNT(*)::bigint AS count
      FROM invoices
      WHERE store_id = ${storeId}::uuid AND status = 'COMPLETED' AND business_date >= ${from}::date AND business_date < ${to}::date
      GROUP BY payment_method
    `),
      prisma.$queryRaw<StaffRow[]>(Prisma.sql`
      SELECT seller_id::text, SUM(total_amount)::bigint AS revenue, COUNT(*)::bigint AS invoice_count
      FROM invoices
      WHERE store_id = ${storeId}::uuid AND status = 'COMPLETED' AND business_date >= ${from}::date AND business_date < ${to}::date
      GROUP BY seller_id
      ORDER BY revenue DESC
      LIMIT 10
    `),
    ]);

  const currentNet = netOf(current);
  const previousNet = netOf(previous);
  const currentAov = current.invoiceCount > 0 ? currentNet.netRevenue / current.invoiceCount : 0;
  const previousAov =
    previous.invoiceCount > 0 ? previousNet.netRevenue / previous.invoiceCount : 0;

  const staffIds = staffRows.map((row) => row.seller_id);
  const staffUsers =
    staffIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, fullName: true },
        })
      : [];
  const staffNameById = new Map(staffUsers.map((user) => [user.id, user.fullName]));

  const categoryTotal = categoryRows.reduce((sum, row) => sum + Number(row.revenue), 0) || 1;
  const paymentTotal = paymentRows.reduce((sum, row) => sum + Number(row.amount), 0) || 1;

  return {
    from: toDateKey(from),
    to: toDateKey(addDays(to, -1)),
    kpis: {
      netRevenue: currentNet.netRevenue,
      netRevenueChangePercent: percentageChange(currentNet.netRevenue, previousNet.netRevenue),
      grossProfit: currentNet.grossProfit,
      grossProfitChangePercent: percentageChange(currentNet.grossProfit, previousNet.grossProfit),
      invoiceCount: current.invoiceCount,
      invoiceCountChangePercent: percentageChange(current.invoiceCount, previous.invoiceCount),
      averageOrderValue: Math.round(currentAov),
      averageOrderValueChangePercent: percentageChange(currentAov, previousAov),
    },
    trend: trend.map((day) => {
      const netRevenue = day.revenue - day.refund;
      const netCogs = day.cogs - day.restockedCost;
      return { date: day.date, revenue: netRevenue, profit: Math.round(netRevenue - netCogs) };
    }),
    topProducts: topProductRows.map((row) => ({
      productId: row.product_id,
      productName: row.product_name,
      quantity: row.quantity,
      revenue: Number(row.revenue),
    })),
    categoryBreakdown: categoryRows.map((row) => ({
      categoryName: row.category_name,
      revenue: Number(row.revenue),
      percent: Math.round((Number(row.revenue) / categoryTotal) * 1000) / 10,
    })),
    paymentMethods: paymentRows.map((row) => ({
      method: row.payment_method,
      amount: Number(row.amount),
      count: Number(row.count),
      percent: Math.round((Number(row.amount) / paymentTotal) * 1000) / 10,
    })),
    staffPerformance: staffRows.map((row) => ({
      userId: row.seller_id,
      fullName: staffNameById.get(row.seller_id) ?? "Không rõ",
      revenue: Number(row.revenue),
      invoiceCount: Number(row.invoice_count),
    })),
  };
}
