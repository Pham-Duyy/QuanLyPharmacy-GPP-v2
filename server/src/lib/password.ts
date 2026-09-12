import bcrypt from "bcryptjs";

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
