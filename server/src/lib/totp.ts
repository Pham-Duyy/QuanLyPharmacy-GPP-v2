import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Mã dùng một lần theo thời gian (TOTP, RFC 6238) cho xác thực hai lớp
 * (Phase 7, D31). Cùng thông số mặc định với Google Authenticator và
 * Microsoft Authenticator: HMAC-SHA1, bước 30 giây, 6 chữ số.
 */

export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("Khóa base32 không hợp lệ");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Khóa bí mật mới: 20 byte ngẫu nhiên (160 bit, theo khuyến nghị RFC 4226), dạng base32. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Mã HOTP (RFC 4226) của một bộ đếm. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function timeStep(at = Date.now()): number {
  return Math.floor(at / 1000 / TOTP_STEP_SECONDS);
}

export function totp(secretBase32: string, at = Date.now()): string {
  return hotp(base32Decode(secretBase32), timeStep(at));
}

/**
 * Kiểm tra mã người dùng nhập, chấp nhận lệch một bước (±30 giây) vì đồng hồ
 * điện thoại và máy chủ không khớp tuyệt đối. Trả về bước thời gian của mã
 * khớp để chặn dùng lại, hoặc `null` khi sai.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: { at?: number; afterStep?: number | null } = {},
): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const secret = base32Decode(secretBase32);
  const current = timeStep(options.at);
  for (const step of [current - 1, current, current + 1]) {
    // Mã của bước đã dùng (hoặc cũ hơn) không nhận lại.
    if (options.afterStep !== undefined && options.afterStep !== null && step <= options.afterStep)
      continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(clean))) return step;
  }
  return null;
}

/** Địa chỉ `otpauth://` để ứng dụng xác thực quét bằng mã QR. */
export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
