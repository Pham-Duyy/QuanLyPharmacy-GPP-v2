import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";

type Tx = Prisma.TransactionClient;

/**
 * Vị trí để thuốc của một lô (tủ–kệ–ngăn), gõ tự do kiểu `A-02-03` hoặc
 * `TỦ LẠNH`. Viết hoa, bỏ khoảng trắng thừa để cả cửa hàng ghi cùng một kiểu
 * — đếm kiểm kê theo kệ mới gom đúng. Rỗng là chưa có vị trí.
 */
export function normalizeShelfLocation(value: string | null | undefined): string | null {
  const text = (value ?? "").replace(/\s+/g, " ").trim().toUpperCase();
  return text ? text.slice(0, 30) : null;
}

/**
 * Đặt vị trí cho lô vừa nhập vào kho. Có chọn thì ghi đúng vị trí đó; không
 * chọn thì lô chưa có vị trí lấy vị trí gần nhất của cùng thuốc trong cửa
 * hàng (hàng mới thường xếp cạnh hàng cũ).
 */
export async function placeBatch(
  tx: Tx,
  input: { storeId: string; batchId: string; productId: string; requested?: string | null },
): Promise<void> {
  const location = normalizeShelfLocation(input.requested);
  if (location) {
    await tx.batch.update({ where: { id: input.batchId }, data: { shelfLocation: location } });
    return;
  }
  await tx.$executeRaw(Prisma.sql`
    UPDATE batches SET shelf_location = (
      SELECT other.shelf_location FROM batches other
      WHERE other.store_id = ${input.storeId}::uuid
        AND other.product_id = ${input.productId}::uuid
        AND other.shelf_location IS NOT NULL
        AND other.id <> ${input.batchId}::uuid
      ORDER BY other.created_at DESC
      LIMIT 1
    )
    WHERE id = ${input.batchId}::uuid AND shelf_location IS NULL
  `);
}

/**
 * Gợi ý khi nhập vị trí: các vị trí cửa hàng đang dùng (dùng nhiều đứng
 * trước) và vị trí gần nhất của từng thuốc để điền sẵn.
 */
export async function locationHints(storeId: string, productIds: string[]) {
  const [used, latest] = await Promise.all([
    prisma.$queryRaw<Array<{ location: string }>>(Prisma.sql`
      SELECT shelf_location AS location FROM batches
      WHERE store_id = ${storeId}::uuid AND shelf_location IS NOT NULL
      GROUP BY shelf_location
      ORDER BY count(*) DESC, shelf_location
      LIMIT 200
    `),
    productIds.length
      ? prisma.$queryRaw<Array<{ product_id: string; location: string }>>(Prisma.sql`
          SELECT DISTINCT ON (product_id) product_id::text, shelf_location AS location
          FROM batches
          WHERE store_id = ${storeId}::uuid AND product_id = ANY(${productIds}::uuid[])
            AND shelf_location IS NOT NULL
          ORDER BY product_id, created_at DESC
        `)
      : Promise.resolve([]),
  ]);
  return {
    locations: used.map((row) => row.location),
    byProduct: Object.fromEntries(latest.map((row) => [row.product_id, row.location])) as Record<
      string,
      string
    >,
  };
}
