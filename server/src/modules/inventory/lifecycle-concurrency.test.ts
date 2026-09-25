import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../../test/helpers.js";

/**
 * Vòng đời kiểm kê, thanh toán công nợ và phiếu trả nhà cung cấp khi có hai
 * người thao tác cùng lúc.
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

/** Nhập và kiểm nhập một phiếu, trả về id phiếu nhập. */
async function receive(quantity: number, unitCost: number, batchNumber: string): Promise<string> {
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

  return created.body.data.id as string;
}

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
  supplierId = (await prisma.supplier.create({ data: { name: "Dược Minh Tâm" } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe("Vòng đời đợt kiểm kê", () => {
  async function openWithOneCount(): Promise<{ countId: string; lineId: string }> {
    await receive(100, 1000, "L1");
    const opened = await api().post("/api/v1/stock-counts").set(h(pharmacistToken)).send({ scopeType: "ALL" }).expect(201);
    const countId = opened.body.data.count.id as string;
    const lineId = opened.body.data.lines[0].id as string;

    const saved = await api()
      .patch(`/api/v1/stock-counts/${countId}/counts`)
      .set(h(pharmacistToken))
      .send({ entries: [{ lineId, unitId, quantity: 95 }] });
    expect(saved.status).toBe(200);

    return { countId, lineId };
  }

  it("hai lệnh chốt cùng lúc chỉ sinh một phiếu điều chỉnh", async () => {
    const { countId } = await openWithOneCount();

    const results = await Promise.allSettled([
      api().post(`/api/v1/stock-counts/${countId}/close`).set(h(pharmacistToken)).send({}),
      api().post(`/api/v1/stock-counts/${countId}/close`).set(h(pharmacistToken)).send({}),
    ]);
    const ok = results.filter((item) => item.status === "fulfilled" && item.value.status === 200);
    expect(ok).toHaveLength(1);

    expect(await prisma.stockAdjustment.count()).toBe(1);
    const saved = await prisma.stockCount.findUniqueOrThrow({ where: { id: countId } });
    expect(saved.status).toBe("CLOSED");
    expect(saved.adjustmentId).not.toBeNull();
  });

  it("chốt và hủy cùng lúc chỉ một lệnh thắng, không để lại phiếu điều chỉnh mồ côi", async () => {
    const { countId } = await openWithOneCount();

    const results = await Promise.allSettled([
      api().post(`/api/v1/stock-counts/${countId}/close`).set(h(pharmacistToken)).send({}),
      api().post(`/api/v1/stock-counts/${countId}/cancel`).set(h(pharmacistToken)).send({ reason: "Đếm lại từ đầu" }),
    ]);
    const ok = results.filter((item) => item.status === "fulfilled" && item.value.status === 200);
    expect(ok).toHaveLength(1);

    const saved = await prisma.stockCount.findUniqueOrThrow({ where: { id: countId } });
    const adjustments = await prisma.stockAdjustment.count();
    if (saved.status === "CLOSED") {
      expect(adjustments).toBe(1);
    } else {
      expect(saved.status).toBe("CANCELLED");
      expect(adjustments).toBe(0);
    }
  });

  it("đợt đã chốt thì không ghi thêm số đếm được", async () => {
    const { countId, lineId } = await openWithOneCount();
    await api().post(`/api/v1/stock-counts/${countId}/close`).set(h(pharmacistToken)).send({}).expect(200);

    const late = await api()
      .patch(`/api/v1/stock-counts/${countId}/counts`)
      .set(h(pharmacistToken))
      .send({ entries: [{ lineId, unitId, quantity: 50 }] })
      .expect(409);
    expect(late.body.error.message).toContain("đã chốt");

    const line = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(line.countedBaseQuantity).toBe(95);
  });
});

describe("Thanh toán công nợ nhà cung cấp", () => {
  it("hai lần trả cùng lúc không trả vượt số còn nợ", async () => {
    const receiptId = await receive(100, 1000, "L1"); // nợ 100.000đ

    const pay = () =>
      api()
        .post("/api/v1/supplier-payments")
        .set(h())
        .send({ supplierId, method: "CASH", allocations: [{ goodsReceiptId: receiptId, amount: 100_000 }] });

    const results = await Promise.allSettled([pay(), pay()]);
    const ok = results.filter((item) => item.status === "fulfilled" && item.value.status === 201);
    expect(ok).toHaveLength(1);

    const paid = await prisma.supplierPaymentAllocation.aggregate({ _sum: { amount: true } });
    expect(Number(paid._sum.amount ?? 0n)).toBe(100_000);
  });

  it("một phiếu nhập không được phân bổ hai dòng trong cùng phiếu chi", async () => {
    const receiptId = await receive(100, 1000, "L1");

    const bad = await api()
      .post("/api/v1/supplier-payments")
      .set(h())
      .send({
        supplierId,
        method: "CASH",
        allocations: [
          { goodsReceiptId: receiptId, amount: 60_000 },
          { goodsReceiptId: receiptId, amount: 60_000 },
        ],
      })
      .expect(422);
    expect(bad.body.error.message).toContain("một dòng");
    expect(await prisma.supplierPayment.count()).toBe(0);
  });

  it("hủy phiếu chi hai lần chỉ ghi nhận một lần", async () => {
    const receiptId = await receive(100, 1000, "L1");
    const payment = await api()
      .post("/api/v1/supplier-payments")
      .set(h())
      .send({ supplierId, method: "CASH", allocations: [{ goodsReceiptId: receiptId, amount: 40_000 }] })
      .expect(201);

    const results = await Promise.allSettled([
      api().post(`/api/v1/supplier-payments/${payment.body.data.id}/void`).set(h()).send({ reason: "Chuyển nhầm" }),
      api().post(`/api/v1/supplier-payments/${payment.body.data.id}/void`).set(h()).send({ reason: "Chuyển nhầm" }),
    ]);
    const ok = results.filter((item) => item.status === "fulfilled" && item.value.status === 200);
    expect(ok).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: "SUPPLIER_PAYMENT_VOID" } })).toBe(1);
  });
});

