import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseOrThrow } from "./validate.js";
import {
  lineQuantity,
  money,
  normalizeVnPhone,
  optionalPhone,
  optionalTaxCode,
} from "./validators.js";

describe("normalizeVnPhone", () => {
  it("chuẩn hóa các cách viết số di động", () => {
    for (const raw of [
      "0901234567",
      "090 123 4567",
      "090.123.4567",
      "+84 901 234 567",
      "84901234567",
    ]) {
      expect(normalizeVnPhone(raw)).toBe("0901234567");
    }
  });

  it("thêm lại số 0 đầu mà Excel làm mất", () => {
    expect(normalizeVnPhone("901234567")).toBe("0901234567");
    expect(normalizeVnPhone("2838123456")).toBe("02838123456");
  });

  it("từ chối chữ, số quá ngắn, quá dài, đầu số không có thật", () => {
    for (const raw of ["abc", "123", "09012345678", "0101234567", "0901234abc"]) {
      expect(normalizeVnPhone(raw)).toBeNull();
    }
  });
});

describe("Luật dùng chung", () => {
  const schema = z.object({ phone: optionalPhone(), taxCode: optionalTaxCode() });

  it("chuỗi rỗng là không nhập, giữ nguyên undefined khi không gửi", () => {
    expect(schema.parse({ phone: "", taxCode: "" })).toEqual({ phone: null, taxCode: null });
    expect(schema.parse({})).toEqual({});
  });

  it("mã số thuế 10 số hoặc 10 số kèm mã chi nhánh", () => {
    expect(schema.parse({ taxCode: "0100108536" }).taxCode).toBe("0100108536");
    expect(schema.parse({ taxCode: "0100108536-001" }).taxCode).toBe("0100108536-001");
    expect(schema.safeParse({ taxCode: "12" }).success).toBe(false);
  });

  it("tiền phải nguyên đồng, không âm, không quá lớn", () => {
    expect(money().safeParse(1000).success).toBe(true);
    expect(money().safeParse(1.5).success).toBe(false);
    expect(money().safeParse(-1).success).toBe(false);
    expect(money().safeParse(1e13).success).toBe(false);
  });

  it("số lượng một dòng có trần để không tràn cột số nguyên của CSDL", () => {
    expect(lineQuantity().safeParse(1).success).toBe(true);
    expect(lineQuantity().safeParse(0).success).toBe(false);
    expect(lineQuantity().safeParse(1e12).success).toBe(false);
  });

  it("câu báo lỗi mặc định bằng tiếng Việt", () => {
    try {
      parseOrThrow(z.object({ quantity: z.number().int().max(5) }), { quantity: 1.5 });
      expect.unreachable();
    } catch (error) {
      const details = (error as { details: Array<{ message: string }> }).details;
      expect(details[0]?.message).toBe("Phải là số nguyên");
    }
  });
});
