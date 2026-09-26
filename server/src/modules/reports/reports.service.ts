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
 * trong kỳ (contract §19, P13).
 *
 * Giá vốn **chỉ** lấy từ `invoice_allocations.unit_cost` — giá vốn đã chụp
 * tại đúng thời điểm xuất hàng. Tuyệt đối không lùi về `batches.unit_cost`:
 * giá vốn của lô thay đổi mỗi lần nhập thêm, lấy nó làm dự phòng thì lãi gộp
 * của kỳ đã chốt sẽ nhảy theo mỗi đợt nhập hàng mới.
 *
 * Dòng phân bổ cũ được nâng cấp `20260926140000` đóng băng một lần giá vốn
 * lô tại thời điểm nâng cấp và đánh dấu `ESTIMATED`; dòng không khôi phục
 * được để `UNKNOWN` với giá vốn rỗng (tính là 0 trong tổng giá vốn). Cả hai
 * loại đều được đếm và trả về trong `costQuality` để báo cáo không trình bày
 * số ước tính như số lịch sử chính xác.
 *
 * Phần hàng trả về bán lại được (RESTOCK) được trừ ra theo đúng giá vốn của
 * lần bán gốc; hàng trả để tiêu hủy vẫn tính là giá vốn đã mất.
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
    SELECT COALESCE(SUM(ia.base_quantity * COALESCE(ia.unit_cost, 0)), 0)::float8 AS cogs
    FROM invoice_allocations ia
    JOIN invoice_lines il ON il.id = ia.invoice_line_id
    JOIN invoices i ON i.id = il.invoice_id
    WHERE i.store_id = ${storeId}::uuid AND i.status = 'COMPLETED' AND i.business_date >= ${from}::date AND i.business_date < ${to}::date
  `);
  const [restockRow] = await prisma.$queryRaw<Array<{ restocked_cost: number }>>(Prisma.sql`
    SELECT COALESCE(SUM(rl.base_quantity * COALESCE(ia.unit_cost, 0)), 0)::float8 AS restocked_cost
    FROM return_lines rl
    JOIN returns r ON r.id = rl.return_id
    JOIN invoice_allocations ia ON ia.id = rl.invoice_allocation_id
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

/**
 * Chất lượng giá vốn của một kỳ.
 *
 * **Cách đếm:** đếm theo *phần đóng góp vào công thức lãi gộp*, không phải
 * theo chứng từ. Lãi gộp của kỳ = doanh thu − (giá vốn hàng bán trong kỳ −
 * giá vốn hoàn của hàng trả về bán lại trong kỳ), nên có đúng hai nguồn:
 *
 * - `saleLines`: mỗi dòng phân bổ lô của hóa đơn bán **trong kỳ**.
 * - `returnLines`: mỗi dòng hàng trả **trong kỳ** có nhập lại kho (RESTOCK).
 *   Hàng trả để tiêu hủy (DISPOSE) không hoàn giá vốn nên không được đếm.
 *
 * Một lần bán rồi trả trong cùng kỳ sẽ đóng góp hai lần — một ở phần bán,
 * một ở phần hoàn — và được đếm hai lần, vì cả hai đều tham gia công thức.
 * Trả nhiều lần trên cùng một phân bổ cũng đếm theo từng lần trả.
 *
 * Dòng hoàn có thể thuộc hóa đơn của **kỳ trước**: đó chính là lý do không
 * thể chỉ nhìn hóa đơn bán trong kỳ để kết luận giá vốn đã đủ.
 */
export type CostQuality = {
  /** Dòng xuất bán trong kỳ. */
  saleLines: number;
  /** Dòng hàng trả nhập lại kho trong kỳ (RESTOCK). */
  returnLines: number;
  /** Tổng phần đóng góp vào công thức = saleLines + returnLines. */
  totalLines: number;
  /** Có giá vốn chụp đúng lúc xuất hàng. */
  actualLines: number;
  /** Dùng giá vốn ước tính một lần khi nâng cấp dữ liệu cũ. */
  estimatedLines: number;
  /** Không xác định được giá vốn; đang tính là 0. */
  unknownLines: number;
  /**
   * Thiếu giá vốn ở phần BÁN làm giá vốn thấp đi → lãi gộp **cao hơn** thực tế.
   */
  unknownSaleLines: number;
  /**
   * Thiếu giá vốn ở phần HOÀN của hàng trả làm phần trừ ra nhỏ đi → lãi gộp
   * **thấp hơn** thực tế. Ảnh hưởng ngược chiều với phần bán.
   */
  unknownReturnLines: number;
  /** Chỉ khi tất cả đều là giá vốn thật thì lãi gộp mới là số chính xác. */
  exact: boolean;
  /**
   * Cả kỳ này lẫn kỳ so sánh đều đủ giá vốn thật. Sai thì tỷ lệ tăng/giảm lãi
   * gộp so với kỳ trước không được trình bày như số chính xác.
   */
  comparisonExact: boolean;
};

type CostCounts = Omit<CostQuality, "comparisonExact">;

