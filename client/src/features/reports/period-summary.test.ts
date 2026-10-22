import { describe, expect, it } from "vitest";
import {
  longIdle,
  matchesProduct,
  rankSales,
  type IdleRow,
  type SalesRow,
} from "./period-summary.js";

const sale = (code: string, name: string, quantity: number, revenue: number): SalesRow => ({
  productId: code,
  code,
  name,
  unit: "Viên",
  quantity,
  revenue,
  grossProfit: null,
  invoices: 1,
  share: 0,
});

const rows = [
  sale("A", "Amoxicillin", 900, 13_000_000),
  sale("B", "Berberin", 3600, 1_500_000),
  sale("C", "Codein", 40, 60_000),
];

describe("xếp hạng bán trong tháng", () => {
  it("hạng 1 là bán nhiều nhất theo tiêu chí đang chọn", () => {
    expect(rankSales(rows, "revenue", "desc").map((row) => `${row.rank}${row.code}`)).toEqual([
      "1A",
      "2B",
      "3C",
    ]);
    expect(rankSales(rows, "quantity", "desc").map((row) => `${row.rank}${row.code}`)).toEqual([
      "1B",
      "2A",
      "3C",
    ]);
  });

  it("xem ít nhất trước chỉ đảo thứ tự, thuốc bán ít nhất vẫn mang hạng cuối", () => {
    expect(rankSales(rows, "revenue", "asc").map((row) => `${row.rank}${row.code}`)).toEqual([
      "3C",
      "2B",
      "1A",
    ]);
  });
});

describe("tìm thuốc và lọc tồn lâu", () => {
  it("tìm theo tên hoặc mã, gõ không dấu vẫn ra", () => {
    const row = { code: "TH0208", name: "Prednisolon 5mg" };
    expect(matchesProduct(row, "predni")).toBe(true);
    expect(matchesProduct(row, "th0208")).toBe(true);
    expect(matchesProduct({ code: "X", name: "Dầu cá Omega-3" }, "dau ca")).toBe(true);
    expect(matchesProduct(row, "amox")).toBe(false);
    expect(matchesProduct(row, "  ")).toBe(true);
  });

  it("tồn lâu là thuốc đã đứng yên từ số ngày chọn trở lên", () => {
    const idle = (code: string, daysIdle: number) => ({ code, daysIdle }) as IdleRow;
    const list = [idle("A", 20), idle("B", 60), idle("C", 95)];
    expect(longIdle(list, 60).map((row) => row.code)).toEqual(["B", "C"]);
    expect(longIdle(list, 90).map((row) => row.code)).toEqual(["C"]);
  });
});
