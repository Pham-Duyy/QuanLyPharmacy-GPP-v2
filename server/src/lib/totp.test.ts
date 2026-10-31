import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateSecret,
  hotp,
  otpauthUrl,
  totp,
  verifyTotp,
} from "./totp.js";

// Khóa trong phụ lục RFC 4226 / RFC 6238: chuỗi ASCII "12345678901234567890".
const RFC_SECRET = Buffer.from("12345678901234567890");
const RFC_BASE32 = base32Encode(RFC_SECRET);

describe("TOTP theo RFC", () => {
  it("HOTP đúng bảng kiểm thử RFC 4226", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676"];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it("TOTP đúng bảng kiểm thử RFC 6238 (SHA1, 8 số rút về 6 số cuối)", () => {
    expect(totp(RFC_BASE32, 59 * 1000)).toBe("287082");
    expect(totp(RFC_BASE32, 1111111109 * 1000)).toBe("081804");
    expect(totp(RFC_BASE32, 1234567890 * 1000)).toBe("005924");
    expect(totp(RFC_BASE32, 2000000000 * 1000)).toBe("279037");
  });

  it("base32 mã hóa rồi giải mã ra đúng", () => {
    expect(RFC_BASE32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(RFC_BASE32)).toEqual(RFC_SECRET);
    expect(base32Decode(generateSecret())).toHaveLength(20);
  });
});

describe("Kiểm tra mã", () => {
  const at = 1_800_000_000_000;

  it("nhận mã hiện tại và lệch một bước, từ chối lệch hai bước", () => {
    expect(verifyTotp(RFC_BASE32, totp(RFC_BASE32, at), { at })).not.toBeNull();
    expect(verifyTotp(RFC_BASE32, totp(RFC_BASE32, at - 30_000), { at })).not.toBeNull();
    expect(verifyTotp(RFC_BASE32, totp(RFC_BASE32, at + 30_000), { at })).not.toBeNull();
    expect(verifyTotp(RFC_BASE32, totp(RFC_BASE32, at - 90_000), { at })).toBeNull();
  });

  it("không nhận lại mã của bước đã dùng", () => {
    const code = totp(RFC_BASE32, at);
    const step = verifyTotp(RFC_BASE32, code, { at });
    expect(step).not.toBeNull();
    expect(verifyTotp(RFC_BASE32, code, { at, afterStep: step })).toBeNull();
  });

  it("từ chối mã sai định dạng", () => {
    expect(verifyTotp(RFC_BASE32, "12345", { at })).toBeNull();
    expect(verifyTotp(RFC_BASE32, "abcdef", { at })).toBeNull();
  });

  it("địa chỉ otpauth cho ứng dụng xác thực", () => {
    const url = otpauthUrl("ABC", "demochu", "Pharmacy GPP");
    expect(url).toBe(
      "otpauth://totp/Pharmacy%20GPP%3Ademochu?secret=ABC&issuer=Pharmacy+GPP&algorithm=SHA1&digits=6&period=30",
    );
  });
});
