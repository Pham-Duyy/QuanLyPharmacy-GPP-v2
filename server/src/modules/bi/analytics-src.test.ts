import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  type Fixture,
} from "../../test/helpers.js";

/**
 * View nguồn dữ liệu cho analytics-service (Phase 5, bước 5.5; migration
 * 20261031150000_analytics_source_views). Dữ liệu tạo qua đúng luồng nghiệp vụ: bán, giảm giá,
 * trả hàng, hủy hóa đơn; rồi đọc view như analytics-service sẽ đọc.
 */

let fixture: Fixture;
let token: string;
let categoryId: string;

const idem = () => ({ "Idempotency-Key": randomUUID() });

function dayOffset(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return new Date(date.toISOString().slice(0, 10));
}

async function makeProduct(code: string, drugClass: string, price: number, minStock = 0) {
  const product = await prisma.product.create({
    data: {
      code,
      name: `Thuốc ${code}`,
      productType: "DRUG",
      drugClass,
      categoryId,
      minStockBaseQuantity: minStock,
      units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  const unitId = product.units[0]!.id;
  await prisma.productPrice.create({
    data: {
      productUnitId: unitId,
      salePrice: BigInt(price),
      vatRatePercent: 0,
      effectiveFrom: dayOffset(-1),
    },
  });
  return { id: product.id, unitId };
}

async function sell(product: { id: string; unitId: string }, quantity: number, extra = {}) {
  const response = await api()
    .post("/api/v1/invoices")
    .set({ ...authHeaders(token, fixture.storeId), ...idem() })
    .send({ lines: [{ productId: product.id, unitId: product.unitId, quantity }], ...extra })
    .expect(201);
  return response.body.data;
}

type SaleRow = {
  sale_id: string;
  line_no: number;
  sale_type: string;
  store_code: string;
  medicine_code: string;
  batch_code: string | null;
  quantity: number;
  selling_price: string;
  purchase_price: string | null;
  payment_method: string;
};

const salesView = () =>
  prisma.$queryRaw<SaleRow[]>`SELECT * FROM analytics_src.sales ORDER BY sale_id`;
const marker = async () =>
  (
    await prisma.$queryRaw<Array<Record<string, string>>>`SELECT * FROM analytics_src.change_marker`
  )[0]!;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  token = (await login("duocsi")).token;
  categoryId = (await prisma.category.create({ data: { name: "Giảm đau" } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("analytics_src: nguồn dữ liệu PostgreSQL cho analytics-service", () => {
  it("bán hàng: bỏ hóa đơn hủy, trừ phần khách trả, giá đã chia giảm giá, giá vốn theo lô đã xuất", async () => {
    const para = await makeProduct("TH0001", "OTC", 1_000);
    await prisma.batch.create({
      data: {
        storeId: fixture.storeId,
        productId: para.id,
        batchNumber: "L1",
        expiryDate: dayOffset(365),
        quantityOnHand: 100,
        unitCost: 600,
      },
    });

    const plain = await sell(para, 10);
    const discounted = await sell(para, 5, {
      discount: { type: "PERCENT", value: 10, reason: "Khách quen" },
    });
    const voided = await sell(para, 3);
    await api()
      .post(`/api/v1/invoices/${voided.id}/void`)
      .set({ ...authHeaders(token, fixture.storeId), ...idem() })
      .send({ reason: "Khách đổi ý" })
      .expect(200);
    const returned = await sell(para, 10);
    await api()
      .post(`/api/v1/invoices/${returned.id}/returns`)
      .set({ ...authHeaders(token, fixture.storeId), ...idem() })
      .send({
        disposition: "RESTOCK",
        lines: [{ invoiceLineId: returned.lines[0].id, unitId: para.unitId, quantity: 4 }],
      })
      .expect(201);

    const rows = await salesView();
    const byCode = new Map(rows.map((row) => [row.sale_id, row]));
    expect(rows).toHaveLength(3);
    expect(byCode.has(voided.code)).toBe(false);
    expect(byCode.get(plain.code)).toMatchObject({
      line_no: 1,
      sale_type: "retail",
      store_code: "NT01",
      medicine_code: "TH0001",
      batch_code: "L1",
      quantity: 10,
      payment_method: "cash",
    });
    expect(Number(byCode.get(plain.code)!.selling_price)).toBe(1_000);
    expect(Number(byCode.get(plain.code)!.purchase_price)).toBe(600);
    // Giảm 10% cả hóa đơn: giá một viên tính vào doanh thu là 900.
    expect(Number(byCode.get(discounted.code)!.selling_price)).toBe(900);
    // Bán 10, khách trả 4: còn 6.
    expect(byCode.get(returned.code)!.quantity).toBe(6);
  });

  it("danh mục, tồn kho: đơn vị nhỏ nhất, thuốc kê đơn, chỉ lô đang bán được và còn hàng", async () => {
    const para = await makeProduct("TH0001", "OTC", 1_000, 50);
    const amox = await makeProduct("TH0002", "RX", 3_000);
    const lot = (
      productId: string,
      batchNumber: string,
      quantityOnHand: number,
      status = "AVAILABLE",
    ) =>
      prisma.batch.create({
        data: {
          storeId: fixture.storeId,
          productId,
          batchNumber,
          expiryDate: dayOffset(200),
          quantityOnHand,
          unitCost: 500,
          status,
        },
      });
    await lot(para.id, "L1", 40);
    await lot(para.id, "L0", 0); // hết hàng: không có trong view
    await lot(amox.id, "Q1", 30, "QUARANTINED"); // biệt trữ: không bán được

    const medicines = await prisma.$queryRaw<
      Array<{
        medicine_code: string;
        unit: string;
        is_prescription: string;
        min_stock: number | null;
      }>
    >`SELECT medicine_code, unit, is_prescription, min_stock FROM analytics_src.medicines ORDER BY 1`;
    expect(medicines).toEqual([
      { medicine_code: "TH0001", unit: "Viên", is_prescription: "N", min_stock: 50 },
      { medicine_code: "TH0002", unit: "Viên", is_prescription: "Y", min_stock: null },
    ]);

    const inventory = await prisma.$queryRaw<
      Array<{
        store_code: string;
        medicine_code: string;
        batch_code: string;
        quantity: number;
        purchase_price: string;
      }>
    >`SELECT store_code, medicine_code, batch_code, quantity, purchase_price FROM analytics_src.inventory`;
    expect(
      inventory.map((row) => ({ ...row, purchase_price: Number(row.purchase_price) })),
    ).toEqual([
      {
        store_code: "NT01",
        medicine_code: "TH0001",
        batch_code: "L1",
        quantity: 40,
        purchase_price: 500,
      },
    ]);
  });

  it("mốc thay đổi: bán thêm thì mốc bán hàng và tồn kho đổi, mốc danh mục giữ nguyên", async () => {
    const para = await makeProduct("TH0001", "OTC", 1_000);
    await prisma.batch.create({
      data: {
        storeId: fixture.storeId,
        productId: para.id,
        batchNumber: "L1",
        expiryDate: dayOffset(365),
        quantityOnHand: 100,
      },
    });
    const before = await marker();
    await sell(para, 2);
    const after = await marker();
    expect(after["sales"]).not.toBe(before["sales"]);
    expect(after["inventory"]).not.toBe(before["inventory"]);
    expect(after["medicines"]).toBe(before["medicines"]);
  });
});
