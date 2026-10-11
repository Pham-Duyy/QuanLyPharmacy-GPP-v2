import { describe, expect, it } from "vitest";
import type { PrescriptionItem, ProductDetail } from "../../../api/types.js";
import {
  prescriptionCartLines,
  productsToFetch,
  remainingBase,
  remainingText,
} from "./prescription-cart.js";

function product(id: string, overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    id,
    code: id.toUpperCase(),
    name: `Thuốc ${id}`,
    productType: "DRUG",
    drugClass: "RX",
    category: { id: "c", name: "Thuốc" },
    minStockBaseQuantity: 0,
    isActive: true,
    version: 1,
    units: [
      { id: `${id}-vien`, name: "Viên", conversionToBase: 1 },
      { id: `${id}-vi`, name: "Vỉ", conversionToBase: 10 },
      { id: `${id}-hop`, name: "Hộp", conversionToBase: 100 },
    ],
    ingredients: [],
    stock: null,
    images: [],
    ...overrides,
  };
}

function item(overrides: Partial<PrescriptionItem>): PrescriptionItem {
  return {
    id: "rxi",
    lineNo: 1,
    productId: "amox",
    productCode: "AMOX",
    productName: "Amoxicillin 500",
    drugClass: "RX",
    drugNameText: "Amoxicillin 500mg",
    unitId: "amox-vi",
    unitName: "Vỉ",
    quantity: 2,
    baseQuantity: 20,
    dosageInstruction: null,
    dispensedBaseQuantity: 0,
    ...overrides,
  };
}

describe("lấy thuốc theo đơn vào giỏ hàng", () => {
  const products = new Map([
    ["amox", product("amox")],
    ["para", product("para")],
  ]);

  it("thêm đúng đơn vị và số lượng kê, gắn với dòng đơn", () => {
    const { lines, skipped } = prescriptionCartLines([item({ id: "a" })], products, new Set());
    expect(skipped).toEqual([]);
    expect(lines).toEqual([
      { product: products.get("amox"), unitId: "amox-vi", quantity: 2, prescriptionItemId: "a" },
    ]);
  });

  it("đã bán lẻ một phần không chia hết đơn vị kê thì đổi sang đơn vị nhỏ nhất", () => {
    const partial = item({ dispensedBaseQuantity: 5 });
    expect(remainingBase(partial)).toBe(15);
    expect(prescriptionCartLines([partial], products, new Set()).lines[0]).toMatchObject({
      unitId: "amox-vien",
      quantity: 15,
    });
    expect(remainingText(partial, "Viên")).toBe("15 Viên");
    expect(remainingText(item({ dispensedBaseQuantity: 10 }), "Viên")).toBe("1 Vỉ");
  });

  it("bỏ qua dòng đã bán đủ và thuốc đã có trong giỏ", () => {
    const items = [
      item({ id: "a", dispensedBaseQuantity: 20 }),
      item({ id: "b", productId: "para", unitId: "para-vien", quantity: 10, baseQuantity: 10 }),
    ];
    expect(prescriptionCartLines(items, products, new Set(["para"])).lines).toEqual([]);
    expect(productsToFetch(items, new Set(["para"]))).toEqual([]);
    expect(productsToFetch(items, new Set())).toEqual(["para"]);
  });

  it("thuốc chưa khớp, ngừng kinh doanh hoặc hết đơn vị bán được thì báo để thêm tay", () => {
    const stopped = new Map([["amox", product("amox", { isActive: false })]]);
    const noUnit = new Map([
      [
        "amox",
        product("amox", {
          units: [{ id: "amox-hop", name: "Hộp", conversionToBase: 100, isSellable: true }],
        }),
      ],
    ]);
    const unmatched = item({ productId: null, productName: null, drugNameText: "Thuốc lạ" });
    expect(prescriptionCartLines([unmatched], products, new Set()).skipped).toEqual(["Thuốc lạ"]);
    expect(prescriptionCartLines([item({})], stopped, new Set()).skipped).toEqual([
      "Amoxicillin 500",
    ]);
    expect(prescriptionCartLines([item({})], noUnit, new Set()).skipped).toEqual([
      "Amoxicillin 500",
    ]);
  });
});
