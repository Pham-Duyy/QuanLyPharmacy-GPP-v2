import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

/**
 * URL có chữ ký, hạn ngắn để xem ảnh đơn thuốc (contract §12) — cùng cơ
 * chế URL định trước chữ ký (presigned URL) như các dịch vụ lưu trữ đám
 * mây vẫn dùng, tự viết bằng HMAC vì chỉ cần ký và xác minh, không cần lưu
 * trạng thái. Dùng lại JWT_SECRET làm khóa ký thay vì thêm biến môi trường
 * mới — đây vẫn là một bí mật của riêng máy chủ, không lộ ra ngoài.
 *
 * Vì sao không bắt buộc đăng nhập ở endpoint đọc ảnh: ảnh hiển thị qua thẻ
 * <img>, trình duyệt không gắn được header Authorization vào request đó.
 * Chữ ký hạn ngắn thay thế cho việc đó — mỗi lần xem chi tiết đơn thuốc,
 * server tự ký lại URL mới, hạn 5 phút là đủ dùng cho một phiên xem.
 */
const TTL_SECONDS = 5 * 60;

function sign(imageId: string, expiresAt: number): string {
  return createHmac("sha256", env.JWT_SECRET).update(`${imageId}:${expiresAt}`).digest("hex");
}

/** `ttlSeconds` tùy chọn để test dựng được cả URL đã hết hạn (truyền số âm). */
export function createSignedImageUrl(
  imageId: string,
  ttlSeconds = TTL_SECONDS,
): { expires: number; sig: string } {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { expires, sig: sign(imageId, expires) };
}

export function verifySignedImageUrl(imageId: string, expires: number, sig: string): boolean {
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;

  const expected = Buffer.from(sign(imageId, expires), "hex");
  const actual = Buffer.from(sig, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
