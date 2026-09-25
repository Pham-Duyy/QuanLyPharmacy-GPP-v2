import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../../test/helpers.js";

/**
 * Giá vốn: nhập thêm cùng một lô với giá khác thì lô tính lại **bình quân
 * gia quyền**, còn hóa đơn đã bán giữ nguyên giá vốn tại thời điểm xuất.
 */

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let productId: string;
let unitId: string;
let supplierId: string;

const h = (token = adminToken) => authHeaders(token, fixture.storeId);
const idem = () => ({ "Idempotency-Key": randomUUID() });

function dayKey(days = 0): string {
  const vnToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  const date = new Date(`${vnToday}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Nhập một phiếu và kiểm nhập luôn, trả về id phiếu. */
async function receive(options: {
  quantity: number;
  unitCost: number;
  batchNumber: string;
  discountAmount?: number;
  vatAmount?: number;
}): Promise<void> {
  const created = await api()
    .post("/api/v1/goods-receipts")
    .set({ ...h(pharmacistToken), ...idem() })
    .send({
      supplierId,
      discountAmount: options.discountAmount ?? 0,
      vatAmount: options.vatAmount ?? 0,
      lines: [
        {
          productId,
          unitId,
          quantity: options.quantity,
          unitCost: options.unitCost,
          batchNumber: options.batchNumber,
          expiryDate: dayKey(400),
        },
      ],
    })
    .expect(201);

  await api()
    .post(`/api/v1/goods-receipts/${created.body.data.id}/confirm`)
    .set({ ...h(pharmacistToken), ...idem() })
    .send({ lines: created.body.data.lines.map((line: { id: string }) => ({ lineId: line.id, passed: true })) })
    .expect(200);
}

const sell = (quantity: number) =>
  api()
    .post("/api/v1/invoices")
    .set({ ...h(), ...idem() })
    .send({ lines: [{ productId, unitId, quantity }] });

const costOf = async (batchNumber: string) =>
  Number((await prisma.batch.findFirstOrThrow({ where: { batchNumber } })).unitCost);

const report = async () =>
  (
    await api()
      .get(`/api/v1/reports/summary?from=${dayKey(-1)}&to=${dayKey(1)}`)
      .set(h())
      .expect(200)
  ).body.data;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [adminToken, pharmacistToken] = await Promise.all([
    login("admin").then((item) => item.token),
    login("duocsi").then((item) => item.token),
  ]);
  const categoryId = (await prisma.category.create({ data: { name: "Hàng nhà thuốc" } })).id;
  const product = await prisma.product.create({
    data: {
      code: "TH0001",
      name: "Paracetamol 500mg",
      productType: "DRUG",
      drugClass: "OTC",
      categoryId,
      units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  productId = product.id;
  unitId = product.units[0]!.id;
  await prisma.productPrice.create({
    data: { productUnitId: unitId, salePrice: 3000n, vatRatePercent: 5, effectiveFrom: new Date(`${dayKey(-2)}T00:00:00.000Z`) },
  });
  supplierId = (await prisma.supplier.create({ data: { name: "Dược Minh Tâm" } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Nhập thêm vào lô đã có", () => {
  it("giá vốn lô tính lại theo bình quân gia quyền", async () => {
    await receive({ quantity: 100, unitCost: 1000, batchNumber: "L1" });
    expect(await costOf("L1")).toBeCloseTo(1000, 4);

    await sell(10).expect(201);

    // Còn 90 viên giá 1.000, nhập thêm 100 viên giá 2.000.
    await receive({ quantity: 100, unitCost: 2000, batchNumber: "L1" });
    expect(await costOf("L1")).toBeCloseTo((90 * 1000 + 100 * 2000) / 190, 3);
  });

  it("chiết khấu và thuế của phiếu vẫn phân bổ vào giá vốn khi nhập thêm", async () => {
    await receive({ quantity: 100, unitCost: 1000, batchNumber: "L2" });
    // 100 viên × 1.000 = 100.000, chiết khấu 20.000 → giá vốn đợt này 800/viên.
    await receive({ quantity: 100, unitCost: 1000, batchNumber: "L2", discountAmount: 20_000 });

    expect(await costOf("L2")).toBeCloseTo((100 * 1000 + 100 * 800) / 200, 3);
  });

  it("nhập lại vào lô đã bán hết thì lấy luôn giá của đợt mới", async () => {
    await receive({ quantity: 10, unitCost: 1000, batchNumber: "L3" });
    await sell(10).expect(201);
    await receive({ quantity: 10, unitCost: 3000, batchNumber: "L3" });

    expect(await costOf("L3")).toBeCloseTo(3000, 4);
  });
});

describe("Giá vốn của hóa đơn đã bán", () => {
  it("không đổi khi giá vốn của lô thay đổi về sau", async () => {
    await receive({ quantity: 100, unitCost: 1000, batchNumber: "L1" });
    await sell(10).expect(201);

    const allocation = await prisma.invoiceAllocation.findFirstOrThrow();
    expect(Number(allocation.unitCost)).toBeCloseTo(1000, 4);

    const before = (await report()).kpis;
    // Doanh thu 30.000, giá vốn 10.000.
    expect(before.netRevenue).toBe(30_000);
    expect(Math.round(before.grossProfit)).toBe(20_000);

    // Nhập thêm cùng lô với giá gấp ba: lãi gộp của lần bán cũ phải giữ nguyên.
    await receive({ quantity: 100, unitCost: 3000, batchNumber: "L1" });

    const after = (await report()).kpis;
    expect(Math.round(after.grossProfit)).toBe(20_000);
  });

  it("hàng khách trả được trừ theo đúng giá vốn của lần bán gốc", async () => {
    await receive({ quantity: 100, unitCost: 1000, batchNumber: "L1" });
    const sale = await sell(10).expect(201);
    await receive({ quantity: 100, unitCost: 3000, batchNumber: "L1" });

    await api()
      .post(`/api/v1/invoices/${sale.body.data.id}/returns`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({
        disposition: "RESTOCK",
        refundMethod: "CASH",
        lines: [{ invoiceLineId: sale.body.data.lines[0].id, unitId, quantity: 4 }],
      })
      .expect(201);

    // Còn lại 6 viên đã bán: doanh thu 18.000, giá vốn 6.000.
    const kpis = (await report()).kpis;
    expect(kpis.netRevenue).toBe(18_000);
    expect(Math.round(kpis.grossProfit)).toBe(12_000);
  });
});
