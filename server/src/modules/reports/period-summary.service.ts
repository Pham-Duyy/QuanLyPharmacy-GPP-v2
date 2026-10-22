import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { addDays, dateKey } from "../../lib/dates.js";
import type { AuthContext } from "../auth/auth.context.js";
import { getCostCounts, getTotals, netOf } from "./reports.service.js";

/**
 * Tổng kết một kỳ (thường là một tháng): nhập những thuốc nào, hết bao nhiêu
 * tiền, bán ra bao nhiêu, thuốc nào bán chạy / bán chậm, thuốc nào đứng yên,
 * và bảng nhập – xuất – tồn để kiểm chéo.
 *
 * Quy tắc số liệu:
 * - `from` là ngày đầu kỳ, `to` là ngày **sau** ngày cuối kỳ (cột date, nửa
 *   đêm UTC), tính theo ngày Việt Nam.
 * - Nhập hàng: phiếu mua (`PURCHASE`) đã kiểm nhập, theo ngày nhận hàng —
 *   cùng mốc với trang Phiếu nhập. Không tính tồn đầu kỳ và hàng nhận chuyển.
 * - Bán ra: cùng luật với Báo cáo kinh doanh (hóa đơn hoàn thành trong kỳ trừ
 *   hàng khách trả lập trong kỳ), nên tổng các thuốc khớp doanh thu thuần.
 * - Nhập – xuất – tồn lấy từ sổ kho, theo đơn vị cơ sở.
 * - Tiền nhập, lãi gộp, giá trị tồn chỉ trả cho người có quyền xem giá vốn.
 */

const DAY_MS = 86_400_000;
/** Mốc 0 giờ (giờ Việt Nam) của một ngày lưu ở nửa đêm UTC, để so với cột thời điểm. */
const vnStart = (day: Date) => new Date(day.getTime() - 7 * 3_600_000);
const num = (value: bigint | number | null | undefined) => Number(value ?? 0);
const SALE_TYPES = Prisma.sql`('SALE', 'SALE_VOID', 'CUSTOMER_RETURN')`;
const MAIN_TYPES = Prisma.sql`('RECEIPT', 'SALE', 'SALE_VOID', 'CUSTOMER_RETURN')`;

type ProductInfo = { productId: string; code: string; name: string; unit: string };

/**
 * Chia tổng giá trị phiếu (tiền hàng − chiết khấu + VAT) vào từng dòng theo
 * tiền hàng, để cộng tiền nhập các thuốc ra đúng số phải trả nhà cung cấp.
 * Phiếu toàn hàng 0 đồng thì chia đều. Phần dư do làm tròn dồn vào dòng lớn nhất.
 */
function allocate(total: bigint, weights: bigint[]): bigint[] {
  const goods = weights.reduce((sum, weight) => sum + weight, 0n);
  const basis = goods > 0n ? weights : weights.map(() => 1n);
  const divisor = goods > 0n ? goods : BigInt(weights.length);
  const shares = basis.map((weight) => (total * weight) / divisor);
  const largest = basis.indexOf(basis.reduce((max, weight) => (weight > max ? weight : max)));
  shares[largest] = shares[largest]! + total - shares.reduce((sum, share) => sum + share, 0n);
  return shares;
}

