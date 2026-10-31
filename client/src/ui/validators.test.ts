import { describe, expect, it } from "vitest";
import { normalizeVnPhone } from "./validators";

describe("normalizeVnPhone", () => {
  it("chuẩn hóa số di động viết nhiều kiểu", () => {
    expect(normalizeVnPhone("0901234567")).toBe("0901234567");
    expect(normalizeVnPhone("090 123 4567")).toBe("0901234567");
    expect(normalizeVnPhone("090.123.4567")).toBe("0901234567");
    expect(normalizeVnPhone("+84 901 234 567")).toBe("0901234567");
    expect(normalizeVnPhone("84901234567")).toBe("0901234567");
  });

  it("nhận số máy bàn 11 số", () => {
    expect(normalizeVnPhone("028 3812 3456")).toBe("02838123456");
  });

  it("từ chối chữ, số quá ngắn, đầu số sai", () => {
    expect(normalizeVnPhone("abc")).toBeNull();
    expect(normalizeVnPhone("123")).toBeNull();
    expect(normalizeVnPhone("0101234567")).toBeNull();
    expect(normalizeVnPhone("09012345678")).toBeNull();
  });
});
