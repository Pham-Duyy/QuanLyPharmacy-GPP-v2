import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { env } from "../../config/env.js";

/**
 * Mật khẩu tài khoản liên thông không được lưu thô trong CSDL: bản sao lưu
 * CSDL đi ra ngoài là lộ luôn tài khoản gửi dữ liệu lên Bộ Y tế.
 *
 * Khóa dẫn xuất từ JWT_SECRET nên không phải thêm biến môi trường mới. Đổi
 * JWT_SECRET là các mật khẩu đã lưu không giải mã được nữa — khi đó chỉ cần
 * nhập lại mật khẩu ở màn cấu hình.
 */
const KEY = scryptSync(env.JWT_SECRET, "national-sync-credentials", 32);
const IV_BYTES = 12;

export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  // iv.tag.dữ liệu — tất cả base64url để lưu gọn trong một cột text.
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

/** Trả về `null` khi bản mã hỏng hoặc khóa đã đổi, để lỗi hiện ra ở màn cấu hình chứ không làm sập tiến trình. */
export function decryptSecret(stored: string): string | null {
  const parts = stored.split(".");
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, data] = parts.map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", KEY, iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(data!), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
