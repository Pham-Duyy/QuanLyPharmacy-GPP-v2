import { describe, expect, it } from "vitest";
import { canReceive, receiptLinesFromOrder, type PurchaseOrderDetail } from "./purchase-orders-api";

const line = (over: Partial<PurchaseOrderDetail["lines"][number]>) => ({
  id: "l",
  lineNo: 1,
  productId: "p",
  productCode: "TH1",
  productName: "Thuốc",
  unitId: "u",
  unitName: "Hộp",
  conversionToBase: 100,
  baseUnitName: "Viên",
  quantity: 2,
  baseQuantity: 200,
  unitPrice: 80_000,
  lineAmount: 160_000,
  receivedBaseQuantity: 0,
  remainingBaseQuantity: 200,
  remainingQuantity: 2,
  ...over,
});

describe("Phiếu nhập từ đơn đặt hàng", () => {
  it("chỉ lấy dòng còn thiếu, theo số còn thiếu", () => {
    const order = {
      lines: [
        line({ productId: "a", remainingBaseQuantity: 50, remainingQuantity: 1 }),
        line({ productId: "b", remainingBaseQuantity: 0, remainingQuantity: 0 }),
        line({ productId: "c", unitPrice: null }),
      ],
    } as PurchaseOrderDetail;
    expect(receiptLinesFromOrder(order)).toEqual([
      { productId: "a", unitName: "Hộp", quantity: 1, unitCost: 80_000 },
      { productId: "c", unitName: "Hộp", quantity: 2, unitCost: 0 },
    ]);
  });

  it("chỉ lập phiếu nhập từ đơn đã gửi, chưa nhận đủ", () => {
    expect(canReceive("SENT")).toBe(true);
    expect(canReceive("PARTIAL")).toBe(true);
    expect(canReceive("DRAFT")).toBe(false);
    expect(canReceive("RECEIVED")).toBe(false);
    expect(canReceive("CANCELLED")).toBe(false);
  });
});
