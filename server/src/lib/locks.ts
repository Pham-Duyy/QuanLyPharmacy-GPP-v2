import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "./app-error.js";

type Tx = Prisma.TransactionClient;

/**
 * Khóa hàng (SELECT ... FOR UPDATE) dùng chung cho các luồng đổi trạng thái.
 *
 * **Thứ tự khóa bắt buộc, không được đảo giữa các luồng** (tránh deadlock):
 *
 *   chứng từ gốc (hóa đơn / phiếu) → khách hàng → lô hàng
 *
 * Ví dụ: hủy hóa đơn khóa hóa đơn trước, rồi khách hàng (hoàn điểm), rồi mới
 * tới các lô để hoàn tồn; bán hàng không có chứng từ gốc nên bắt đầu từ
 * khách hàng rồi tới lô. Nhờ vậy hai luồng bất kỳ luôn xếp hàng theo cùng
 * một chiều.
 */

/** Khóa hóa đơn của đúng cửa hàng. Ném 404 nếu không có. */
export async function lockInvoice(tx: Tx, storeId: string, invoiceId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id::text FROM invoices
    WHERE id = ${invoiceId}::uuid AND store_id = ${storeId}::uuid
    FOR UPDATE
  `);
  if (rows.length === 0) throw AppError.notFound("Không tìm thấy hóa đơn");
}

/**
 * Khóa hồ sơ khách. Mọi thay đổi số dư điểm của cùng một khách phải đi qua
 * khóa này, nếu không hai hóa đơn song song có thể cùng tiêu một số điểm.
 */
export async function lockCustomer(tx: Tx, customerId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id::text FROM customers WHERE id = ${customerId}::uuid FOR UPDATE
  `);
  if (rows.length === 0) throw AppError.notFound("Không tìm thấy khách hàng");
}

/** Khóa một đợt kiểm kê trước khi đọc trạng thái. */
export async function lockStockCount(tx: Tx, storeId: string, countId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id::text FROM stock_counts
    WHERE id = ${countId}::uuid AND store_id = ${storeId}::uuid
    FOR UPDATE
  `);
  if (rows.length === 0) throw AppError.notFound("Không tìm thấy đợt kiểm kê");
}

/** Khóa phiếu trả hàng nhà cung cấp trước khi xác nhận hoặc hủy. */
export async function lockSupplierReturn(tx: Tx, storeId: string, returnId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id::text FROM supplier_returns
    WHERE id = ${returnId}::uuid AND store_id = ${storeId}::uuid
    FOR UPDATE
  `);
  if (rows.length === 0) throw AppError.notFound("Không tìm thấy phiếu trả hàng");
}

/** Khóa phiếu chi nhà cung cấp trước khi hủy. */
export async function lockSupplierPayment(tx: Tx, storeId: string, paymentId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id::text FROM supplier_payments
    WHERE id = ${paymentId}::uuid AND store_id = ${storeId}::uuid
    FOR UPDATE
  `);
  if (rows.length === 0) throw AppError.notFound("Không tìm thấy phiếu chi");
}

/**
 * Khóa các phiếu nhập sắp được phân bổ tiền trả, theo thứ tự id cố định để
 * hai lần thanh toán song song không khóa chéo nhau.
 */
export async function lockGoodsReceipts(tx: Tx, storeId: string, receiptIds: string[]): Promise<void> {
  if (receiptIds.length === 0) return;
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM goods_receipts
    WHERE store_id = ${storeId}::uuid AND id = ANY(${receiptIds}::uuid[])
    ORDER BY id
    FOR UPDATE
  `);
}

/** Khóa các dòng đơn thuốc sắp cấp phát, theo thứ tự id cố định. */
export async function lockPrescriptionItems(tx: Tx, prescriptionId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM prescription_items
    WHERE prescription_id = ${prescriptionId}::uuid
    ORDER BY id
    FOR UPDATE
  `);
}
