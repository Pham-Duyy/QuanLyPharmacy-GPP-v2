import { Prisma } from "../generated/prisma/client.js";

type Tx = Prisma.TransactionClient;

/** Ngày làm việc dạng YYYYMMDD theo giờ Việt Nam, dùng trong mã chứng từ. */
export function codeDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" })
    .format(at)
    .replace(/-/g, "");
}

/**
 * Số thứ tự kế tiếp của một dải mã chứng từ, lấy bằng một câu lệnh nguyên tử.
 *
 * Trước đây mỗi service tự đếm `COUNT(*) + 1`: hai người bấm lưu cùng lúc đọc
 * được cùng một số nên sinh ra mã trùng, và chỉ bị chặn ở ràng buộc unique —
 * tức là một trong hai người nhận lỗi 500 dù thao tác hợp lệ.
 *
 * Bộ đếm nằm trong chính transaction của nghiệp vụ, nên:
 * - hai transaction cùng dải mã xếp hàng tại đây, không ai lấy trùng số;
 * - transaction thất bại thì số đã lấy cũng bị hoàn lại, không tạo lỗ hổng số.
 *
 * Đổi lại, việc tạo chứng từ **cùng dải mã** trong một cửa hàng bị tuần tự
 * hóa trong thời gian transaction chạy. Đây là đánh đổi có chủ ý: đúng trước,
 * nhanh sau.
 */
export async function nextDocumentCode(tx: Tx, storeId: string, prefix: string): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ next_value: number }>>(Prisma.sql`
    INSERT INTO document_counters (store_id, scope, next_value)
    VALUES (${storeId}::uuid, ${prefix}, 1)
    ON CONFLICT (store_id, scope)
    DO UPDATE SET next_value = document_counters.next_value + 1
    RETURNING next_value
  `);
  const value = rows[0]?.next_value ?? 1;
  return `${prefix}${String(value).padStart(4, "0")}`;
}
