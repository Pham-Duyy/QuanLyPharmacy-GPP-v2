import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";

export type InventoryOverviewQuery = {
  productId?: string;
  categoryId?: string;
  belowMinStock?: boolean;
};

type OverviewRow = {
  product_id: string;
  code: string;
  name: string;
  category_name: string;
  min_stock_base_quantity: number;
  sellable: number;
  quarantined: number;
  recalled: number;
  expired: number;
};

/**
 * Tồn tổng hợp theo sản phẩm tại một cửa hàng (contract §10.1). Không phân
 * trang ở CSDL: danh mục một cửa hàng ở quy mô nhà thuốc lẻ không lớn, lọc
 * `belowMinStock` lại phụ thuộc giá trị đã tổng hợp (HAVING), nên gộp một
 * truy vấn rồi cắt trang ở tầng ứng dụng cho đơn giản.
 */
export async function getInventoryOverview(storeId: string, query: InventoryOverviewQuery) {
  const rows = await prisma.$queryRaw<OverviewRow[]>(Prisma.sql`
    SELECT
      p.id::text AS product_id,
      p.code,
      p.name,
      c.name AS category_name,
      p.min_stock_base_quantity,
      COALESCE(SUM(b.quantity_on_hand) FILTER (
        WHERE b.status = 'AVAILABLE'
          AND b.expiry_date > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
      ), 0)::int AS sellable,
      COALESCE(SUM(b.quantity_on_hand) FILTER (WHERE b.status = 'QUARANTINED'), 0)::int AS quarantined,
      COALESCE(SUM(b.quantity_on_hand) FILTER (WHERE b.status = 'RECALLED'), 0)::int AS recalled,
      COALESCE(SUM(b.quantity_on_hand) FILTER (
        WHERE b.expiry_date <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
      ), 0)::int AS expired
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN batches b ON b.product_id = p.id AND b.store_id = ${storeId}::uuid
    WHERE p.is_active = true
      ${query.productId ? Prisma.sql`AND p.id = ${query.productId}::uuid` : Prisma.empty}
      ${query.categoryId ? Prisma.sql`AND p.category_id = ${query.categoryId}::uuid` : Prisma.empty}
    GROUP BY p.id, c.name
    ${
      query.belowMinStock
        ? Prisma.sql`HAVING COALESCE(SUM(b.quantity_on_hand) FILTER (
            WHERE b.status = 'AVAILABLE'
              AND b.expiry_date > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
          ), 0) < p.min_stock_base_quantity`
        : Prisma.empty
    }
    ORDER BY p.name
  `);

  return rows.map((row) => ({
    productId: row.product_id,
    code: row.code,
    name: row.name,
    categoryName: row.category_name,
    minStockBaseQuantity: row.min_stock_base_quantity,
    stock: {
      sellable: row.sellable,
      quarantined: row.quarantined,
      recalled: row.recalled,
      expired: row.expired,
    },
  }));
}

const MOVEMENT_TYPES = [
  "RECEIPT",
  "OPENING_BALANCE",
  "SALE",
  "SALE_VOID",
  "CUSTOMER_RETURN",
  "ADJUSTMENT",
  "DISPOSAL",
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export type StockLedgerQuery = {
  batchId?: string;
  productId?: string;
  type?: MovementType;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
};

/**
 * Thẻ kho (contract §10.2): chỉ thêm, không sửa/xóa, phân trang con trỏ
 * theo `id` (tăng dần theo thời gian ghi) thay vì offset, vì dữ liệu tăng
 * liên tục và client thường chỉ cần "trang tiếp theo", không cần nhảy trang.
 */
export async function listStockLedger(storeId: string, query: StockLedgerQuery) {
  const rows = await prisma.stockMovement.findMany({
    where: {
      storeId,
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.from || query.to ? { occurredAt: { gte: query.from, lte: query.to } } : {}),
      ...(query.cursor ? { id: { lt: BigInt(query.cursor) } } : {}),
    },
    orderBy: { id: "desc" },
    take: query.limit + 1,
    include: {
      batch: { select: { batchNumber: true } },
      product: { select: { code: true, name: true } },
      user: { select: { fullName: true } },
    },
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  return {
    items: page.map((row) => ({
      id: row.id.toString(),
      occurredAt: row.occurredAt,
      type: row.type,
      batchId: row.batchId,
      batchNumber: row.batch.batchNumber,
      productId: row.productId,
      productCode: row.product.code,
      productName: row.product.name,
      baseQuantity: row.baseQuantity,
      balanceAfter: row.balanceAfter,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      sourceLineId: row.sourceLineId,
      userId: row.userId,
      userName: row.user?.fullName ?? null,
      note: row.note,
    })),
    nextCursor: hasMore ? page[page.length - 1]!.id.toString() : null,
  };
}
