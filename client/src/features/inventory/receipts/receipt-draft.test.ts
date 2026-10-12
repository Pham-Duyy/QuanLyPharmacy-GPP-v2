import dayjs from "dayjs";
import { describe, expect, it } from "vitest";
import { vnDateKey } from "../../../ui/format.js";
import {
  duplicateLineKeys,
  lineIssues,
  markExtraBatches,
  parseCsvDate,
  receiptChecks,
  type DraftLine,
} from "./receipt-draft.js";

const day = (offset: number) => dayjs(vnDateKey()).add(offset, "day").format("YYYY-MM-DD");

function line(overrides: Partial<DraftLine> = {}): DraftLine {
  return {
    key: "a",
    productId: "p1",
    productCode: "TH1",
    productName: "Thuốc 1",
    unitId: "u1",
    fallbackUnit: { id: "u1", name: "Hộp", conversionToBase: 100 },
    quantity: 10,
    unitCost: 5000,
    batchNumber: "L01",
    manufactureDate: day(-200),
    expiryDate: day(500),
    extraBatch: false,
    ...overrides,
  };
}
const texts = (draft: DraftLine, duplicate = false) =>
  lineIssues(draft, duplicate).map((issue) => `${issue.level}: ${issue.text}`);

describe("phiếu nhập nháp", () => {
  it("dòng đủ thông tin hợp lệ thì không có lỗi", () => {
    expect(texts(line())).toEqual([]);
  });

  it("thiếu số lô, số lượng 0, hạn dùng đã qua là lỗi", () => {
    expect(texts(line({ batchNumber: " ", quantity: 0, expiryDate: day(0) }))).toEqual([
      "error: Thiếu số lô",
      "error: Số lượng phải lớn hơn 0",
      "error: Hạn dùng đã qua",
    ]);
  });

  it("hạn dùng gần, tuổi thọ ngắn bất thường, đơn giá 0 là cảnh báo", () => {
    expect(texts(line({ expiryDate: day(60), manufactureDate: day(-60) }))).toEqual([
      "warning: Hạn dùng chỉ còn 60 ngày",
      "warning: Tuổi thọ chỉ khoảng 4 tháng — đối chiếu lại NSX/HSD trên bao bì",
    ]);
    expect(texts(line({ unitCost: 0 }))).toEqual(["warning: Đơn giá bằng 0 (hàng tặng?)"]);
  });

  it("hạn dùng cách ngày sản xuất dưới 30 ngày là nhập nhầm", () => {
    expect(texts(line({ manufactureDate: day(480), expiryDate: day(500) }))).toContain(
      "error: Ngày sản xuất ở tương lai",
    );
    expect(texts(line({ manufactureDate: day(-10), expiryDate: day(10) }))).toContain(
      "error: Hạn dùng chỉ cách ngày sản xuất 20 ngày — gần như chắc chắn nhập nhầm",
    );
  });

  it("trùng sản phẩm, đơn vị và số lô (không phân biệt hoa thường)", () => {
    const lines = [
      line(),
      line({ key: "b", batchNumber: "l01 " }),
      line({ key: "c", unitId: "u2" }),
    ];
    expect([...duplicateLineKeys(lines)]).toEqual(["a", "b"]);
    expect(texts(lines[0]!, true)[0]).toBe("error: Trùng sản phẩm, đơn vị và số lô với dòng khác");
  });

  it("dòng cùng sản phẩm phía dưới là lô bổ sung", () => {
    const marked = markExtraBatches([
      line(),
      line({ key: "b", productId: "p2" }),
      line({ key: "c", extraBatch: false }),
    ]);
    expect(marked.map((item) => item.extraBatch)).toEqual([false, false, true]);
  });

  it("đọc ngày CSV dd/mm/yyyy hoặc yyyy-mm-dd", () => {
    expect(parseCsvDate("5/3/2027")).toBe("2027-03-05");
    expect(parseCsvDate(" 2027-03-05 ")).toBe("2027-03-05");
    expect(parseCsvDate("03-2027")).toBe("");
  });

  it("kiểm tra cả phiếu: chặn khi thiếu nhà cung cấp hoặc chiết khấu quá tiền hàng", () => {
    const supplier = { id: "s", name: "NCC", licenseNumber: null } as never;
    const base = {
      supplier,
      lines: [line()],
      issuesByLine: new Map([["a", []]]),
      receivedAt: day(0),
      supplierInvoiceDate: day(-40),
      goodsAmount: 50000,
      discountAmount: 60000,
    };
    expect(receiptChecks(base)).toEqual([
      { label: "Đã chọn nhà cung cấp", state: "ok" },
      { label: "1/1 dòng đủ số lô và hạn dùng", state: "ok" },
      { label: "Chiết khấu lớn hơn tổng tiền hàng", state: "error" },
      { label: "Ngày hóa đơn và ngày nhận lệch 40 ngày — kiểm tra lại", state: "warning" },
      { label: "Nhà cung cấp chưa lưu số giấy phép kinh doanh dược", state: "warning" },
    ]);
    expect(receiptChecks({ ...base, supplier: null, lines: [] }).slice(0, 2)).toEqual([
      { label: "Chưa chọn nhà cung cấp", state: "error" },
      { label: "Chưa có dòng hàng", state: "error" },
    ]);
  });
});
