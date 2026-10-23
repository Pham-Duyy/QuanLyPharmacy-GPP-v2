import { describe, expect, it } from "vitest";
import { packBreakdown } from "./packs.js";

const amoxicillin = [
  { name: "Hộp", conversionToBase: 14 },
  { name: "Vỉ", conversionToBase: 7 },
];
const paracetamol = [
  { name: "Hộp", conversionToBase: 100 },
  { name: "Vỉ", conversionToBase: 10 },
];

describe("quy đổi số lượng sang đơn vị lớn", () => {
  it("tách từ đơn vị lớn nhất xuống, bỏ phần bằng 0", () => {
    expect(packBreakdown(931, amoxicillin, "Viên")).toBe("66 Hộp 1 Vỉ");
    expect(packBreakdown(1234, paracetamol, "Viên")).toBe("12 Hộp 3 Vỉ 4 Viên");
    expect(packBreakdown(2130, [{ name: "Hộp", conversionToBase: 50 }], "Cái")).toBe(
      "42 Hộp 30 Cái",
    );
    expect(packBreakdown(3600, [{ name: "Lọ", conversionToBase: 100 }], "Viên")).toBe("36 Lọ");
    expect(packBreakdown(120_000, paracetamol, "Viên")).toBe("1.200 Hộp");
  });

  it("không có gì để quy đổi thì không hiện dòng phụ", () => {
    // Thuốc chỉ có một đơn vị.
    expect(packBreakdown(96, [], "Chai")).toBeNull();
    // Chưa đủ một vỉ.
    expect(packBreakdown(7, paracetamol, "Viên")).toBeNull();
    expect(packBreakdown(0, paracetamol, "Viên")).toBeNull();
  });

  it("không phụ thuộc thứ tự đơn vị máy chủ trả, số âm giữ dấu trừ", () => {
    expect(packBreakdown(931, [...amoxicillin].reverse(), "Viên")).toBe("66 Hộp 1 Vỉ");
    expect(packBreakdown(-25, paracetamol, "Viên")).toBe("−2 Vỉ 5 Viên");
  });
});
