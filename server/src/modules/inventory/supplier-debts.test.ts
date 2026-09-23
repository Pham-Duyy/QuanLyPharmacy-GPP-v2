import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../../test/helpers.js";

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let categoryId: string;
let productId: string;
let unitId: string;
let supplierId: string;

const idem = () => ({ "Idempotency-Key": randomUUID() });
const h = (token = adminToken) => authHeaders(token, fixture.storeId);

function dayOffset(days: number): string {
  const vnToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  const date = new Date(`${vnToday}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Nhập hàng thật rồi kiểm nhập: đó là lúc phát sinh công nợ. */
async function receive(options: { quantity: number; unitCost: number; receivedAt?: string; supplier?: string; confirm?: boolean }) {
  const created = await api()
    .post("/api/v1/goods-receipts")
    .set({ ...h(pharmacistToken), ...idem() })
    .send({
      supplierId: options.supplier ?? supplierId,
      ...(options.receivedAt ? { receivedAt: options.receivedAt } : {}),
      lines: [{ productId, unitId, quantity: options.quantity, unitCost: options.unitCost, batchNumber: `L${randomUUID().slice(0, 6)}`, expiryDate: dayOffset(400) }],
    })
    .expect(201);

  if (options.confirm !== false) {
    await api()
      .post(`/api/v1/goods-receipts/${created.body.data.id}/confirm`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({ lines: created.body.data.lines.map((line: { id: string }) => ({ lineId: line.id, passed: true })) })
      .expect(200);
  }
  return { id: created.body.data.id as string, code: created.body.data.code as string };
}

const debts = async (query = "", token = adminToken) => (await api().get(`/api/v1/supplier-debts${query}`).set(h(token)).expect(200)).body.data;
const pay = (body: Record<string, unknown>, token = adminToken) => api().post("/api/v1/supplier-payments").set(h(token)).send(body);

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [adminToken, pharmacistToken] = await Promise.all([login("admin").then((item) => item.token), login("duocsi").then((item) => item.token)]);
  categoryId = (await prisma.category.create({ data: { name: "Thuốc giảm đau" } })).id;
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
  supplierId = (await prisma.supplier.create({ data: { name: "Công ty Dược Minh Tâm", phone: "02838123456", paymentTermDays: 30 } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Công nợ phát sinh từ phiếu nhập", () => {
  it("chỉ phiếu đã kiểm nhập mới thành công nợ, hạn trả theo kỳ hạn nhà cung cấp", async () => {
    const confirmed = await receive({ quantity: 100, unitCost: 5000 });
    await receive({ quantity: 10, unitCost: 1000, confirm: false });

    const data = await debts();
    expect(data.items).toHaveLength(1);
    const supplier = data.items[0];
    expect(supplier).toMatchObject({ name: "Công ty Dược Minh Tâm", paymentTermDays: 30, outstanding: 500000, paidAmount: 0, overdueAmount: 0 });
    expect(supplier.receipts).toHaveLength(1);
    expect(supplier.receipts[0]).toMatchObject({ code: confirmed.code, totalCost: 500000, outstanding: 500000, overdueDays: 0 });
    expect(supplier.receipts[0].dueDate.slice(0, 10)).toBe(dayOffset(30));
    expect(data.summary).toMatchObject({ suppliers: 1, outstanding: 500000, overdueAmount: 0 });
  });

  it("nợ quá hạn và sắp đến hạn được tách riêng", async () => {
    await prisma.supplier.update({ where: { id: supplierId }, data: { paymentTermDays: 0 } });
    await receive({ quantity: 20, unitCost: 10000, receivedAt: `${dayOffset(-10)}T03:00:00.000Z` });
    await prisma.supplier.update({ where: { id: supplierId }, data: { paymentTermDays: 5 } });
    await receive({ quantity: 10, unitCost: 10000 });

    const data = await debts("?dueSoonDays=7");
    expect(data.summary).toMatchObject({ outstanding: 300000, overdueAmount: 200000, dueSoonAmount: 100000, overdueSuppliers: 1 });
    const overdue = data.items[0].receipts.find((item: { overdueDays: number }) => item.overdueDays > 0);
    expect(overdue.overdueDays).toBe(10);
  });

  it("đổi kỳ hạn chỉ áp dụng cho phiếu kiểm nhập sau đó", async () => {
    const first = await receive({ quantity: 10, unitCost: 1000 });
    await api().put(`/api/v1/supplier-debts/${supplierId}/term`).set(h()).send({ paymentTermDays: 7 }).expect(200);
    const second = await receive({ quantity: 10, unitCost: 1000 });

    const data = await debts();
    const byCode = new Map(data.items[0].receipts.map((item: { code: string; dueDate: string }) => [item.code, item.dueDate.slice(0, 10)]));
    expect(byCode.get(first.code)).toBe(dayOffset(30));
    expect(byCode.get(second.code)).toBe(dayOffset(7));
    expect(await prisma.auditLog.count({ where: { action: "SUPPLIER_TERM_UPDATE" } })).toBe(1);
  });
});

describe("Trả tiền nhà cung cấp", () => {
  it("trả gộp nhiều phiếu, phân bổ đúng số còn nợ từng phiếu", async () => {
    const first = await receive({ quantity: 100, unitCost: 5000 });
    const second = await receive({ quantity: 20, unitCost: 10000 });

    const created = await pay({
      supplierId,
      method: "BANK_TRANSFER",
      reference: "UNC 123456",
      allocations: [
        { goodsReceiptId: first.id, amount: 500000 },
        { goodsReceiptId: second.id, amount: 100000 },
      ],
    }).expect(201);

    const payment = await prisma.supplierPayment.findUniqueOrThrow({ where: { id: created.body.data.id }, include: { allocations: true } });
    expect(Number(payment.amount)).toBe(600000);
    expect(payment.code).toMatch(/^TT-NT01-\d{8}-0001$/);
    expect(payment.allocations).toHaveLength(2);

    const data = await debts();
    expect(data.items).toHaveLength(1);
    // paidAmount tính trên các phiếu đang liệt kê; phiếu đã trả hết không còn trong danh sách nợ.
    expect(data.items[0]).toMatchObject({ outstanding: 100000, paidAmount: 100000 });
    expect((await debts("?onlyOutstanding=false")).items[0]).toMatchObject({ outstanding: 100000, paidAmount: 600000, totalCost: 700000 });
    expect(data.items[0].receipts.map((item: { code: string }) => item.code)).toEqual([second.code]);

    const list = (await api().get("/api/v1/supplier-payments").set(h()).expect(200)).body.data;
    expect(list[0]).toMatchObject({ amount: 600000, method: "BANK_TRANSFER", reference: "UNC 123456", status: "ACTIVE", createdByName: "Quản trị" });
    expect(await prisma.auditLog.count({ where: { action: "SUPPLIER_PAYMENT_CREATE" } })).toBe(1);
  });

  it("không trả quá số còn nợ, kể cả khi đã trả một phần", async () => {
    const receipt = await receive({ quantity: 10, unitCost: 10000 });
    await pay({ supplierId, allocations: [{ goodsReceiptId: receipt.id, amount: 60000 }] }).expect(201);

    const tooMuch = await pay({ supplierId, allocations: [{ goodsReceiptId: receipt.id, amount: 50000 }] }).expect(422);
    expect(tooMuch.body.error.message).toContain("chỉ còn nợ");
    expect((await debts()).items[0].outstanding).toBe(40000);

    await pay({ supplierId, allocations: [{ goodsReceiptId: receipt.id, amount: 40000 }] }).expect(201);
    expect((await debts()).items).toEqual([]);
    expect((await debts("?onlyOutstanding=false")).items[0]).toMatchObject({ outstanding: 0, paidAmount: 100000 });
  });

  it("không trả cho phiếu của nhà cung cấp khác hoặc phiếu chưa kiểm nhập", async () => {
    const other = await prisma.supplier.create({ data: { name: "Công ty khác" } });
    const receipt = await receive({ quantity: 10, unitCost: 1000 });
    const draft = await receive({ quantity: 10, unitCost: 1000, confirm: false });

    await pay({ supplierId: other.id, allocations: [{ goodsReceiptId: receipt.id, amount: 1000 }] }).expect(422);
    await pay({ supplierId, allocations: [{ goodsReceiptId: draft.id, amount: 1000 }] }).expect(422);
    expect(await prisma.supplierPayment.count()).toBe(0);
  });

  it("hủy phiếu chi ghi nhầm thì công nợ quay lại, bắt buộc có lý do", async () => {
    const receipt = await receive({ quantity: 10, unitCost: 10000 });
    const created = await pay({ supplierId, method: "CASH", allocations: [{ goodsReceiptId: receipt.id, amount: 100000 }] }).expect(201);
    expect((await debts()).items).toEqual([]);

    await api().post(`/api/v1/supplier-payments/${created.body.data.id}/void`).set(h()).send({}).expect(422);
    await api().post(`/api/v1/supplier-payments/${created.body.data.id}/void`).set(h()).send({ reason: "Ghi nhầm sang nhà cung cấp khác" }).expect(200);

    expect((await debts()).items[0]).toMatchObject({ outstanding: 100000, paidAmount: 0 });
    const list = (await api().get("/api/v1/supplier-payments").set(h()).expect(200)).body.data;
    expect(list[0]).toMatchObject({ status: "VOIDED", voidReason: "Ghi nhầm sang nhà cung cấp khác", voidedByName: "Quản trị" });
    // Hủy lần nữa thì báo rõ.
    await api().post(`/api/v1/supplier-payments/${created.body.data.id}/void`).set(h()).send({ reason: "Thử lại" }).expect(409);
  });

  it("dược sĩ xem được nhưng không trả tiền được", async () => {
    const receipt = await receive({ quantity: 10, unitCost: 1000 });
    await api().get("/api/v1/supplier-debts").set(h(pharmacistToken)).expect(403);
    await pay({ supplierId, allocations: [{ goodsReceiptId: receipt.id, amount: 1000 }] }, pharmacistToken).expect(403);
    await api().get("/api/v1/supplier-debts").expect(401);
  });
});
