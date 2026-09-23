import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../../test/helpers.js";

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let salesToken: string;
let categoryId: string;
let productId: string;
let pillId: string;
let boxId: string;
let supplierId: string;

const idem = () => ({ "Idempotency-Key": randomUUID() });
const h = (token = pharmacistToken) => authHeaders(token, fixture.storeId);

function dayOffset(days: number): string {
  const vnToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  const date = new Date(`${vnToday}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Nhập và kiểm nhập một phiếu: tạo lô có giá vốn và phát sinh công nợ. */
async function receive(quantityBoxes: number, unitCost: number, batchNumber: string) {
  const created = await api()
    .post("/api/v1/goods-receipts")
    .set({ ...h(), ...idem() })
    .send({ supplierId, lines: [{ productId, unitId: boxId, quantity: quantityBoxes, unitCost, batchNumber, expiryDate: dayOffset(400) }] })
    .expect(201);
  await api()
    .post(`/api/v1/goods-receipts/${created.body.data.id}/confirm`)
    .set({ ...h(), ...idem() })
    .send({ lines: created.body.data.lines.map((line: { id: string }) => ({ lineId: line.id, passed: true })) })
    .expect(200);
  const batch = await prisma.batch.findFirstOrThrow({ where: { batchNumber } });
  return { receiptId: created.body.data.id as string, code: created.body.data.code as string, batchId: batch.id };
}

const createReturn = (body: Record<string, unknown>, token = pharmacistToken) => api().post("/api/v1/supplier-returns").set(h(token)).send(body);
const confirm = (id: string, token = pharmacistToken) => api().post(`/api/v1/supplier-returns/${id}/confirm`).set(h(token)).send({});
const debts = async () => (await api().get("/api/v1/supplier-debts").set(authHeaders(adminToken, fixture.storeId)).expect(200)).body.data;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [adminToken, pharmacistToken, salesToken] = await Promise.all([
    login("admin").then((item) => item.token),
    login("duocsi").then((item) => item.token),
    login("banhang").then((item) => item.token),
  ]);
  categoryId = (await prisma.category.create({ data: { name: "Thuốc giảm đau" } })).id;
  const product = await prisma.product.create({
    data: {
      code: "TH0001",
      name: "Paracetamol 500mg",
      productType: "DRUG",
      drugClass: "OTC",
      categoryId,
      units: {
        create: [
          { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true },
          { name: "Hộp", conversionToBase: 100 },
        ],
      },
    },
    include: { units: true },
  });
  productId = product.id;
  pillId = product.units.find((unit) => unit.name === "Viên")!.id;
  boxId = product.units.find((unit) => unit.name === "Hộp")!.id;
  await prisma.productPrice.create({ data: { productUnitId: pillId, salePrice: 1000n, vatRatePercent: 5, effectiveFrom: new Date(Date.now() - 86_400_000) } });
  supplierId = (await prisma.supplier.create({ data: { name: "Công ty Dược Minh Tâm", paymentTermDays: 30 } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Lập phiếu trả hàng nhà cung cấp", () => {
  it("chọn lô còn tồn, tính giá trị theo giá vốn và gắn đúng phiếu nhập gốc", async () => {
    const received = await receive(3, 80000, "L1");

    const returnable = (await api().get("/api/v1/supplier-returns/returnable").set(h()).expect(200)).body.data;
    expect(returnable).toHaveLength(1);
    expect(returnable[0]).toMatchObject({ batchNumber: "L1", quantityOnHand: 300, unitCost: 800, supplier: { name: "Công ty Dược Minh Tâm" } });
    expect(returnable[0].goodsReceipt).toMatchObject({ code: received.code });

    const created = await createReturn({
      supplierId,
      reason: "Hàng cận hạn, nhà cung cấp đồng ý nhận lại",
      settlement: "DEDUCT_DEBT",
      lines: [{ batchId: received.batchId, unitId: boxId, quantity: 1 }],
    }).expect(201);

    expect(created.body.data).toMatchObject({ status: "DRAFT", settlement: "DEDUCT_DEBT", totalValue: 80000, createdByName: "Dược sĩ" });
    expect(created.body.data.code).toMatch(/^TNCC-NT01-\d{8}-0001$/);
    expect(created.body.data.lines[0]).toMatchObject({ batchNumber: "L1", unitName: "Hộp", quantity: 1, baseQuantity: 100, unitCost: 800, lineValue: 80000 });
    expect(created.body.data.lines[0].goodsReceipt).toMatchObject({ code: received.code });

    // Còn nháp thì chưa đụng tới tồn kho.
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: received.batchId } })).quantityOnHand).toBe(300);
  });

  it("không trả quá tồn của lô và không nhận đơn vị của sản phẩm khác", async () => {
    const received = await receive(1, 50000, "L1");
    const other = await prisma.product.create({
      data: { code: "TH0002", name: "Khác", productType: "DRUG", drugClass: "OTC", categoryId, units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } } },
      include: { units: true },
    });

    const tooMuch = await createReturn({ supplierId, reason: "Hàng lỗi", lines: [{ batchId: received.batchId, unitId: boxId, quantity: 2 }] }).expect(409);
    expect(tooMuch.body.error.code).toBe("INSUFFICIENT_STOCK");

    const wrongUnit = await createReturn({ supplierId, reason: "Hàng lỗi", lines: [{ batchId: received.batchId, unitId: other.units[0]!.id, quantity: 1 }] }).expect(422);
    expect(wrongUnit.body.error.code).toBe("UNIT_NOT_IN_PRODUCT");
    expect(await prisma.supplierReturn.count()).toBe(0);
  });

  it("phải ghi lý do trả hàng", async () => {
    const received = await receive(1, 50000, "L1");
    await createReturn({ supplierId, reason: "", lines: [{ batchId: received.batchId, unitId: boxId, quantity: 1 }] }).expect(422);
  });
});

describe("Xác nhận và hủy phiếu trả hàng", () => {
  it("xác nhận thì trừ tồn, ghi thẻ kho và trừ công nợ đúng phiếu nhập", async () => {
    const received = await receive(3, 80000, "L1");
    expect((await debts()).items[0]).toMatchObject({ outstanding: 240000 });

    const created = await createReturn({
      supplierId,
      reason: "Hàng cận hạn",
      settlement: "DEDUCT_DEBT",
      lines: [{ batchId: received.batchId, unitId: boxId, quantity: 1 }],
    }).expect(201);

    const confirmed = await confirm(created.body.data.id).expect(200);
    expect(confirmed.body.data).toMatchObject({ status: "CONFIRMED", confirmedByName: "Dược sĩ" });

    expect((await prisma.batch.findUniqueOrThrow({ where: { id: received.batchId } })).quantityOnHand).toBe(200);
    const movement = await prisma.stockMovement.findFirstOrThrow({ where: { type: "SUPPLIER_RETURN" } });
    expect(movement).toMatchObject({ baseQuantity: -100, balanceAfter: 200, sourceType: "SUPPLIER_RETURN", note: "Hàng cận hạn" });

    const afterReturn = (await debts()).items[0];
    expect(afterReturn).toMatchObject({ outstanding: 160000 });
    expect(afterReturn.receipts[0]).toMatchObject({ returnCredit: 80000, outstanding: 160000 });
    expect(await prisma.auditLog.count({ where: { action: "SUPPLIER_RETURN_CONFIRM" } })).toBe(1);
  });

  it("trả để nhận lại tiền hoặc đổi hàng thì không trừ công nợ", async () => {
    const received = await receive(2, 50000, "L1");
    const created = await createReturn({
      supplierId,
      reason: "Giao sai hàng",
      settlement: "REPLACEMENT",
      lines: [{ batchId: received.batchId, unitId: boxId, quantity: 1 }],
    }).expect(201);
    await confirm(created.body.data.id).expect(200);

    // Hàng vẫn ra khỏi kho, nhưng công nợ giữ nguyên vì sẽ được đổi hàng khác.
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: received.batchId } })).quantityOnHand).toBe(100);
    expect((await debts()).items[0]).toMatchObject({ outstanding: 100000 });
  });

  it("bán bớt sau khi lập nháp thì xác nhận báo thiếu hàng", async () => {
    const received = await receive(1, 50000, "L1");
    const created = await createReturn({ supplierId, reason: "Hàng lỗi", lines: [{ batchId: received.batchId, unitId: boxId, quantity: 1 }] }).expect(201);

    await api()
      .post("/api/v1/invoices")
      .set({ ...h(), ...idem() })
      .send({ lines: [{ productId, unitId: pillId, quantity: 10 }] })
      .expect(201);

    const response = await confirm(created.body.data.id).expect(409);
    expect(response.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect((await prisma.supplierReturn.findUniqueOrThrow({ where: { id: created.body.data.id } })).status).toBe("DRAFT");
  });

  it("hủy được phiếu nháp, không hủy được phiếu đã xác nhận", async () => {
    const received = await receive(2, 50000, "L1");
    const draft = await createReturn({ supplierId, reason: "Nhầm lô", lines: [{ batchId: received.batchId, unitId: boxId, quantity: 1 }] }).expect(201);

    await api().post(`/api/v1/supplier-returns/${draft.body.data.id}/cancel`).set(h()).send({}).expect(422);
    const cancelled = await api().post(`/api/v1/supplier-returns/${draft.body.data.id}/cancel`).set(h()).send({ reason: "Chọn nhầm lô" }).expect(200);
    expect(cancelled.body.data).toMatchObject({ status: "CANCELLED", cancelReason: "Chọn nhầm lô" });
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: received.batchId } })).quantityOnHand).toBe(200);

    const other = await createReturn({ supplierId, reason: "Hàng lỗi", lines: [{ batchId: received.batchId, unitId: boxId, quantity: 1 }] }).expect(201);
    await confirm(other.body.data.id).expect(200);
    const late = await api().post(`/api/v1/supplier-returns/${other.body.data.id}/cancel`).set(h()).send({ reason: "Đổi ý" }).expect(409);
    expect(late.body.error.message).toContain("Chỉ hủy được phiếu còn nháp");
  });

  it("phân quyền: nhân viên bán hàng không lập, không xác nhận", async () => {
    const received = await receive(1, 50000, "L1");
    await api().get("/api/v1/supplier-returns").set(h(salesToken)).expect(403);
    await createReturn({ supplierId, reason: "Hàng lỗi", lines: [{ batchId: received.batchId, unitId: boxId, quantity: 1 }] }, salesToken).expect(403);

    const created = await createReturn({ supplierId, reason: "Hàng lỗi", lines: [{ batchId: received.batchId, unitId: boxId, quantity: 1 }] }).expect(201);
    await confirm(created.body.data.id, salesToken).expect(403);

    const list = (await api().get("/api/v1/supplier-returns").set(h()).expect(200)).body.data;
    expect(list[0]).toMatchObject({ code: created.body.data.code, status: "DRAFT", lineCount: 1, totalValue: 50000 });
  });

  it("không thấy phiếu của cửa hàng khác", async () => {
    const received = await receive(1, 50000, "L1");
    const created = await createReturn({ supplierId, reason: "Hàng lỗi", lines: [{ batchId: received.batchId, unitId: boxId, quantity: 1 }] }).expect(201);
    await api().get(`/api/v1/supplier-returns/${created.body.data.id}`).set(authHeaders(adminToken, fixture.otherStoreId)).expect(404);
  });
});
