import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";

export type CurrentPrice = {
  productUnitId: string;
  salePrice: bigint;
  vatRatePercent: string;
  effectiveFrom: Date;
  isStoreOverride: boolean;
};

/**
 * Giá hiện hành của từng đơn vị tính (contract §6.5).
 * Ưu tiên giá riêng của cửa hàng, không có thì lấy giá chung toàn chuỗi;
 * trong cùng phạm vi thì lấy bản có effective_from mới nhất nhưng không
 * vượt quá thời điểm đang xét.
 */
export async function getCurrentPrices(
  productUnitIds: string[],
  storeId: string | null,
  at: Date = new Date(),
): Promise<Map<string, CurrentPrice>> {
  if (productUnitIds.length === 0) return new Map();

  const rows = await prisma.$queryRaw<
    Array<{
      product_unit_id: string;
      sale_price: bigint;
      vat_rate_percent: Prisma.Decimal;
      effective_from: Date;
      is_store_override: boolean;
    }>
  >(Prisma.sql`
    SELECT DISTINCT ON (product_unit_id)
      product_unit_id::text,
      sale_price,
      vat_rate_percent,
      effective_from,
      (store_id IS NOT NULL) AS is_store_override
    FROM product_prices
    WHERE product_unit_id = ANY(${productUnitIds}::uuid[])
      AND effective_from <= ${at}
      AND (store_id IS NULL OR store_id = ${storeId}::uuid)
    ORDER BY product_unit_id, (store_id IS NOT NULL) DESC, effective_from DESC
  `);

  return new Map(
    rows.map((row) => [
      row.product_unit_id,
      {
        productUnitId: row.product_unit_id,
        salePrice: row.sale_price,
        vatRatePercent: row.vat_rate_percent.toString(),
        effectiveFrom: row.effective_from,
        isStoreOverride: row.is_store_override,
      },
    ]),
  );
}

/** Tồn kho tổng hợp của một sản phẩm tại một cửa hàng, tách theo trạng thái lô. */
export async function getStockSummary(productIds: string[], storeId: string) {
  if (productIds.length === 0) return new Map<string, Record<string, number>>();

  const rows = await prisma.$queryRaw<
    Array<{ product_id: string; sellable: number; quarantined: number; expired: number }>
  >(Prisma.sql`
    SELECT
      product_id::text,
      COALESCE(SUM(quantity_on_hand) FILTER (
        WHERE status = 'AVAILABLE'
          AND expiry_date > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
      ), 0)::int AS sellable,
      COALESCE(SUM(quantity_on_hand) FILTER (WHERE status = 'QUARANTINED'), 0)::int AS quarantined,
      COALESCE(SUM(quantity_on_hand) FILTER (
        WHERE expiry_date <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
      ), 0)::int AS expired
    FROM batches
    WHERE store_id = ${storeId}::uuid AND product_id = ANY(${productIds}::uuid[])
    GROUP BY product_id
  `);

  return new Map(
    rows.map((row) => [
      row.product_id,
      { sellable: row.sellable, quarantined: row.quarantined, expired: row.expired },
    ]),
  );
}