/**
 * Đếm phần đóng góp giá vốn của một kỳ: dòng bán trong kỳ và dòng hàng trả
 * nhập lại kho trong kỳ (kể cả khi hóa đơn gốc thuộc kỳ trước).
 */
async function getCostCounts(storeId: string, from: Date, to: Date): Promise<CostCounts> {
  const [row] = await prisma.$queryRaw<
    Array<{
      sale_lines: number;
      return_lines: number;
      actual_lines: number;
      estimated_lines: number;
      unknown_sale_lines: number;
      unknown_return_lines: number;
    }>
  >(Prisma.sql`
    WITH sold AS (
      SELECT ia.unit_cost, ia.unit_cost_source
      FROM invoice_allocations ia
      JOIN invoice_lines il ON il.id = ia.invoice_line_id
      JOIN invoices i ON i.id = il.invoice_id
      WHERE i.store_id = ${storeId}::uuid AND i.status = 'COMPLETED'
        AND i.business_date >= ${from}::date AND i.business_date < ${to}::date
    ),
    restocked AS (
      SELECT ia.unit_cost, ia.unit_cost_source
      FROM return_lines rl
      JOIN returns r ON r.id = rl.return_id
      JOIN invoice_allocations ia ON ia.id = rl.invoice_allocation_id
      WHERE r.store_id = ${storeId}::uuid AND r.disposition = 'RESTOCK'
        AND r.business_date >= ${from}::date AND r.business_date < ${to}::date
    )
    SELECT
      (SELECT COUNT(*) FROM sold)::int AS sale_lines,
      (SELECT COUNT(*) FROM restocked)::int AS return_lines,
      (
        (SELECT COUNT(*) FROM sold WHERE unit_cost IS NOT NULL AND unit_cost_source = 'ACTUAL')
        + (SELECT COUNT(*) FROM restocked WHERE unit_cost IS NOT NULL AND unit_cost_source = 'ACTUAL')
      )::int AS actual_lines,
      (
        (SELECT COUNT(*) FROM sold WHERE unit_cost IS NOT NULL AND unit_cost_source = 'ESTIMATED')
        + (SELECT COUNT(*) FROM restocked WHERE unit_cost IS NOT NULL AND unit_cost_source = 'ESTIMATED')
      )::int AS estimated_lines,
      (SELECT COUNT(*) FROM sold WHERE unit_cost IS NULL)::int AS unknown_sale_lines,
      (SELECT COUNT(*) FROM restocked WHERE unit_cost IS NULL)::int AS unknown_return_lines
  `);

  const saleLines = row?.sale_lines ?? 0;
  const returnLines = row?.return_lines ?? 0;
  const estimatedLines = row?.estimated_lines ?? 0;
  const unknownSaleLines = row?.unknown_sale_lines ?? 0;
  const unknownReturnLines = row?.unknown_return_lines ?? 0;
  const unknownLines = unknownSaleLines + unknownReturnLines;

  return {
    saleLines,
    returnLines,
    totalLines: saleLines + returnLines,
    actualLines: row?.actual_lines ?? 0,
    estimatedLines,
    unknownLines,
    unknownSaleLines,
    unknownReturnLines,
    exact: estimatedLines === 0 && unknownLines === 0,
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
      SELECT i.business_date AS date, COALESCE(SUM(ia.base_quantity * COALESCE(ia.unit_cost, 0)), 0)::float8 AS cogs
      FROM invoice_allocations ia
      JOIN invoice_lines il ON il.id = ia.invoice_line_id
      JOIN invoices i ON i.id = il.invoice_id
        WHERE i.store_id = ${storeId}::uuid AND i.status = 'COMPLETED' AND i.business_date >= ${from}::date AND i.business_date < ${to}::date
      GROUP BY i.business_date
    `),
    prisma.$queryRaw<Array<{ date: Date; restocked_cost: number }>>(Prisma.sql`
      SELECT r.business_date AS date, COALESCE(SUM(rl.base_quantity * COALESCE(ia.unit_cost, 0)), 0)::float8 AS restocked_cost
      FROM return_lines rl
      JOIN returns r ON r.id = rl.return_id
      JOIN invoice_allocations ia ON ia.id = rl.invoice_allocation_id
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

  const [
    current,
    previous,
    trend,
    currentCost,
    previousCost,
    topProductRows,
    categoryRows,
    paymentRows,
    staffRows,
  ] =
    await Promise.all([
      getTotals(storeId, from, to),
      getTotals(storeId, previousFrom, previousTo),
      getDailyTrend(storeId, from, to),
      getCostCounts(storeId, from, to),
      getCostCounts(storeId, previousFrom, previousTo),
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
    // Chất lượng giá vốn của kỳ: máy khách phải nói rõ khi lãi gộp có phần
    // ước tính hoặc không xác định, không trình bày như số chính xác. Kỳ so
    // sánh cũng phải đủ giá vốn thì tỷ lệ tăng/giảm mới đáng tin.
    costQuality: { ...currentCost, comparisonExact: currentCost.exact && previousCost.exact },
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