async function purchasesOf(storeId: string, fromAt: Date, toAt: Date) {
  const lines = await prisma.$queryRaw<
    Array<{
      receipt_id: string;
      supplier_name: string | null;
      product_id: string;
      base_quantity: number;
      line_cost: bigint;
      goods_amount: bigint;
      discount_amount: bigint;
      vat_amount: bigint;
      total_cost: bigint;
    }>
  >(Prisma.sql`
    SELECT g.id::text AS receipt_id, s.name AS supplier_name, l.product_id::text,
           l.base_quantity, l.line_cost, g.goods_amount, g.discount_amount, g.vat_amount, g.total_cost
    FROM goods_receipt_lines l
    JOIN goods_receipts g ON g.id = l.goods_receipt_id
    LEFT JOIN suppliers s ON s.id = g.supplier_id
    WHERE g.store_id = ${storeId}::uuid AND g.type = 'PURCHASE' AND g.status = 'CONFIRMED'
      AND g.received_at >= ${fromAt} AND g.received_at < ${toAt}
    ORDER BY g.id, l.line_no
  `);

  const byReceipt = new Map<string, typeof lines>();
  for (const line of lines)
    byReceipt.set(line.receipt_id, [...(byReceipt.get(line.receipt_id) ?? []), line]);

  const totals = {
    receipts: byReceipt.size,
    goodsAmount: 0,
    discountAmount: 0,
    vatAmount: 0,
    totalCost: 0,
  };
  const byProduct = new Map<
    string,
    { quantity: number; amount: bigint; receipts: Set<string>; suppliers: Set<string> }
  >();
  for (const [receiptId, receiptLines] of byReceipt) {
    const head = receiptLines[0]!;
    totals.goodsAmount += num(head.goods_amount);
    totals.discountAmount += num(head.discount_amount);
    totals.vatAmount += num(head.vat_amount);
    totals.totalCost += num(head.total_cost);
    const shares = allocate(
      head.total_cost,
      receiptLines.map((line) => line.line_cost),
    );
    receiptLines.forEach((line, index) => {
      const item = byProduct.get(line.product_id) ?? {
        quantity: 0,
        amount: 0n,
        receipts: new Set<string>(),
        suppliers: new Set<string>(),
      };
      item.quantity += line.base_quantity;
      item.amount += shares[index]!;
      item.receipts.add(receiptId);
      if (line.supplier_name) item.suppliers.add(line.supplier_name);
      byProduct.set(line.product_id, item);
    });
  }
  return { totals, byProduct };
}

async function supplierReturnsOf(storeId: string, fromAt: Date, toAt: Date) {
  return prisma.$queryRaw<
    Array<{ product_id: string; quantity: number; value: bigint; returns: number }>
  >(Prisma.sql`
    SELECT l.product_id::text, SUM(l.base_quantity)::int AS quantity,
           SUM(l.line_value)::bigint AS value, COUNT(DISTINCT r.id)::int AS returns
    FROM supplier_return_lines l
    JOIN supplier_returns r ON r.id = l.supplier_return_id
    WHERE r.store_id = ${storeId}::uuid AND r.status = 'CONFIRMED'
      AND r.confirmed_at >= ${fromAt} AND r.confirmed_at < ${toAt}
    GROUP BY l.product_id
  `);
}

