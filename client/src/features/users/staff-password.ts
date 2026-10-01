/**
 * Luật mật khẩu khớp máy chủ (`newPasswordSchema`): 10–200 ký tự, có chữ và số.
 * Giữ ở một chỗ để form và bộ sinh dùng chung.
 */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

export function passwordProblem(value: string): string | null {
  if (value.length < PASSWORD_MIN) return `Tối thiểu ${PASSWORD_MIN} ký tự`;
  if (value.length > PASSWORD_MAX) return `Tối đa ${PASSWORD_MAX} ký tự`;
  if (!/[a-zA-Z]/.test(value)) return "Cần có ít nhất một chữ cái";
  if (!/[0-9]/.test(value)) return "Cần có ít nhất một chữ số";
  return null;
}

// Bỏ I/l/O/0/1 dễ nhầm khi đọc cho nhân viên.
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "@#%+=!?";

/** Số ngẫu nhiên đều trong [0, max) từ bộ sinh an toàn, không lệch do phép chia dư. */
function secureIndex(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0]! < limit) return buffer[0]! % max;
  }
}

/** Mật khẩu ngẫu nhiên 14 ký tự, luôn thỏa luật máy chủ. Không lưu ở đâu ngoài ô nhập. */
export function generatePassword(length = 14): string {
  const all = LETTERS + DIGITS + SYMBOLS;
  const chars = [
    LETTERS[secureIndex(LETTERS.length)]!,
    DIGITS[secureIndex(DIGITS.length)]!,
    SYMBOLS[secureIndex(SYMBOLS.length)]!,
  ];
  while (chars.length < length) chars.push(all[secureIndex(all.length)]!);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = secureIndex(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

/** Quy tắc tên đăng nhập khớp máy chủ (`createUserSchema`). */
export const USERNAME_PATTERN = /^[a-z0-9._-]{3,50}$/i;
