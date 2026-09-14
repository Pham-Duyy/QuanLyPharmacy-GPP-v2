import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";

/**
 * Băm mật khẩu. Dùng bcryptjs (thuần JavaScript) để không phải biên dịch
 * native trên Windows; contract §3 cho phép bcrypt hoặc argon2id.
 */
const ROUNDS = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// Bỏ I/l/O/0 dễ nhầm khi đọc qua điện thoại hoặc chép tay cho nhân viên mới.
const TEMP_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const TEMP_DIGITS = "23456789";

/**
 * Mật khẩu tạm khi tạo tài khoản hoặc đặt lại (contract §21). Luôn thỏa
 * đúng luật ở `changePasswordSchema` (>= 10 ký tự, có chữ và số) vì người
 * nhận sẽ phải đổi ngay ở lần đăng nhập đầu.
 */
export function generateTempPassword(): string {
  const pool = TEMP_LETTERS + TEMP_DIGITS;
  const rest = Array.from({ length: 10 }, () => pool[randomInt(pool.length)]);
  return [
    TEMP_DIGITS[randomInt(TEMP_DIGITS.length)],
    TEMP_LETTERS[randomInt(TEMP_LETTERS.length)],
    ...rest,
  ].join("");
}