/** Bán ra theo thuốc, cùng công thức với KPI của Báo cáo kinh doanh. */
async function salesOf(storeId: string, from: Date, to: Date) {
  return prisma.$queryRaw<
    Array<{
      product_id: string;
      sold_quantity: number;
      returned_quantity: number;
      revenue: bigint;
      refund: bigint;
      cogs: number;
      restocked_cost: number;
      invoices: number;
    }>
  >(Prisma.sql`
    WITH sold AS (
      SELECT il.product_id, SUM(il.base_quantity) AS quantity, SUM(il.line_total) AS revenue,
             COUNT(DISTINCT il.invoice_id) AS invoices
      FROM invoice_lines il
      JOIN invoices i ON i.id = il.invoice_id
      WHERE i.store_id = ${storeId}::uuid AND i.status = 'COMPLETED'
        AND i.business_date >= ${from}::date AND i.business_date < ${to}::date
      GROUP BY il.product_id
    ), cost AS (
      SELECT il.product_id, SUM(ia.base_quantity * COALESCE(ia.unit_cost, 0)) AS cogs
      FROM invoice_allocations ia
      JOIN invoice_lines il ON il.id = ia.invoice_line_id
      JOIN invoices i ON i.id = il.invoice_id
      WHERE i.store_id = ${storeId}::uuid AND i.status = 'COMPLETED'
        AND i.business_date >= ${from}::date AND i.business_date < ${to}::date
      GROUP BY il.product_id
    ), returned AS (
      SELECT il.product_id, SUM(rl.base_quantity) AS quantity, SUM(rl.refund_amount) AS refund,
             SUM(CASE WHEN r.disposition = 'RESTOCK' THEN rl.base_quantity * COALESCE(ia.unit_cost, 0) ELSE 0 END) AS restocked_cost
      FROM return_lines rl
      JOIN returns r ON r.id = rl.return_id
      JOIN invoice_lines il ON il.id = rl.invoice_line_id
      JOIN invoice_allocations ia ON ia.id = rl.invoice_allocation_id
      WHERE r.store_id = ${storeId}::uuid
        AND r.business_date >= ${from}::date AND r.business_date < ${to}::date
      GROUP BY il.product_id
    )
    SELECT COALESCE(s.product_id, rt.product_id)::text AS product_id,
           COALESCE(s.quantity, 0)::int AS sold_quantity,
           COALESCE(rt.quantity, 0)::int AS returned_quantity,
           COALESCE(s.revenue, 0)::bigint AS revenue,
           COALESCE(rt.refund, 0)::bigint AS refund,
           COALESCE(c.cogs, 0)::float8 AS cogs,
           COALESCE(rt.restocked_cost, 0)::float8 AS restocked_cost,
           COALESCE(s.invoices, 0)::int AS invoices
    FROM sold s
    FULL OUTER JOIN returned rt ON rt.product_id = s.product_id
    LEFT JOIN cost c ON c.product_id = COALESCE(s.product_id, rt.product_id)
  `);
}

/** Sổ kho theo thuốc: tồn đầu, các luồng trong kỳ, tồn cuối, cùng mốc ngày bán/nhập. */
async function ledgerOf(storeId: string, fromAt: Date, toAt: Date, to: Date) {
  const [movements, batches, lastSold] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        product_id: string;
        opening: number;
        received: number;
        sold: number;
        other_in: number;
        other_out: number;
        closing: number;
        moves: number;
        last_received: Date | null;
        first_in: Date | null;
      }>
    >(Prisma.sql`
      SELECT product_id::text,
        COALESCE(SUM(base_quantity) FILTER (WHERE occurred_at < ${fromAt}), 0)::int AS opening,
        COALESCE(SUM(base_quantity) FILTER (WHERE occurred_at >= ${fromAt} AND type = 'RECEIPT'), 0)::int AS received,
        COALESCE(-SUM(base_quantity) FILTER (WHERE occurred_at >= ${fromAt} AND type IN ${SALE_TYPES}), 0)::int AS sold,
        COALESCE(SUM(base_quantity) FILTER (WHERE occurred_at >= ${fromAt} AND type NOT IN ${MAIN_TYPES} AND base_quantity > 0), 0)::int AS other_in,
        COALESCE(-SUM(base_quantity) FILTER (WHERE occurred_at >= ${fromAt} AND type NOT IN ${MAIN_TYPES} AND base_quantity < 0), 0)::int AS other_out,
        COALESCE(SUM(base_quantity), 0)::int AS closing,
        COUNT(*) FILTER (WHERE occurred_at >= ${fromAt})::int AS moves,
        MAX((occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) FILTER (WHERE type = 'RECEIPT') AS last_received,
        MIN((occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) FILTER (WHERE base_quantity > 0) AS first_in
      FROM stock_movements
      WHERE store_id = ${storeId}::uuid AND occurred_at < ${toAt}
      GROUP BY product_id
    `),
    // Tồn cuối kỳ của từng lô, để tính giá trị tồn và hạn dùng gần nhất.
    prisma.$queryRaw<
      Array<{
        product_id: string;
        expiry_date: Date;
        unit_cost: Prisma.Decimal | null;
        closing: number;
      }>
    >(Prisma.sql`
      SELECT m.product_id::text, b.expiry_date, b.unit_cost, SUM(m.base_quantity)::int AS closing
      FROM stock_movements m
      JOIN batches b ON b.id = m.batch_id
      WHERE m.store_id = ${storeId}::uuid AND m.occurred_at < ${toAt}
      GROUP BY m.product_id, b.id, b.expiry_date, b.unit_cost
      HAVING SUM(m.base_quantity) > 0
    `),
    prisma.$queryRaw<Array<{ product_id: string; last_sold: Date }>>(Prisma.sql`
      SELECT il.product_id::text, MAX(i.business_date) AS last_sold
      FROM invoice_lines il
      JOIN invoices i ON i.id = il.invoice_id
      WHERE i.store_id = ${storeId}::uuid AND i.status = 'COMPLETED' AND i.business_date < ${to}::date
      GROUP BY il.product_id
    `),
  ]);
  return {
    movements,
    batches,
    lastSold: new Map(lastSold.map((row) => [row.product_id, row.last_sold])),
  };
}

