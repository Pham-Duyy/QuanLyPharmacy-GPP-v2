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

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let salesToken: string;
let categoryId: string;

function idem(): Record<string, string> {
  return { "Idempotency-Key": randomUUID() };
}

// Server ghi businessDate theo giờ Việt Nam (Asia/Ho_Chi_Minh), không phải
// ngày UTC — dùng cùng cách quy đổi ở đây, nếu không test sẽ chập chờn
// khoảng 17:00–23:59 UTC mỗi ngày (đã sang ngày mới ở VN vào lúc đó).
function dayOffset(days: number): Date {
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(
    new Date(),
  );
  const date = new Date(`${todayKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

async function makeProduct(code: string, name: string, price: number) {
  const product = await prisma.product.create({
    data: {
      code,
      name,
      productType: "DRUG",
      drugClass: "OTC",
      categoryId,
      units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  const unitId = product.units[0]!.id;
  // vatRatePercent = 0 để totalAmount khớp thẳng đơn giá * số lượng, dễ kiểm chứng.
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

async function makeBatch(
  productId: string,
  batchNumber: string,
  quantity: number,
  unitCost: number,
) {
  return prisma.batch.create({
    data: {
      storeId: fixture.storeId,
      productId,
      batchNumber,
      expiryDate: dayOffset(365),
      quantityOnHand: quantity,
      unitCost,
    },
  });
}

function sell(product: { id: string; unitId: string }, quantity: number, token = pharmacistToken) {
  return api()
    .post("/api/v1/invoices")
    .set({ ...authHeaders(token, fixture.storeId), ...idem() })
    .send({ lines: [{ productId: product.id, unitId: product.unitId, quantity }] })
    .expect(201);
}

function receiveReturn(invoiceId: string, body: Record<string, unknown>) {
  return api()
    .post(`/api/v1/invoices/${invoiceId}/returns`)
    .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
    .send(body)
    .expect(201);
}

function fetchReport(from: string, to: string, token = adminToken) {
  return api()
    .get("/api/v1/reports/summary")
    .query({ from, to })
    .set(authHeaders(token, fixture.storeId));
}

function todayStr(offset = 0): string {
  return dayOffset(offset).toISOString().slice(0, 10);
}

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
  pharmacistToken = (await login("duocsi")).token;
  salesToken = (await login("banhang")).token;
  categoryId = (await prisma.category.create({ data: { name: "Thuốc giảm đau" } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Doanh thu và lợi nhuận", () => {
  it("tính đúng doanh thu và lợi nhuận gộp khi không có trả hàng", async () => {
    const para = await makeProduct("TH0001", "Paracetamol 500mg", 10000);
    await makeBatch(para.id, "L1", 100, 5000);
    await sell(para, 10);

    const response = await fetchReport(todayStr(0), todayStr(1)).expect(200);

    expect(response.body.data.kpis.netRevenue).toBe(100_000);
    expect(response.body.data.kpis.grossProfit).toBe(50_000);
    expect(response.body.data.kpis.invoiceCount).toBe(1);
    expect(response.body.data.kpis.averageOrderValue).toBe(100_000);
  });

  it("trả hàng RESTOCK giảm cả doanh thu và giá vốn", async () => {
    const para = await makeProduct("TH0002", "Amoxicillin 500mg", 10000);
    await makeBatch(para.id, "L1", 100, 5000);
    const invoice = await sell(para, 10);
    await receiveReturn(invoice.body.data.id, {
      disposition: "RESTOCK",
      lines: [{ invoiceLineId: invoice.body.data.lines[0].id, unitId: para.unitId, quantity: 4 }],
    });

    const response = await fetchReport(todayStr(0), todayStr(1)).expect(200);

    // Doanh thu ròng: 100.000 - hoàn 40.000 = 60.000
    expect(response.body.data.kpis.netRevenue).toBe(60_000);
    // Giá vốn ròng: 50.000 - hoàn kho 4*5000=20.000 = 30.000 → lợi nhuận 60.000-30.000=30.000
    expect(response.body.data.kpis.grossProfit).toBe(30_000);
  });

  it("trả hàng DISPOSE giảm doanh thu nhưng không hoàn lại giá vốn", async () => {
    const para = await makeProduct("TH0003", "Vitamin C 1g", 10000);
    await makeBatch(para.id, "L1", 100, 5000);
    const invoice = await sell(para, 10);
    await receiveReturn(invoice.body.data.id, {
      reason: "Hàng ẩm mốc",
      disposition: "DISPOSE",
      lines: [{ invoiceLineId: invoice.body.data.lines[0].id, unitId: para.unitId, quantity: 3 }],
    });

    const response = await fetchReport(todayStr(0), todayStr(1)).expect(200);

    // Doanh thu ròng: 100.000 - hoàn 30.000 = 70.000; giá vốn vẫn nguyên 50.000
    expect(response.body.data.kpis.netRevenue).toBe(70_000);
    expect(response.body.data.kpis.grossProfit).toBe(20_000);
  });

  it("hóa đơn đã hủy không tính vào báo cáo", async () => {
    const para = await makeProduct("TH0004", "Cetirizin 10mg", 10000);
    await makeBatch(para.id, "L1", 100, 5000);
    const invoice = await sell(para, 10);
    await api()
      .post(`/api/v1/invoices/${invoice.body.data.id}/void`)
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send({ reason: "Bấm nhầm sản phẩm" })
      .expect(200);

    const response = await fetchReport(todayStr(0), todayStr(1)).expect(200);

    expect(response.body.data.kpis.netRevenue).toBe(0);
    expect(response.body.data.kpis.invoiceCount).toBe(0);
  });

  it("báo lỗi khi from không trước to", async () => {
    const response = await fetchReport(todayStr(1), todayStr(0)).expect(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("nhân viên bán hàng không có quyền report.sales", async () => {
    const response = await fetchReport(todayStr(0), todayStr(1), salesToken).expect(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});

describe("Chi tiết theo sản phẩm, nhóm hàng, thanh toán, nhân viên", () => {
  it("gộp đúng theo nhóm hàng, top sản phẩm và hình thức thanh toán", async () => {
    const otherCategoryId = (await prisma.category.create({ data: { name: "Vitamin" } })).id;
    const para = await makeProduct("TH0005", "Paracetamol 500mg", 10000);
    await makeBatch(para.id, "L1", 100, 5000);
    const vitaminProduct = await prisma.product.create({
      data: {
        code: "TH0006",
        name: "Vitamin D3",
        productType: "SUPPLEMENT",
        categoryId: otherCategoryId,
        units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
      },
      include: { units: true },
    });
    const vitaminUnitId = vitaminProduct.units[0]!.id;
    await prisma.productPrice.create({
      data: {
        productUnitId: vitaminUnitId,
        salePrice: 2000n,
        vatRatePercent: 0,
        effectiveFrom: dayOffset(-1),
      },
    });
    await makeBatch(vitaminProduct.id, "L1", 100, 1000);

    await sell(para, 5); // 50.000
    await sell({ id: vitaminProduct.id, unitId: vitaminUnitId }, 20); // 40.000

    const response = await fetchReport(todayStr(0), todayStr(1)).expect(200);

    expect(response.body.data.categoryBreakdown.length).toBeGreaterThanOrEqual(2);
    expect(response.body.data.topProducts[0].revenue).toBeGreaterThanOrEqual(
      response.body.data.topProducts[1].revenue,
    );
    expect(
      response.body.data.paymentMethods.find((item: { method: string }) => item.method === "CASH")
        ?.amount,
    ).toBe(90_000);
    expect(response.body.data.staffPerformance[0]).toMatchObject({ invoiceCount: 2 });
  });
});
