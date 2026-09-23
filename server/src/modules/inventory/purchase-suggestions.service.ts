import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";

/**
 * Đề xuất đặt hàng: trả lời câu hỏi "hôm nay cần gọi hàng gì, bao nhiêu".
 *
 * Cách tính bám theo thực tế quầy thuốc: nhìn tốc độ bán gần đây, cộng thêm
 * thời gian chờ hàng về, trừ đi hàng đã đặt nhưng chưa nhận, và không bao giờ
 * để tồn thấp hơn mức tối thiểu đã cài cho mặt hàng đó.
 */

export type SuggestionQuery = {
  /** Số ngày lấy dữ liệu bán để tính tốc độ bán. */
  windowDays: number;
  /** Muốn hàng đủ bán trong bao nhiêu ngày tới. */
  coverDays: number;
  /** Số ngày chờ từ lúc gọi hàng tới lúc hàng về. */
  leadTimeDays: number;
  /** Chỉ lấy mặt hàng thực sự cần đặt. */
  onlyNeeded: boolean;
  categoryId?: string | undefined;
  search?: string | undefined;
};

export type Suggestion = {
  productId: string;
  code: string;
  name: string;
  categoryName: string;
  baseUnitName: string;
  /** Đơn vị hay dùng khi đặt hàng (đơn vị lớn nhất còn dùng). */
  orderUnit: { id: string; name: string; conversionToBase: number };
  sellableBaseQuantity: number;
  minStockBaseQuantity: number;
  onOrderBaseQuantity: number;
  soldBaseQuantity: number;
  avgDailyBaseQuantity: number;
  /** Số ngày còn bán được với tốc độ hiện tại; null khi kỳ qua không bán được cái nào. */
  daysOfStock: number | null;
  targetBaseQuantity: number;
  suggestedBaseQuantity: number;
  suggestedOrderQuantity: number;
  /**
   * OUT_OF_STOCK hết hàng · BELOW_MIN dưới tồn tối thiểu · RUNNING_OUT hết
   * trước khi hàng kịp về · REFILL cần bổ sung cho kỳ tới · OK đang đủ hàng.
   */
  reason: "OUT_OF_STOCK" | "BELOW_MIN" | "RUNNING_OUT" | "REFILL" | "OK";
  lastSupplier: { id: string; name: string } | null;
  lastUnitCost: number | null;
  lastReceivedAt: Date | null;
  estimatedCost: number | null;
};

type OverviewRow = {
  product_id: string;
  code: string;
  name: string;
  category_name: string;
  min_stock_base_quantity: number;
  sellable: number;
};

type LastPurchaseRow = {
  product_id: string;
  supplier_id: string | null;
  supplier_name: string | null;
  unit_cost: string;
  conversion_to_base: number;
  received_at: Date;
};

