import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";

type Tx = Prisma.TransactionClient;

export type BatchValue = { id: string; quantityOnHand: number; unitCost: Prisma.Decimal | null };

/** Số thập phân gửi xuống Postgres dưới dạng chuỗi để không mất chữ số qua kiểu float. */
function numericParam(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed(6);
}

/**
 * Cộng hàng vào một lô và tính lại **giá vốn bình quân gia quyền** trong
 * đúng một câu lệnh.
 *
 * Đây là điểm mấu chốt: tồn và giá vốn dùng để tính nằm ngay trong biểu thức
 * SET, nên PostgreSQL đọc chúng **sau khi đã giữ khóa hàng** của chính lệnh
 * này. Hai phiếu nhập song song (hoặc nhập trong lúc đang bán) vì thế xếp
 * hàng tại đây và mỗi lệnh tính trên số liệu mới nhất, thay vì cùng đọc số
 * cũ rồi ghi đè nhau.
 *
 * `unitCost = null`: không biết giá vốn của lượng hàng đang cộng vào (dữ
 * liệu cũ trước khi có giá vốn chụp lúc xuất). Khi đó giá vốn bình quân của
 * lô **giữ nguyên** — không suy diễn một con số không khôi phục được.
 *
 * `expectedExpiryDate`: chốt chặn cuối cho quy tắc "cùng số lô thì phải cùng
 * hạn dùng"; không khớp thì không ghi gì và trả về `null`.
 */
export async function addToBatch(
  tx: Tx,
  batchId: string,
  baseQuantity: number,
  unitCost: Prisma.Decimal | null,
  options: {
    /** Chốt chặn "cùng số lô thì cùng hạn dùng" khi nhập hàng. */
    expectedExpiryDate?: Date;
    /**
     * Hàng khách trả về đúng lô đã xuất, kể cả lô đang bị thu hồi: hàng thật
     * đang nằm ở đó nên thẻ kho phải phản ánh đúng.
     */
    allowRecalled?: boolean;
  } = {},
): Promise<BatchValue | null> {
  if (baseQuantity <= 0) {
    throw AppError.validation("Số lượng cộng vào lô phải lớn hơn 0");
  }

  const cost = numericParam(unitCost);
  const expiry = options.expectedExpiryDate ?? null;
  const allowRecalled = options.allowRecalled ?? false;
  const rows = await tx.$queryRaw<
    Array<{ id: string; quantity_on_hand: number; unit_cost: Prisma.Decimal | null }>
  >(Prisma.sql`
    UPDATE batches SET
      quantity_on_hand = quantity_on_hand + ${baseQuantity},
      unit_cost = CASE
        WHEN ${cost}::numeric IS NULL THEN unit_cost
        WHEN quantity_on_hand <= 0 OR unit_cost IS NULL THEN ${cost}::numeric
        ELSE (unit_cost * quantity_on_hand + ${cost}::numeric * ${baseQuantity})
             / (quantity_on_hand + ${baseQuantity})
      END,
      updated_at = now()
    WHERE id = ${batchId}::uuid
      AND (${expiry}::date IS NULL OR expiry_date = ${expiry}::date)
      AND (${allowRecalled} OR status <> 'RECALLED')
    RETURNING id::text, quantity_on_hand, unit_cost
  `);

  return rows[0]
    ? { id: rows[0].id, quantityOnHand: rows[0].quantity_on_hand, unitCost: rows[0].unit_cost }
    : null;
}

/**
 * Tạo lô mới, hoặc trả về `null` nếu một giao dịch khác vừa tạo đúng lô đó.
 * Người gọi khi đó đi tiếp đường "nhập thêm vào lô đã có".
 */
export async function insertBatchIfAbsent(
  tx: Tx,
  data: {
    storeId: string;
    productId: string;
    batchNumber: string;
    manufactureDate: Date | null;
    expiryDate: Date;
    baseQuantity: number;
    unitCost: Prisma.Decimal;
    status: string;
    note: string | null;
    sourceType: string;
    sourceId: string;
  },
): Promise<BatchValue | null> {
  const rows = await tx.$queryRaw<
    Array<{ id: string; quantity_on_hand: number; unit_cost: Prisma.Decimal | null }>
  >(Prisma.sql`
    INSERT INTO batches (
      store_id, product_id, batch_number, manufacture_date, expiry_date,
      quantity_on_hand, unit_cost, status, note, source_type, source_id, updated_at
    )
    VALUES (
      ${data.storeId}::uuid, ${data.productId}::uuid, ${data.batchNumber},
      ${data.manufactureDate}::date, ${data.expiryDate}::date,
      ${data.baseQuantity}, ${numericParam(data.unitCost)}::numeric, ${data.status},
      ${data.note}, ${data.sourceType}, ${data.sourceId}::uuid, now()
    )
    ON CONFLICT (store_id, product_id, batch_number) DO NOTHING
    RETURNING id::text, quantity_on_hand, unit_cost
  `);

  const row = rows[0];
  if (!row) return null;
  return { id: row.id, quantityOnHand: row.quantity_on_hand, unitCost: row.unit_cost };
}

/** Đọc lô theo số lô, không khóa: chỉ dùng để dựng thông báo lỗi cho người dùng. */
export async function readBatchByNumber(
  tx: Tx,
  storeId: string,
  productId: string,
  batchNumber: string,
): Promise<(BatchValue & { expiryDate: Date; status: string }) | null> {
  const found = await tx.batch.findUnique({
    where: { storeId_productId_batchNumber: { storeId, productId, batchNumber } },
    select: { id: true, quantityOnHand: true, unitCost: true, expiryDate: true, status: true },
  });
  return found;
}
