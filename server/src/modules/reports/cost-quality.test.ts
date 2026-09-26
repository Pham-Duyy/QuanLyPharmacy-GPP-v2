import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../../test/helpers.js";

/**
 * Chất lượng giá vốn của báo cáo phải tính trên **mọi phần tham gia công
 * thức lãi gộp**: giá vốn hàng bán trong kỳ và giá vốn hoàn của hàng trả
 * trong kỳ. Hàng trả có thể thuộc hóa đơn của kỳ trước, nên chỉ nhìn hóa đơn
 * bán trong kỳ là bỏ sót.
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

async function receive(quantity: number, unitCost: number, batchNumber: string): Promise<void> {
  const created = await api()
    .post("/api/v1/goods-receipts")
    .set({ ...h(pharmacistToken), ...idem() })
    .send({
      supplierId,
      lines: [{ productId, unitId, quantity, unitCost, batchNumber, expiryDate: dayKey(400) }],
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

const giveBack = (
  invoice: { id: string; lines: Array<{ id: string }> },
  quantity: number,
  disposition = "RESTOCK",
) =>
  api()
    .post(`/api/v1/invoices/${invoice.id}/returns`)
    .set({ ...h(pharmacistToken), ...idem() })
    .send({
      disposition,
      refundMethod: "CASH",
      ...(disposition === "DISPOSE" ? { reason: "Hàng hỏng, không bán lại" } : {}),
      lines: [{ invoiceLineId: invoice.lines[0]!.id, unitId, quantity }],
    });

/** Đẩy hóa đơn về kỳ trước (hai ngày trước). */
const moveToPreviousPeriod = (invoiceId: string) =>
  prisma.invoice.update({
    where: { id: invoiceId },
    data: { businessDate: new Date(`${dayKey(-2)}T00:00:00.000Z`) },
  });

/** Báo cáo của riêng ngày hôm nay (kỳ so sánh là ngày hôm qua). */
const todayReport = async () =>
  (
    await api()
      .get(`/api/v1/reports/summary?from=${dayKey()}&to=${dayKey(1)}`)
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
    data: {
      productUnitId: unitId,
      salePrice: 3000n,
      vatRatePercent: 5,
      effectiveFrom: new Date(`${dayKey(-5)}T00:00:00.000Z`),
    },
  });
  supplierId = (await prisma.supplier.create({ data: { name: "Dược Minh Tâm" } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Chất lượng giá vốn tính cả phần hoàn của hàng trả", () => {
  it("bán kỳ trước với giá vốn UNKNOWN, trả kỳ này: báo cáo không được đánh dấu chính xác", async () => {
    await receive(100, 1000, "L1");
    const sale = (await sell(10).expect(201)).body.data;
    await moveToPreviousPeriod(sale.id);
    await prisma.invoiceAllocation.updateMany({ data: { unitCost: null, unitCostSource: "UNKNOWN" } });

    await giveBack(sale, 2).expect(201);

    const data = await todayReport();
    expect(data.costQuality).toMatchObject({
      saleLines: 0,
      returnLines: 1,
      totalLines: 1,
      unknownReturnLines: 1,
      unknownSaleLines: 0,
      exact: false,
    });
  });

  it("bán kỳ trước với giá vốn ESTIMATED, trả kỳ này: cũng không được đánh dấu chính xác", async () => {
    await receive(100, 1000, "L1");
    const sale = (await sell(10).expect(201)).body.data;
    await moveToPreviousPeriod(sale.id);
    await prisma.invoiceAllocation.updateMany({ data: { unitCostSource: "ESTIMATED" } });

    await giveBack(sale, 2).expect(201);

    const data = await todayReport();
    expect(data.costQuality).toMatchObject({
      returnLines: 1,
      estimatedLines: 1,
      unknownLines: 0,
      exact: false,
    });
  });

  it("giá vốn ACTUAL đầy đủ ở cả hai phần thì được đánh dấu chính xác", async () => {
    await receive(100, 1000, "L1");
    const sale = (await sell(10).expect(201)).body.data;
    await giveBack(sale, 2).expect(201);

    const data = await todayReport();
    expect(data.costQuality).toMatchObject({
      saleLines: 1,
      returnLines: 1,
      totalLines: 2,
      actualLines: 2,
      estimatedLines: 0,
      unknownLines: 0,
      exact: true,
      comparisonExact: true,
    });
  });

  it("kỳ chỉ có hàng trả, không có bán mới", async () => {
    await receive(100, 1000, "L1");
    const sale = (await sell(10).expect(201)).body.data;
    await moveToPreviousPeriod(sale.id);

    await giveBack(sale, 3).expect(201);

    const data = await todayReport();
    expect(data.costQuality).toMatchObject({ saleLines: 0, returnLines: 1, actualLines: 1, exact: true });
    // Kỳ so sánh (hôm qua) có hóa đơn bán, giá vốn thật nên vẫn so sánh được.
    expect(data.costQuality.comparisonExact).toBe(true);
  });

  it("trả nhiều lần trên cùng một phân bổ thì đếm theo từng lần trả", async () => {
    await receive(100, 1000, "L1");
    const sale = (await sell(10).expect(201)).body.data;
    await giveBack(sale, 2).expect(201);
    await giveBack(sale, 3).expect(201);

    const data = await todayReport();
    expect(data.costQuality).toMatchObject({ saleLines: 1, returnLines: 2, totalLines: 3, actualLines: 3 });
  });

  it("hàng trả để tiêu hủy không vào phần hoàn giá vốn", async () => {
    await receive(100, 1000, "L1");
    const sale = (await sell(10).expect(201)).body.data;
    await prisma.invoiceAllocation.updateMany({ data: { unitCost: null, unitCostSource: "UNKNOWN" } });
    await giveBack(sale, 2, "DISPOSE").expect(201);

    const data = await todayReport();
    // Công thức không hoàn giá vốn cho hàng tiêu hủy nên dòng đó không được đếm.
    expect(data.costQuality.returnLines).toBe(0);
    expect(data.costQuality.saleLines).toBe(1);
    expect(data.costQuality.unknownSaleLines).toBe(1);
  });

  it("kỳ hiện tại đủ giá vốn nhưng kỳ so sánh thiếu thì không so sánh được", async () => {
    // Hóa đơn của kỳ so sánh (hôm qua) mất giá vốn.
    await receive(100, 1000, "L1");
    const old = (await sell(5).expect(201)).body.data;
    await prisma.invoice.update({
      where: { id: old.id },
      data: { businessDate: new Date(`${dayKey(-1)}T00:00:00.000Z`) },
    });
    await prisma.invoiceAllocation.updateMany({ data: { unitCost: null, unitCostSource: "UNKNOWN" } });

    // Hóa đơn của kỳ này có giá vốn đầy đủ.
    await sell(4).expect(201);

    const data = await todayReport();
    expect(data.costQuality.exact).toBe(true);
    expect(data.costQuality.comparisonExact).toBe(false);
  });
});
