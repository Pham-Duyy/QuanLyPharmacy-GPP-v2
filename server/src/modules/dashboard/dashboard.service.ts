import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { getInventoryOverview } from "../inventory/inventory.service.js";
import type { AuthContext } from "../auth/auth.context.js";

type DailyPoint = { date: string; revenue: number; invoiceCount: number };

function vietnamBusinessDate(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  return new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
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

function asNumber(value: bigint | null | undefined): number {
  return Number(value ?? 0n);
}

type CategoryStockRow = { category_name: string; quantity: number; product_count: number };

/**
 * Dashboard chỉ tổng hợp dữ liệu đã phát sinh, không tạo số liệu minh họa.
 * Mỗi phần dữ liệu được trả về độc lập theo quyền của người dùng hiện tại.
 */
export async function getDashboard(storeId: string, auth: AuthContext, days: 7 | 30) {
  const today = vietnamBusinessDate();
  const yesterday = addDays(today, -1);
  const rangeStart = addDays(today, -(days - 1));
  const nextDay = addDays(today, 1);
  const expiryLimit = addDays(today, 90);
  const canReadSales = auth.can("invoice.read");
  const canReadStock = auth.can("stock.read");
  const canReadCustomers = auth.can("customer.read");
  const canReadStorage = auth.can("storage_log.read");

  const permissions = {
    sales: canReadSales,
    inventory: canReadStock,
    customers: canReadCustomers,
    storageLogs: canReadStorage,
  };

  const emptySales = {
    today: {
      revenue: 0,
      invoiceCount: 0,
      newCustomerCount: 0,
      revenueChangePercent: null,
      invoiceChangePercent: null,
      newCustomerChangePercent: null,
    },
    trend: [] as DailyPoint[],
    topProducts: [] as Array<{
      productId: string;
      productName: string;
      quantity: number;
      revenue: number;
    }>,
  };

  const sales = canReadSales
    ? await getSalesDashboard(storeId, today, yesterday, nextDay, rangeStart, days)
    : emptySales;

  const inventory = canReadStock
    ? await getInventoryDashboard(storeId, today, expiryLimit)
    : {
        expiringBatches: [],
        lowStockProducts: [],
        categoryStock: [],
        counts: { expired: 0, expiring: 0, lowStock: 0 },
      };

  const storageAlertCount = canReadStorage
    ? await prisma.storageLog.count({ where: { storeId, businessDate: today, outOfRange: true } })
    : 0;

  const notifications = [
    ...(canReadStock && inventory.counts.expired > 0
      ? [
          {
            type: "EXPIRED",
            severity: "danger",
            title: `${inventory.counts.expired} lô đã hết hạn`,
            href: "/canh-bao",
          },
        ]
      : []),
    ...(canReadStock && inventory.counts.expiring > 0
      ? [
          {
            type: "EXPIRING",
            severity: "warning",
            title: `${inventory.counts.expiring} lô sắp hết hạn trong 90 ngày`,
            href: "/canh-bao",
          },
        ]
      : []),
    ...(canReadStock && inventory.counts.lowStock > 0
      ? [
          {
            type: "LOW_STOCK",
            severity: "info",
            title: `${inventory.counts.lowStock} mặt hàng dưới mức tồn tối thiểu`,
            href: "/ton-kho",
          },
        ]
      : []),
    ...(canReadStorage && storageAlertCount > 0
      ? [
          {
            type: "STORAGE",
            severity: "warning",
            title: `${storageAlertCount} lượt ghi bảo quản vượt ngưỡng hôm nay`,
            href: "/so-nhiet-do",
          },
        ]
      : []),
  ];

  return { generatedAt: new Date(), days, permissions, sales, inventory, notifications };
}

async function getSalesDashboard(
  storeId: string,
  today: Date,
  yesterday: Date,
  nextDay: Date,
  rangeStart: Date,
  days: number,
) {
  const completed = "COMPLETED";
  const [
    todaySummary,
    yesterdaySummary,
    groupedDaily,
    topLines,
    todayCustomers,
    yesterdayCustomers,
  ] = await Promise.all([
    prisma.invoice.aggregate({
      where: { storeId, status: completed, businessDate: today },
      _sum: { totalAmount: true },
      _count: true,
    }),
    prisma.invoice.aggregate({
      where: { storeId, status: completed, businessDate: yesterday },
      _sum: { totalAmount: true },
      _count: true,
    }),
    prisma.invoice.groupBy({
      where: { storeId, status: completed, businessDate: { gte: rangeStart, lt: nextDay } },
      by: ["businessDate"],
      _sum: { totalAmount: true },
      _count: true,
      orderBy: { businessDate: "asc" },
    }),
    prisma.invoiceLine.groupBy({
      where: {
        invoice: { storeId, status: completed, businessDate: { gte: rangeStart, lt: nextDay } },
      },
      by: ["productId"],
      _sum: { baseQuantity: true, lineTotal: true },
      orderBy: { _sum: { lineTotal: "desc" } },
      take: 6,
    }),
    distinctCustomersOnDate(storeId, today),
    distinctCustomersOnDate(storeId, yesterday),
  ]);

  const [todayNewCustomers, yesterdayNewCustomers, products] = await Promise.all([
    countNewCustomersAtStore(storeId, today, todayCustomers),
    countNewCustomersAtStore(storeId, yesterday, yesterdayCustomers),
    prisma.product.findMany({
      where: { id: { in: topLines.map((item) => item.productId) } },
      select: { id: true, name: true },
    }),
  ]);
  const productNames = new Map(products.map((product) => [product.id, product.name]));
  const dailyByDate = new Map(
    groupedDaily.map((item) => [item.businessDate.toISOString().slice(0, 10), item]),
  );
  const trend: DailyPoint[] = Array.from({ length: days }, (_, index) => {
    const date = addDays(rangeStart, index);
    const data = dailyByDate.get(date.toISOString().slice(0, 10));
    return {
      date: date.toISOString().slice(0, 10),
      revenue: asNumber(data?._sum.totalAmount),
      invoiceCount: data?._count ?? 0,
    };
  });
  const todayRevenue = asNumber(todaySummary._sum.totalAmount);
  const yesterdayRevenue = asNumber(yesterdaySummary._sum.totalAmount);

  return {
    today: {
      revenue: todayRevenue,
      invoiceCount: todaySummary._count,
      newCustomerCount: todayNewCustomers,
      revenueChangePercent: percentageChange(todayRevenue, yesterdayRevenue),
      invoiceChangePercent: percentageChange(todaySummary._count, yesterdaySummary._count),
      newCustomerChangePercent: percentageChange(todayNewCustomers, yesterdayNewCustomers),
    },
    trend,
    topProducts: topLines.map((item) => ({
      productId: item.productId,
      productName: productNames.get(item.productId) ?? "Sản phẩm đã xóa",
      quantity: item._sum.baseQuantity ?? 0,
      revenue: asNumber(item._sum.lineTotal),
    })),
  };
}

async function distinctCustomersOnDate(storeId: string, date: Date): Promise<string[]> {
  const items = await prisma.invoice.findMany({
    where: { storeId, status: "COMPLETED", businessDate: date, customerId: { not: null } },
    distinct: ["customerId"],
    select: { customerId: true },
  });
  return items.flatMap((item) => (item.customerId ? [item.customerId] : []));
}

async function countNewCustomersAtStore(
  storeId: string,
  date: Date,
  customerIds: string[],
): Promise<number> {
  if (customerIds.length === 0) return 0;
  const prior = await prisma.invoice.findMany({
    where: {
      storeId,
      status: "COMPLETED",
      businessDate: { lt: date },
      customerId: { in: customerIds },
    },
    distinct: ["customerId"],
    select: { customerId: true },
  });
  return customerIds.length - new Set(prior.map((item) => item.customerId)).size;
}

async function getInventoryDashboard(storeId: string, today: Date, expiryLimit: Date) {
  const [expiringBatches, expiringCount, expiredCount, overview, categoryStock] = await Promise.all(
    [
      prisma.batch.findMany({
        where: {
          storeId,
          status: "AVAILABLE",
          quantityOnHand: { gt: 0 },
          expiryDate: { gt: today, lte: expiryLimit },
        },
        orderBy: { expiryDate: "asc" },
        take: 6,
        include: { product: { select: { id: true, name: true } } },
      }),
      prisma.batch.count({
        where: {
          storeId,
          status: "AVAILABLE",
          quantityOnHand: { gt: 0 },
          expiryDate: { gt: today, lte: expiryLimit },
        },
      }),
      prisma.batch.count({
        where: { storeId, quantityOnHand: { gt: 0 }, expiryDate: { lte: today } },
      }),
      getInventoryOverview(storeId, { belowMinStock: true }),
      prisma.$queryRaw<CategoryStockRow[]>(Prisma.sql`
      SELECT c.name AS category_name, COALESCE(SUM(b.quantity_on_hand) FILTER (
        WHERE b.status = 'AVAILABLE' AND b.expiry_date > ${today}::date
      ), 0)::int AS quantity, COUNT(DISTINCT p.id)::int AS product_count
      FROM categories c
      JOIN products p ON p.category_id = c.id AND p.is_active = true
      LEFT JOIN batches b ON b.product_id = p.id AND b.store_id = ${storeId}::uuid
      GROUP BY c.id, c.name
      ORDER BY quantity DESC, c.name ASC
      LIMIT 6
    `),
    ],
  );
  const lowStockProducts = overview.slice(0, 6);

  return {
    expiringBatches: expiringBatches.map((batch) => ({
      id: batch.id,
      productId: batch.product.id,
      productName: batch.product.name,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      quantityOnHand: batch.quantityOnHand,
    })),
    lowStockProducts: lowStockProducts.map((item) => ({
      productId: item.productId,
      productName: item.name,
      stock: item.stock.sellable,
      minimumStock: item.minStockBaseQuantity,
    })),
    categoryStock: categoryStock.map((item) => ({
      categoryName: item.category_name,
      quantity: item.quantity,
      productCount: item.product_count,
    })),
    counts: { expired: expiredCount, expiring: expiringCount, lowStock: overview.length },
  };
}
