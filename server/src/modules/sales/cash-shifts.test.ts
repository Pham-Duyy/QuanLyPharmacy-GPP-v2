import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  useTestRole,
  type Fixture,
} from "../../test/helpers.js";

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let product: { id: string; unitId: string };

const idem = () => ({ "Idempotency-Key": randomUUID() });
const h = (token = pharmacistToken, storeId = fixture.storeId) => authHeaders(token, storeId);

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [adminToken, pharmacistToken] = await Promise.all([
    login("admin").then((item) => item.token),
    login("duocsi").then((item) => item.token),
  ]);
  const category = await prisma.category.create({ data: { name: "Thuốc giảm đau" } });
  const created = await prisma.product.create({
    data: {
      code: "TH0001",
      name: "Paracetamol 500mg",
      productType: "DRUG",
      drugClass: "OTC",
      categoryId: category.id,
      units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  product = { id: created.id, unitId: created.units[0]!.id };
  await prisma.productPrice.create({
    data: {
      productUnitId: product.unitId,
      salePrice: 10_000n,
      vatRatePercent: 0,
      effectiveFrom: new Date("2026-01-01"),
    },
  });
  await prisma.batch.create({
    data: {
      storeId: fixture.storeId,
      productId: product.id,
      batchNumber: "L1",
      expiryDate: new Date("2028-12-31"),
      quantityOnHand: 100,
      unitCost: 6000,
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function sell(quantity: number, method: "CASH" | "BANK_TRANSFER" = "CASH") {
  const response = await api()
    .post("/api/v1/invoices")
    .set({ ...h(), ...idem() })
    .send({
      lines: [{ productId: product.id, unitId: product.unitId, quantity }],
      payment: { method },
    })
    .expect(201);
  return response.body.data as { id: string; lines: Array<{ id: string }> };
}

const openShift = (openingCash: number, token = pharmacistToken, storeId = fixture.storeId) =>
  api()
    .post("/api/v1/cash-shifts")
    .set({ ...h(token, storeId), ...idem() })
    .send({ openingCash });

describe("Ca thu ngân", () => {
  it("tính tiền mặt dự kiến từ bán, hủy, trả hàng, thu chi; lệch tiền phải ghi lý do", async () => {
    const shift = (await openShift(200_000).expect(201)).body.data;
    expect(shift).toMatchObject({
      status: "OPEN",
      totals: { openingCash: 200_000, expectedCash: 200_000 },
    });

    const cash = await sell(3); // 30.000 tiền mặt
    await sell(2, "BANK_TRANSFER"); // 20.000 chuyển khoản, không vào két
    const voided = await sell(1); // 10.000 rồi hủy: trả lại tiền khách
    await api()
      .post(`/api/v1/invoices/${voided.id}/void`)
      .set({ ...h(), ...idem() })
      .send({ reason: "Khách đổi ý" })
      .expect(200);
    await api()
      .post(`/api/v1/invoices/${cash.id}/returns`)
      .set({ ...h(), ...idem() })
      .send({
        disposition: "DISPOSE",
        refundMethod: "CASH",
        reason: "Vỉ thuốc bị móp",
        lines: [{ invoiceLineId: cash.lines[0]!.id, unitId: product.unitId, quantity: 1 }],
      })
      .expect(201);
    for (const move of [
      { direction: "IN", amount: 50_000, reason: "Chủ đưa thêm tiền lẻ" },
      { direction: "OUT", amount: 5_000, reason: "Mua nước uống" },
    ]) {
      await api()
        .post(`/api/v1/cash-shifts/${shift.id}/movements`)
        .set({ ...h(), ...idem() })
        .send(move)
        .expect(200);
    }

    const current = (await api().get("/api/v1/cash-shifts/current").set(h()).expect(200)).body.data;
    // 200 + (30 + 10) − 10 (hủy) − 10 (trả hàng) + 50 − 5
    expect(current.shift.totals).toEqual({
      openingCash: 200_000,
      cashSales: 40_000,
      cashVoided: 10_000,
      cashRefunds: 10_000,
      cashIn: 50_000,
      cashOut: 5_000,
      expectedCash: 265_000,
      invoiceCount: 2,
      salesByMethod: { CASH: 30_000, BANK_TRANSFER: 20_000, CARD: 0 },
      voidedCount: 1,
      refundCount: 1,
    });

    const close = (body: Record<string, unknown>) =>
      api()
        .post(`/api/v1/cash-shifts/${shift.id}/close`)
        .set({ ...h(), ...idem() })
        .send(body);
    const missingNote = await close({ countedCash: 260_000 }).expect(422);
    expect(missingNote.body.error.message).toMatch(/ghi lý do/);
    const closed = (await close({ countedCash: 260_000, note: "Thối nhầm cho khách" }).expect(200))
      .body.data;
    expect(closed).toMatchObject({
      status: "CLOSED",
      countedCash: 260_000,
      difference: -5_000,
      closeNote: "Thối nhầm cho khách",
      totals: { expectedCash: 265_000 },
    });

    // Ca đã chốt: không ghi thêm, số liệu giữ nguyên dù về sau có bán thêm.
    await api()
      .post(`/api/v1/cash-shifts/${shift.id}/movements`)
      .set({ ...h(), ...idem() })
      .send({ direction: "OUT", amount: 1_000, reason: "Thử" })
      .expect(409);
    await sell(1);
    const snapshot = (await api().get(`/api/v1/cash-shifts/${shift.id}`).set(h()).expect(200)).body
      .data;
    expect(snapshot.totals.expectedCash).toBe(265_000);
    expect(await prisma.auditLog.count({ where: { resourceId: shift.id } })).toBe(4);

    const printed = await api()
      .get(`/api/v1/cash-shifts/${shift.id}/print`)
      .query({ autoprint: 0 })
      .set(h())
      .expect(200);
    expect(printed.text).toContain("PHIẾU CHỐT CA");
    expect(printed.text).toContain(shift.code);
  });

  it("mỗi cửa hàng chỉ một ca mở; ca của cửa hàng này không lộ sang cửa hàng khác", async () => {
    const shift = (await openShift(100_000).expect(201)).body.data;
    const again = await openShift(50_000).expect(409);
    expect(again.body.error.message).toMatch(/đang có ca mở/);

    await api()
      .get(`/api/v1/cash-shifts/${shift.id}`)
      .set(h(adminToken, fixture.otherStoreId))
      .expect(404);
    await openShift(0, adminToken, fixture.otherStoreId).expect(201);
  });

  it("gửi lại cùng khóa khi mở ca không mở thêm ca thứ hai", async () => {
    const key = { "Idempotency-Key": randomUUID() };
    const first = await api()
      .post("/api/v1/cash-shifts")
      .set({ ...h(), ...key })
      .send({ openingCash: 100_000 })
      .expect(201);
    const again = await api()
      .post("/api/v1/cash-shifts")
      .set({ ...h(), ...key })
      .send({ openingCash: 100_000 })
      .expect(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await prisma.cashShift.count()).toBe(1);
  });

  it("nhân viên kho không mở ca được; bán tiền mặt ngoài ca được nhắc khi mở ca sau", async () => {
    await useTestRole(fixture.salesId, "warehouse_staff", fixture.storeId);
    const warehouse = (await login("banhang")).token;
    await openShift(100_000, warehouse).expect(403);

    const shift = (await openShift(100_000).expect(201)).body.data;
    await api()
      .post(`/api/v1/cash-shifts/${shift.id}/close`)
      .set({ ...h(), ...idem() })
      .send({ countedCash: 100_000 })
      .expect(200);
    await sell(2);

    const current = (await api().get("/api/v1/cash-shifts/current").set(h()).expect(200)).body.data;
    expect(current.shift).toBeNull();
    expect(current.outsideShift).toMatchObject({ invoiceCount: 1, cash: 20_000 });
    expect(current.lastCountedCash).toBe(100_000);
  });
});