describe("Phiếu trả hàng nhà cung cấp", () => {
  it("xác nhận và hủy cùng lúc: phiếu đã trừ tồn không thể bị chuyển thành hủy", async () => {
    await receive(100, 1000, "L1");
    const batch = await prisma.batch.findFirstOrThrow({ where: { batchNumber: "L1" } });

    const draft = await api()
      .post("/api/v1/supplier-returns")
      .set(h(pharmacistToken))
      .send({
        supplierId,
        reason: "Hàng cận hạn, nhà cung cấp nhận lại",
        settlement: "DEDUCT_DEBT",
        lines: [{ batchId: batch.id, unitId, quantity: 20 }],
      })
      .expect(201);
    const returnId = draft.body.data.id as string;

    const results = await Promise.allSettled([
      api().post(`/api/v1/supplier-returns/${returnId}/confirm`).set({ ...h(pharmacistToken), ...idem() }).send({}),
      api().post(`/api/v1/supplier-returns/${returnId}/cancel`).set(h(pharmacistToken)).send({ reason: "Bỏ phiếu" }),
    ]);
    const ok = results.filter((item) => item.status === "fulfilled" && item.value.status === 200);
    expect(ok).toHaveLength(1);

    const saved = await prisma.supplierReturn.findUniqueOrThrow({ where: { id: returnId } });
    const after = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });

    if (saved.status === "CONFIRMED") {
      expect(after.quantityOnHand).toBe(80);
    } else {
      expect(saved.status).toBe("CANCELLED");
      // Phiếu bị hủy thì tuyệt đối không được trừ tồn.
      expect(after.quantityOnHand).toBe(100);
    }
  });
});
