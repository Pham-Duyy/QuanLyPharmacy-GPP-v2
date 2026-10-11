import { describe, expect, it } from "vitest";
import { applyScan, pendingPicks, scanConfirmsLine, type ScanLine } from "./scan-confirm.js";

function line(key: string, overrides: Partial<ScanLine> = {}): ScanLine {
  return { key, product: { id: "amox" }, unitId: "hop", quantity: 1, scanned: 0, ...overrides };
}
const fresh = (productId: string, unitId: string) => () =>
  line("new", { product: { id: productId }, unitId, scanned: 1 });

describe("quét xác nhận lấy đúng thuốc", () => {
  it("dòng chưa quét đủ: chỉ đánh dấu, không tăng số lượng", () => {
    const cart = [line("a", { quantity: 2 })];
    expect(scanConfirmsLine(cart, "amox", "hop")).toBe(true);
    const once = applyScan(cart, "amox", "hop", fresh("amox", "hop"));
    expect(once).toEqual([line("a", { quantity: 2, scanned: 1 })]);
    const twice = applyScan(once, "amox", "hop", fresh("amox", "hop"));
    expect(twice).toEqual([line("a", { quantity: 2, scanned: 2 })]);
  });

  it("quét đủ rồi mà quét tiếp thì thêm 1 như trước", () => {
    const cart = [line("a", { quantity: 2, scanned: 2 })];
    expect(scanConfirmsLine(cart, "amox", "hop")).toBe(false);
    expect(applyScan(cart, "amox", "hop", fresh("amox", "hop"))).toEqual([
      line("a", { quantity: 3, scanned: 3 }),
    ]);
  });

  it("quét mã hộp cho dòng bán lẻ theo vỉ vẫn tính là đúng thuốc", () => {
    const cart = [line("a", { unitId: "vi", quantity: 3 })];
    expect(scanConfirmsLine(cart, "amox", "hop")).toBe(true);
    expect(applyScan(cart, "amox", "hop", fresh("amox", "hop"))).toEqual([
      line("a", { unitId: "vi", quantity: 3, scanned: 1 }),
    ]);
    // Dòng vỉ đã xác nhận: quét hộp nữa là bán thêm một hộp.
    const confirmed = [line("a", { unitId: "vi", quantity: 3, scanned: 1 })];
    expect(applyScan(confirmed, "amox", "hop", fresh("amox", "hop"))).toHaveLength(2);
  });

  it("thuốc chưa có trong giỏ thì thêm dòng mới đã quét", () => {
    const next = applyScan([line("a")], "para", "vien", fresh("para", "vien"));
    expect(next.map((item) => item.key)).toEqual(["a", "new"]);
    expect(next[1]!.scanned).toBe(1);
  });

  it("đơn thuốc còn dòng chưa lấy mà quét thuốc ngoài đơn thì nghi lấy nhầm", () => {
    const cart = [
      line("a", { fromPrescription: true }),
      line("b", { product: { id: "ome" }, fromPrescription: true, scanned: 1 }),
    ];
    expect(pendingPicks(cart, "para", false).map((item) => item.key)).toEqual(["a"]);
    // Thuốc có trong đơn, hoặc đã có trong giỏ: không hỏi.
    expect(pendingPicks(cart, "para", true)).toEqual([]);
    expect(pendingPicks(cart, "amox", false)).toEqual([]);
    // Bán thường (không có dòng tự điền từ đơn) hoặc đã lấy đủ: không hỏi.
    expect(pendingPicks([line("a")], "para", false)).toEqual([]);
    expect(
      pendingPicks([line("a", { fromPrescription: true, scanned: 1 })], "para", false),
    ).toEqual([]);
  });
});