async function productInfo(ids: string[]): Promise<Map<string, ProductInfo>> {
  const products = await prisma.product.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      code: true,
      name: true,
      units: { where: { conversionToBase: 1 }, select: { name: true } },
    },
  });
  return new Map(
    products.map((product) => [
      product.id,
      {
        productId: product.id,
        code: product.code,
        name: product.name,
        unit: product.units[0]?.name ?? "",
      },
    ]),
  );
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "vi");

export async function getPeriodSummary(storeId: string, auth: AuthContext, from: Date, to: Date) {
  const showCost = auth.can("stock.cost.read");
  const fromAt = vnStart(from);
  const toAt = vnStart(to);
  const asOf = addDays(to, -1);

  const [purchases, supplierReturns, salesRows, ledger, totals, costCounts] = await Promise.all([
    purchasesOf(storeId, fromAt, toAt),
    supplierReturnsOf(storeId, fromAt, toAt),
    salesOf(storeId, from, to),
    ledgerOf(storeId, fromAt, toAt, to),
    getTotals(storeId, from, to),
    getCostCounts(storeId, from, to),
  ]);

  const ids = new Set<string>([
    ...purchases.byProduct.keys(),
    ...supplierReturns.map((row) => row.product_id),
    ...salesRows.map((row) => row.product_id),
    ...ledger.movements.map((row) => row.product_id),
  ]);
  const info = await productInfo([...ids]);
  const productOf = (id: string): ProductInfo =>
    info.get(id) ?? { productId: id, code: "", name: "Không rõ", unit: "" };
  const money = (value: bigint | number) => (showCost ? num(value) : null);

  const purchaseItems = [...purchases.byProduct]
    .map(([productId, item]) => ({
      ...productOf(productId),
      quantity: item.quantity,
      amount: money(item.amount),
      receipts: item.receipts.size,
      suppliers: [...item.suppliers].sort(),
    }))
    .sort((a, b) => num(b.amount) - num(a.amount) || byName(a, b));

  const returnItems = supplierReturns
    .map((row) => ({
      ...productOf(row.product_id),
      quantity: row.quantity,
      value: money(row.value),
      returns: row.returns,
    }))
    .sort(byName);

  const net = netOf(totals);
  const sales = salesRows
    .map((row) => {
      const revenue = num(row.revenue) - num(row.refund);
      return {
        ...productOf(row.product_id),
        quantity: row.sold_quantity - row.returned_quantity,
        revenue,
        grossProfit: showCost ? Math.round(revenue - (row.cogs - row.restocked_cost)) : null,
        invoices: row.invoices,
        share: net.netRevenue > 0 ? Math.round((revenue / net.netRevenue) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || b.quantity - a.quantity || byName(a, b));
  // "Có bán trong kỳ" là có ít nhất một hóa đơn; thuốc chỉ có hàng trả về thì không tính.
  const soldInPeriod = new Set(
    salesRows.filter((row) => row.sold_quantity > 0).map((row) => row.product_id),
  );

  const movements = ledger.movements
    .filter((row) => row.opening !== 0 || row.moves > 0)
    .map((row) => ({
      ...productOf(row.product_id),
      opening: row.opening,
      received: row.received,
      sold: row.sold,
      otherIn: row.other_in,
      otherOut: row.other_out,
      closing: row.closing,
    }))
    .sort(byName);

  // Thuốc còn tồn cuối kỳ mà cả kỳ không bán được cái nào.
  const batchesOf = new Map<string, typeof ledger.batches>();
  for (const batch of ledger.batches)
    batchesOf.set(batch.product_id, [...(batchesOf.get(batch.product_id) ?? []), batch]);
  const idle = ledger.movements
    .filter((row) => row.closing > 0 && !soldInPeriod.has(row.product_id))
    .map((row) => {
      const lots = batchesOf.get(row.product_id) ?? [];
      const withoutCost = lots.some((lot) => lot.unit_cost === null);
      const value = lots.reduce(
        (sum, lot) => sum + (lot.unit_cost === null ? 0 : Number(lot.unit_cost) * lot.closing),
        0,
      );
      const lastSold = ledger.lastSold.get(row.product_id) ?? null;
      const since = lastSold ?? row.first_in ?? asOf;
      const expiries = lots.map((lot) => lot.expiry_date.getTime());
      return {
        ...productOf(row.product_id),
        stock: row.closing,
        value: showCost ? Math.round(value) : null,
        withoutCost: showCost && withoutCost,
        lastSoldDate: lastSold ? dateKey(lastSold) : null,
        lastReceivedDate: row.last_received ? dateKey(row.last_received) : null,
        /** Ngày bắt đầu đứng yên: lần bán cuối, chưa từng bán thì lần đầu có hàng. */
        idleSince: dateKey(since),
        daysIdle: Math.max(0, Math.round((asOf.getTime() - since.getTime()) / DAY_MS)),
        nearestExpiry: expiries.length > 0 ? dateKey(new Date(Math.min(...expiries))) : null,
      };
    })
    .sort((a, b) => num(b.value) - num(a.value) || b.daysIdle - a.daysIdle || byName(a, b));

  return {
    from: dateKey(from),
    to: dateKey(asOf),
    showCost,
    summary: {
      purchases: {
        receipts: purchases.totals.receipts,
        products: purchaseItems.length,
        goodsAmount: money(purchases.totals.goodsAmount),
        discountAmount: money(purchases.totals.discountAmount),
        vatAmount: money(purchases.totals.vatAmount),
        totalCost: money(purchases.totals.totalCost),
        supplierReturnValue: money(supplierReturns.reduce((sum, row) => sum + num(row.value), 0)),
      },
      sales: {
        netRevenue: net.netRevenue,
        invoiceCount: totals.invoiceCount,
        products: soldInPeriod.size,
        grossProfit: showCost ? Math.round(net.grossProfit) : null,
        /** Lãi gộp chỉ chính xác khi mọi dòng xuất bán có giá vốn thật. */
        costExact: costCounts.exact,
      },
      idle: {
        products: idle.length,
        value: showCost ? idle.reduce((sum, row) => sum + num(row.value), 0) : null,
        withoutCost: idle.filter((row) => row.withoutCost).length,
      },
    },
    purchases: purchaseItems,
    supplierReturns: returnItems,
    sales,
    idle,
    movements,
  };
}

/** Kỳ của một tháng "YYYY-MM": tháng đang chạy thì tính tới hết hôm nay. */
export function monthRange(month: string, today: Date): { from: Date; to: Date; partial: boolean } {
  const [year, monthNo] = month.split("-").map(Number);
  const from = new Date(Date.UTC(year!, monthNo! - 1, 1));
  const end = new Date(Date.UTC(year!, monthNo!, 1));
  return end > today
    ? { from, to: addDays(today, 1), partial: true }
    : { from, to: end, partial: false };
}