export async function buildSuggestions(storeId: string, query: SuggestionQuery): Promise<Suggestion[]> {
  const windowStart = new Date(Date.now() - query.windowDays * 86_400_000);

  const [overview, lastPurchases, products] = await Promise.all([
    prisma.$queryRaw<OverviewRow[]>(Prisma.sql`
      SELECT
        p.id AS product_id,
        p.code,
        p.name,
        c.name AS category_name,
        p.min_stock_base_quantity,
        COALESCE(SUM(b.quantity_on_hand) FILTER (
          WHERE b.status = 'AVAILABLE'
            AND b.expiry_date > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
        ), 0)::int AS sellable
      FROM products p
      JOIN categories c ON c.id = p.category_id
      LEFT JOIN batches b ON b.product_id = p.id AND b.store_id = ${storeId}::uuid
      WHERE p.is_active = true
        ${query.categoryId ? Prisma.sql`AND p.category_id = ${query.categoryId}::uuid` : Prisma.empty}
        ${
          query.search
            ? Prisma.sql`AND (f_unaccent(lower(p.name)) LIKE '%' || f_unaccent(lower(${query.search})) || '%'
                OR lower(p.code) LIKE '%' || lower(${query.search}) || '%')`
            : Prisma.empty
        }
      GROUP BY p.id, c.name
      ORDER BY p.name
    `),
    // Lần nhập gần nhất của từng mặt hàng: gợi ý gọi lại đúng nhà cung cấp cũ.
    prisma.$queryRaw<LastPurchaseRow[]>(Prisma.sql`
      SELECT DISTINCT ON (l.product_id)
        l.product_id,
        r.supplier_id,
        s.name AS supplier_name,
        l.unit_cost::text AS unit_cost,
        u.conversion_to_base,
        r.received_at
      FROM goods_receipt_lines l
      JOIN goods_receipts r ON r.id = l.goods_receipt_id
      JOIN product_units u ON u.id = l.product_unit_id
      LEFT JOIN suppliers s ON s.id = r.supplier_id
      WHERE r.store_id = ${storeId}::uuid AND r.status = 'CONFIRMED'
      ORDER BY l.product_id, r.received_at DESC
    `),
    prisma.product.findMany({
      where: { isActive: true },
      select: { id: true, units: { where: { isActive: true }, select: { id: true, name: true, conversionToBase: true }, orderBy: { conversionToBase: "asc" } } },
    }),
  ]);

  const productIds = overview.map((row) => row.product_id);
  const [sold, onOrder] = await Promise.all([
    prisma.invoiceLine.groupBy({
      by: ["productId"],
      where: { productId: { in: productIds }, invoice: { storeId, status: "COMPLETED", soldAt: { gte: windowStart } } },
      _sum: { baseQuantity: true },
    }),
    // Hàng đã lập phiếu nhập nhưng chưa kiểm nhập: coi như đang trên đường về.
    prisma.goodsReceiptLine.findMany({
      where: { productId: { in: productIds }, goodsReceipt: { storeId, status: "DRAFT" } },
      select: { productId: true, quantity: true, productUnit: { select: { conversionToBase: true } } },
    }),
  ]);

  const soldByProduct = new Map(sold.map((row) => [row.productId, row._sum.baseQuantity ?? 0]));
  const onOrderByProduct = new Map<string, number>();
  for (const line of onOrder) {
    onOrderByProduct.set(line.productId, (onOrderByProduct.get(line.productId) ?? 0) + line.quantity * line.productUnit.conversionToBase);
  }
  const unitsByProduct = new Map(products.map((product) => [product.id, product.units]));
  const lastByProduct = new Map(lastPurchases.map((row) => [row.product_id, row]));

  const suggestions = overview.map((row) => {
    const units = unitsByProduct.get(row.product_id) ?? [];
    const baseUnit = units.find((unit) => unit.conversionToBase === 1) ?? units[0];
    const last = lastByProduct.get(row.product_id);
    // Ưu tiên đặt theo đúng đơn vị của lần nhập trước, nếu không thì đơn vị lớn nhất.
    const orderUnit = (last ? units.find((unit) => unit.conversionToBase === last.conversion_to_base) : undefined) ?? units.at(-1) ?? baseUnit;

    const soldBaseQuantity = soldByProduct.get(row.product_id) ?? 0;
    const avgDaily = soldBaseQuantity / query.windowDays;
    const onOrderBaseQuantity = onOrderByProduct.get(row.product_id) ?? 0;
    const available = row.sellable + onOrderBaseQuantity;

    // Mục tiêu: đủ bán trong kỳ tới cộng thời gian chờ hàng, và không dưới tồn tối thiểu.
    const target = Math.max(Math.ceil(avgDaily * (query.coverDays + query.leadTimeDays)), row.min_stock_base_quantity);
    const missing = Math.max(0, target - available);

    const conversion = orderUnit?.conversionToBase ?? 1;
    const suggestedOrderQuantity = missing > 0 ? Math.ceil(missing / conversion) : 0;
    const suggestedBaseQuantity = suggestedOrderQuantity * conversion;

    const daysOfStock = avgDaily > 0 ? Math.floor(row.sellable / avgDaily) : null;
    const reason: Suggestion["reason"] =
      row.sellable === 0 && (soldBaseQuantity > 0 || row.min_stock_base_quantity > 0)
        ? "OUT_OF_STOCK"
        : row.sellable < row.min_stock_base_quantity
          ? "BELOW_MIN"
          : daysOfStock !== null && daysOfStock <= query.leadTimeDays
            ? "RUNNING_OUT"
            : missing > 0
              ? "REFILL"
              : "OK";

    const lastUnitCost = last ? Math.round(Number(last.unit_cost)) : null;
    return {
      productId: row.product_id,
      code: row.code,
      name: row.name,
      categoryName: row.category_name,
      baseUnitName: baseUnit?.name ?? "",
      orderUnit: orderUnit ?? { id: "", name: "", conversionToBase: 1 },
      sellableBaseQuantity: row.sellable,
      minStockBaseQuantity: row.min_stock_base_quantity,
      onOrderBaseQuantity,
      soldBaseQuantity,
      avgDailyBaseQuantity: Math.round(avgDaily * 100) / 100,
      daysOfStock,
      targetBaseQuantity: target,
      suggestedBaseQuantity,
      suggestedOrderQuantity,
      reason,
      lastSupplier: last?.supplier_id && last.supplier_name ? { id: last.supplier_id, name: last.supplier_name } : null,
      lastUnitCost,
      lastReceivedAt: last?.received_at ?? null,
      estimatedCost: lastUnitCost === null ? null : lastUnitCost * suggestedOrderQuantity,
    } satisfies Suggestion;
  });

  const needed = query.onlyNeeded ? suggestions.filter((item) => item.suggestedOrderQuantity > 0) : suggestions;
  const severity: Record<Suggestion["reason"], number> = { OUT_OF_STOCK: 0, BELOW_MIN: 1, RUNNING_OUT: 2, REFILL: 3, OK: 4 };
  return needed.sort((a, b) => severity[a.reason] - severity[b.reason] || (a.daysOfStock ?? 9999) - (b.daysOfStock ?? 9999) || a.name.localeCompare(b.name, "vi"));
}

export function summarize(suggestions: Suggestion[]) {
  return {
    total: suggestions.length,
    outOfStock: suggestions.filter((item) => item.reason === "OUT_OF_STOCK").length,
    belowMin: suggestions.filter((item) => item.reason === "BELOW_MIN").length,
    runningOut: suggestions.filter((item) => item.reason === "RUNNING_OUT").length,
    refill: suggestions.filter((item) => item.reason === "REFILL").length,
    estimatedCost: suggestions.reduce((sum, item) => sum + (item.estimatedCost ?? 0), 0),
    suppliers: [...new Set(suggestions.map((item) => item.lastSupplier?.name).filter(Boolean))].length,
    withoutSupplier: suggestions.filter((item) => !item.lastSupplier).length,
  };
}
