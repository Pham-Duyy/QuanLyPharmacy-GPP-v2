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

describe("Independent review regressions", () => {
  it("out-of-range product page preserves total", async () => {
    const response = await api().get("/api/v1/products?page=2&limit=20").set(h()).expect(200);
    expect(response.body.data.items).toHaveLength(0);
    expect(response.body.data.pagination.total).toBe(1);
  });

  it("restock revalues remaining inventory using original sale cost", async () => {
    await receive({ quantity: 100, unitCost: 1000, batchNumber: "AUDIT" });
    const sale = await sell(10).expect(201);
    await receive({ quantity: 100, unitCost: 3000, batchNumber: "AUDIT" });
    await api().post(`/api/v1/invoices/${sale.body.data.id}/returns`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({ disposition: "RESTOCK", refundMethod: "CASH", lines: [{ invoiceLineId: sale.body.data.lines[0].id, unitId, quantity: 4 }] })
      .expect(201);
    expect(await costOf("AUDIT")).toBeCloseTo((90 * 1000 + 100 * 3000 + 4 * 1000) / 194, 3);
  });

  it("legacy allocation profit stays stable after new receipt", async () => {
    await receive({ quantity: 100, unitCost: 1000, batchNumber: "LEGACY" });
    await sell(10).expect(201);
    await prisma.invoiceAllocation.updateMany({ data: { unitCost: null } });
    const before = (await report()).kpis.grossProfit;
    await receive({ quantity: 100, unitCost: 3000, batchNumber: "LEGACY" });
    expect((await report()).kpis.grossProfit).toBeCloseTo(before, 3);
  });
});

it("concurrent receipts preserve weighted inventory value", async () => {
  await receive({ quantity: 100, unitCost: 1000, batchNumber: "RACE" });
  async function draft(cost: number) {
    const response = await api().post("/api/v1/goods-receipts")
      .set({ ...h(pharmacistToken), ...idem() })
      .send({ supplierId, lines: [{ productId, unitId, quantity: 100, unitCost: cost, batchNumber: "RACE", expiryDate: dayKey(400) }] }).expect(201);
    return response.body.data;
  }
  const drafts = [await draft(2000), await draft(4000)];
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { locked = resolve; });
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM batches WHERE batch_number = 'RACE' FOR UPDATE`;
    locked();
    await gate;
  }, { timeout: 15000 });
  await ready;
  const pending = Promise.all(drafts.map((item) => api()
    .post(`/api/v1/goods-receipts/${item.id}/confirm`)
    .set({ ...h(pharmacistToken), ...idem() })
    .send({ lines: item.lines.map((line: { id: string }) => ({ lineId: line.id, passed: true })) })
    .then((result) => result)));
  let waiters = 0;
  try {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%UPDATE%batches%'`;
      waiters = rows[0]?.n ?? 0;
      if (waiters >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    release();
    await holder;
  }
  const responses = await pending;
  expect(waiters).toBe(2);
  expect(responses.map((result) => result.status)).toEqual([200, 200]);
  expect(await costOf("RACE")).toBeCloseTo((100 * 1000 + 100 * 2000 + 100 * 4000) / 300, 3);
});
