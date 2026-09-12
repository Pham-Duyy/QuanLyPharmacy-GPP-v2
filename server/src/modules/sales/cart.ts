import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";

type Tx = Prisma.TransactionClient;

export type CartLineInput = { productId: string; unitId: string; quantity: number };

export type ResolvedLine = {
  index: number;
  productId: string;
  productName: string;
  drugClass: string | null;
  productUnitId: string;
  unitName: string;
  conversionToBase: number;
  quantity: number;
  baseQuantity: number;
};

/**
 * Đây là chỗ xử lý vấn đề Critical C2: mọi số lượng đều được quy đổi về đơn
 * vị nhỏ nhất ngay tại đây, và đơn vị phải thuộc đúng sản phẩm. Bán 2 hộp
 * mà trừ 2 viên là sai lệch tồn kho không sửa lại được.
 */
export async function resolveCartLines(tx: Tx, lines: CartLineInput[]): Promise<ResolvedLine[]> {
  const units = await tx.productUnit.findMany({
    where: { id: { in: lines.map((line) => line.unitId) } },
    include: { product: { select: { id: true, name: true, drugClass: true, isActive: true } } },
  });
  const unitById = new Map(units.map((unit) => [unit.id, unit]));

  return lines.map((line, index) => {
    const unit = unitById.get(line.unitId);
    if (!unit || unit.productId !== line.productId) {
      throw new AppError(
        422,
        "UNIT_NOT_IN_PRODUCT",
        `Dòng ${index + 1}: đơn vị tính không thuộc sản phẩm đã chọn`,
      );
    }
    if (!unit.product.isActive) {
      throw AppError.validation(`Dòng ${index + 1}: sản phẩm đã ngừng kinh doanh`);
    }
    if (!unit.isSellable) {
      throw AppError.validation(`Dòng ${index + 1}: đơn vị ${unit.name} không dùng để bán`);
    }

    return {
      index,
      productId: line.productId,
      productName: unit.product.name,
      drugClass: unit.product.drugClass,
      productUnitId: unit.id,
      unitName: unit.name,
      conversionToBase: unit.conversionToBase,
      quantity: line.quantity,
      baseQuantity: line.quantity * unit.conversionToBase,
    };
  });
}

export type SellableBatch = {
  id: string;
  productId: string;
  batchNumber: string;
  quantityOnHand: number;
  expiryDate: Date;
};

/**
 * Điều kiện “lô bán được” của contract §5.1, viết một lần dùng cho cả kiểm
 * tra an toàn lẫn lúc xuất hàng, để hai nơi không bao giờ lệch nhau.
 */
function sellableWhere(storeId: string, productIds: string[], minRemainingDays: number) {
  return Prisma.sql`
    store_id = ${storeId}::uuid
    AND product_id = ANY(${productIds}::uuid[])
    AND status = 'AVAILABLE'
    AND quantity_on_hand > 0
    AND expiry_date > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
    AND expiry_date >= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + ${minRemainingDays}::int
  `;
}

type BatchRow = {
  id: string;
  product_id: string;
  batch_number: string;
  quantity_on_hand: number;
  expiry_date: Date;
};

function toBatch(row: BatchRow): SellableBatch {
  return {
    id: row.id,
    productId: row.product_id,
    batchNumber: row.batch_number,
    quantityOnHand: row.quantity_on_hand,
    expiryDate: row.expiry_date,
  };
}

/** Đọc không khóa, dùng cho kiểm tra an toàn trước khi thanh toán. */
export async function findSellableBatches(
  tx: Tx,
  storeId: string,
  productIds: string[],
  minRemainingDays: number,
): Promise<SellableBatch[]> {
  if (productIds.length === 0) return [];

  const rows = await tx.$queryRaw<BatchRow[]>(Prisma.sql`
    SELECT id::text, product_id::text, batch_number, quantity_on_hand, expiry_date
    FROM batches
    WHERE ${sellableWhere(storeId, productIds, minRemainingDays)}
    ORDER BY expiry_date, id
  `);

  return rows.map(toBatch);
}

/**
 * Đọc có khóa, dùng khi thực sự xuất hàng.
 *
 * Khóa theo thứ tự cố định (product_id, id) chứ không theo thứ tự FEFO:
 * hai quầy bán cùng lúc sẽ xin khóa theo cùng một thứ tự nên không ôm chéo
 * nhau gây deadlock. Việc sắp xếp FEFO làm sau, trên bộ nhớ.
 */
export async function lockSellableBatches(
  tx: Tx,
  storeId: string,
  productIds: string[],
  minRemainingDays: number,
): Promise<SellableBatch[]> {
  if (productIds.length === 0) return [];

  const rows = await tx.$queryRaw<BatchRow[]>(Prisma.sql`
    SELECT id::text, product_id::text, batch_number, quantity_on_hand, expiry_date
    FROM batches
    WHERE ${sellableWhere(storeId, productIds, minRemainingDays)}
    ORDER BY product_id, id
    FOR UPDATE
  `);

  return rows.map(toBatch);
}

/** Tồn bán được của từng sản phẩm, gộp từ các lô bán được. */
export function sumByProduct(batches: SellableBatch[]): Map<string, number> {
  const total = new Map<string, number>();
  for (const batch of batches) {
    total.set(batch.productId, (total.get(batch.productId) ?? 0) + batch.quantityOnHand);
  }
  return total;
}
