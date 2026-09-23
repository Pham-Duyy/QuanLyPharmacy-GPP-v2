import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../../test/helpers.js";

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let salesToken: string;
let categoryId: string;
let otherCategoryId: string;
let product: { id: string; pillId: string; boxId: string };
let vitamin: { id: string; pillId: string; boxId: string };

const idem = () => ({ "Idempotency-Key": randomUUID() });
const h = (token: string) => authHeaders(token, fixture.storeId);

async function makeProduct(code: string, name: string, categoryIdValue: string) {
  const created = await prisma.product.create({
    data: {
      code,
      name,
      productType: "DRUG",
      drugClass: "OTC",
      categoryId: categoryIdValue,
      units: {
        create: [
          { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true },
          { name: "Hộp", conversionToBase: 10 },
        ],
      },
    },
    include: { units: true },
  });
  const pill = created.units.find((unit) => unit.name === "Viên")!;
  await prisma.productPrice.create({
    data: { productUnitId: pill.id, salePrice: 1000n, vatRatePercent: 5, effectiveFrom: new Date(Date.now() - 86_400_000) },
  });
  return { id: created.id, pillId: pill.id, boxId: created.units.find((unit) => unit.name === "Hộp")!.id };
}

async function makeBatch(productId: string, batchNumber: string, quantity: number, shelf?: string, unitCost = 800) {
  const expiryDate = new Date();
  expiryDate.setUTCFullYear(expiryDate.getUTCFullYear() + 1);
  const batch = await prisma.batch.create({
    data: { storeId: fixture.storeId, productId, batchNumber, expiryDate, quantityOnHand: quantity, shelfLocation: shelf ?? null, unitCost },
  });
  return batch.id;
}

const open = (body: Record<string, unknown> = {}, token = pharmacistToken) => api().post("/api/v1/stock-counts").set(h(token)).send(body);
const detail = async (id: string, token = pharmacistToken) => (await api().get(`/api/v1/stock-counts/${id}`).set(h(token)).expect(200)).body.data;
const saveCounts = (id: string, entries: unknown[], token = pharmacistToken) =>
  api().patch(`/api/v1/stock-counts/${id}/counts`).set(h(token)).send({ entries });
const close = (id: string, body: Record<string, unknown> = {}, token = pharmacistToken) =>
  api().post(`/api/v1/stock-counts/${id}/close`).set(h(token)).send(body);

/** Bán hàng thật qua API để tạo biến động tồn giữa lúc đếm và lúc duyệt. */
function sell(productId: string, unitId: string, quantity: number) {
  return api()
    .post("/api/v1/invoices")
    .set({ ...h(pharmacistToken), ...idem() })
    .send({ lines: [{ productId, unitId, quantity }] })
    .expect(201);
}

type LineView = Record<string, unknown> & { id: string; batchNumber: string };
const lineOf = (data: { lines: LineView[] }, batchNumber: string): LineView => data.lines.find((line) => line.batchNumber === batchNumber)!;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [adminToken, pharmacistToken, salesToken] = await Promise.all([
    login("admin").then((item) => item.token),
    login("duocsi").then((item) => item.token),
    login("banhang").then((item) => item.token),
  ]);
  categoryId = (await prisma.category.create({ data: { name: "Thuốc giảm đau" } })).id;
  otherCategoryId = (await prisma.category.create({ data: { name: "Vitamin" } })).id;
  product = await makeProduct("TH0001", "Paracetamol 500mg", categoryId);
  vitamin = await makeProduct("TP0001", "Vitamin C", otherCategoryId);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Mở đợt kiểm kê", () => {
  it("chụp các lô còn tồn, xếp theo kệ và đánh số dòng", async () => {
    await makeBatch(product.id, "L2", 40, "Kệ B2");
    await makeBatch(product.id, "L1", 100, "Kệ A1");
    await makeBatch(product.id, "L0", 0, "Kệ A1");
    await makeBatch(vitamin.id, "V1", 20, "Kệ C1");

    const response = await open({ note: "Kiểm kê cuối tháng 9" }).expect(201);
    const { count, lines, summary } = response.body.data;
    expect(count.code).toMatch(/^KK-NT01-\d{8}-0001$/);
    expect(count.status).toBe("COUNTING");
    // Lô hết tồn không đưa vào danh sách đếm sẵn.
    expect(lines.map((line: { batchNumber: string }) => line.batchNumber)).toEqual(["L1", "L2", "V1"]);
    expect(lines[0]).toMatchObject({ lineNo: 1, shelfLocation: "Kệ A1", systemBaseQuantityAtOpen: 100, countedBaseQuantity: null });
    expect(summary).toMatchObject({ totalLines: 3, countedLines: 0, pendingLines: 3, differenceLines: 0 });
  });

  it("kiểm kê theo nhóm hàng hoặc theo kệ chỉ lấy đúng phạm vi", async () => {
    await makeBatch(product.id, "L1", 100, "Kệ A1");
    await makeBatch(vitamin.id, "V1", 20, "Kệ C1");

    const byCategory = await open({ scopeType: "CATEGORY", scopeValue: otherCategoryId }).expect(201);
    expect(byCategory.body.data.count.scopeLabel).toBe("Vitamin");
    expect(byCategory.body.data.lines.map((line: { batchNumber: string }) => line.batchNumber)).toEqual(["V1"]);
    await api().post(`/api/v1/stock-counts/${byCategory.body.data.count.id}/cancel`).set(h(pharmacistToken)).send({}).expect(200);

    const byShelf = await open({ scopeType: "SHELF", scopeValue: "kệ a1" }).expect(201);
    expect(byShelf.body.data.lines.map((line: { batchNumber: string }) => line.batchNumber)).toEqual(["L1"]);
  });

  it("chặn hai đợt song song, phạm vi rỗng và thiếu phạm vi", async () => {
    await makeBatch(product.id, "L1", 100);
    await open().expect(201);
    const second = await open().expect(409);
    expect(second.body.error.message).toContain("chưa chốt");

    // Hủy đợt đang mở để kiểm tra tiếp trường hợp phạm vi không có hàng.
    const openId = (await api().get("/api/v1/stock-counts").set(h(pharmacistToken)).expect(200)).body.data.open.id;
    await api().post(`/api/v1/stock-counts/${openId}/cancel`).set(h(pharmacistToken)).send({}).expect(200);

    const empty = await api()
      .post("/api/v1/stock-counts")
      .set(h(pharmacistToken))
      .send({ scopeType: "SHELF", scopeValue: "Kệ không có hàng" })
      .expect(422);
    expect(empty.body.error.message).toContain("chưa có lô nào còn tồn");

    await open({ scopeType: "CATEGORY" }).expect(422);
  });

  it("nhân viên bán hàng xem được nhưng không mở được đợt kiểm kê", async () => {
    await makeBatch(product.id, "L1", 100);
    await open({}, salesToken).expect(403);
    const id = (await open().expect(201)).body.data.count.id;
    await api().get(`/api/v1/stock-counts/${id}`).set(h(salesToken)).expect(200);
  });
});

describe("Ghi số đếm", () => {
  it("đếm theo đơn vị lớn, sửa lại được và xóa được số đã đếm", async () => {
    await makeBatch(product.id, "L1", 100, "Kệ A1");
    const id = (await open().expect(201)).body.data.count.id;
    const line = lineOf(await detail(id), "L1");

    const saved = await saveCounts(id, [{ lineId: line.id, unitId: product.boxId, quantity: 9 }]).expect(200);
    const afterCount = lineOf(saved.body.data, "L1");
    expect(afterCount).toMatchObject({ countedQuantity: 9, countedBaseQuantity: 90, systemBaseQuantityAtCount: 100, differenceBaseQuantity: -10 });
    expect(afterCount.countedByName).toBe("Dược sĩ");
    expect(saved.body.data.summary).toMatchObject({ countedLines: 1, pendingLines: 0, differenceLines: 1, shortageBaseQuantity: 10 });

    const fixed = await saveCounts(id, [{ lineId: line.id, unitId: product.pillId, quantity: 100 }]).expect(200);
    expect(lineOf(fixed.body.data, "L1")).toMatchObject({ countedBaseQuantity: 100, differenceBaseQuantity: 0 });
    expect(fixed.body.data.summary.differenceLines).toBe(0);

    const cleared = await saveCounts(id, [{ lineId: line.id, clear: true }]).expect(200);
    expect(lineOf(cleared.body.data, "L1")).toMatchObject({ countedBaseQuantity: null, systemBaseQuantityAtCount: null });
    expect(cleared.body.data.summary.pendingLines).toBe(1);
  });

  it("chặn đơn vị không thuộc sản phẩm của lô", async () => {
    await makeBatch(product.id, "L1", 100);
    const id = (await open().expect(201)).body.data.count.id;
    const line = lineOf(await detail(id), "L1");
    const response = await saveCounts(id, [{ lineId: line.id, unitId: vitamin.boxId, quantity: 1 }]).expect(422);
    expect(response.body.error.code).toBe("UNIT_NOT_IN_PRODUCT");
  });

  it("thêm được lô tìm thấy trên kệ dù hệ thống báo hết tồn", async () => {
    await makeBatch(product.id, "L1", 100);
    const extraBatchId = await makeBatch(product.id, "L9", 0);
    const id = (await open().expect(201)).body.data.count.id;

    const added = await api().post(`/api/v1/stock-counts/${id}/lines`).set(h(pharmacistToken)).send({ batchId: extraBatchId }).expect(201);
    const line = lineOf(added.body.data, "L9");
    expect(line).toMatchObject({ systemBaseQuantityAtOpen: 0, countedBaseQuantity: null });

    const saved = await saveCounts(id, [{ lineId: line.id, unitId: product.pillId, quantity: 6 }]).expect(200);
    expect(lineOf(saved.body.data, "L9")).toMatchObject({ differenceBaseQuantity: 6 });
  });

  it("giá trị chênh lệch chỉ hiện với người có quyền xem giá vốn", async () => {
    await makeBatch(product.id, "L1", 100, undefined, 800);
    const id = (await open().expect(201)).body.data.count.id;
    const line = lineOf(await detail(id), "L1");
    await saveCounts(id, [{ lineId: line.id, unitId: product.pillId, quantity: 95 }]).expect(200);

    const forAdmin = await detail(id, adminToken);
    expect(lineOf(forAdmin, "L1").differenceValue).toBe(-4000);
    expect(forAdmin.summary.differenceValue).toBe(-4000);

    const forPharmacist = await detail(id);
    expect(lineOf(forPharmacist, "L1").differenceValue).toBeNull();
    expect(forPharmacist.summary.differenceValue).toBeNull();
  });
});

describe("Chốt đợt kiểm kê", () => {
  it("sinh phiếu điều chỉnh chờ duyệt cho đúng các dòng lệch", async () => {
    await makeBatch(product.id, "L1", 100);
    await makeBatch(product.id, "L2", 50);
    const id = (await open().expect(201)).body.data.count.id;
    const data = await detail(id);
    await saveCounts(id, [
      { lineId: lineOf(data, "L1").id, unitId: product.pillId, quantity: 95 },
      { lineId: lineOf(data, "L2").id, unitId: product.pillId, quantity: 50 },
    ]).expect(200);

    const closed = await close(id, { note: "Kiểm kê quý III" }).expect(200);
    expect(closed.body.data).toMatchObject({ differenceLines: 1 });
    expect(closed.body.data.count.status).toBe("CLOSED");

    const adjustment = await prisma.stockAdjustment.findFirstOrThrow({ include: { lines: true } });
    expect(adjustment.status).toBe("DRAFT");
    expect(adjustment.reason).toContain("Chênh lệch kiểm kê KK-NT01");
    expect(adjustment.lines).toHaveLength(1);
    expect(adjustment.lines[0]).toMatchObject({ reasonCode: "COUNT_DIFFERENCE", countedQuantity: 95, systemBaseQuantityAtCount: 100 });
    expect(closed.body.data.count.adjustment).toMatchObject({ code: adjustment.code, status: "DRAFT" });
    expect(await prisma.auditLog.count({ where: { action: "STOCK_COUNT_CLOSE" } })).toBe(1);

    // Chốt rồi thì không ghi thêm số đếm được.
    await saveCounts(id, [{ lineId: lineOf(data, "L1").id, unitId: product.pillId, quantity: 1 }]).expect(409);
  });

  it("đếm khớp hết thì không tạo phiếu điều chỉnh nào", async () => {
    await makeBatch(product.id, "L1", 100);
    const id = (await open().expect(201)).body.data.count.id;
    await saveCounts(id, [{ lineId: lineOf(await detail(id), "L1").id, unitId: product.pillId, quantity: 100 }]).expect(200);

    const closed = await close(id).expect(200);
    expect(closed.body.data.adjustmentId).toBeNull();
    expect(await prisma.stockAdjustment.count()).toBe(0);
  });

  it("dòng chưa đếm không bị coi là đếm được 0", async () => {
    await makeBatch(product.id, "L1", 100);
    await makeBatch(product.id, "L2", 50);
    const id = (await open().expect(201)).body.data.count.id;
    await saveCounts(id, [{ lineId: lineOf(await detail(id), "L1").id, unitId: product.pillId, quantity: 100 }]).expect(200);

    await close(id).expect(200);
    expect(await prisma.stockAdjustment.count()).toBe(0);
    const after = await detail(id);
    expect(after.summary).toMatchObject({ countedLines: 1, pendingLines: 1, differenceLines: 0 });
  });

  it("chưa đếm dòng nào thì không chốt được", async () => {
    await makeBatch(product.id, "L1", 100);
    const id = (await open().expect(201)).body.data.count.id;
    const response = await close(id).expect(422);
    expect(response.body.error.message).toContain("Chưa đếm dòng nào");
  });

  it("hàng bán ra sau khi đếm không bị tính thành thất thoát", async () => {
    await makeBatch(product.id, "L1", 100);
    const id = (await open().expect(201)).body.data.count.id;

    // Đếm đúng 100 viên, khớp tồn hệ thống lúc đếm.
    await saveCounts(id, [{ lineId: lineOf(await detail(id), "L1").id, unitId: product.pillId, quantity: 100 }]).expect(200);
    // Bán 10 viên sau khi đếm xong mặt hàng này.
    await sell(product.id, product.pillId, 10);

    const closed = await close(id).expect(200);
    expect(closed.body.data.differenceLines).toBe(0);
    expect(await prisma.stockAdjustment.count()).toBe(0);
    const batch = await prisma.batch.findFirstOrThrow({ where: { batchNumber: "L1" } });
    expect(batch.quantityOnHand).toBe(90);
  });

  it("thiếu hàng thật: duyệt phiếu đưa tồn về đúng thực tế kể cả khi có bán xen giữa", async () => {
    await makeBatch(product.id, "L1", 100);
    const id = (await open().expect(201)).body.data.count.id;

    // Đếm thấy 95 trong khi hệ thống ghi 100 — thiếu 5.
    await saveCounts(id, [{ lineId: lineOf(await detail(id), "L1").id, unitId: product.pillId, quantity: 95 }]).expect(200);
    // Sau khi đếm, bán tiếp 10 viên.
    await sell(product.id, product.pillId, 10);
    const closed = await close(id).expect(200);

    // Người duyệt phải khác người lập: phiếu do dược sĩ chốt, admin duyệt.
    await api()
      .post(`/api/v1/stock-adjustments/${closed.body.data.adjustmentId}/approve`)
      .set({ ...h(adminToken), ...idem() })
      .send({})
      .expect(200);

    const batch = await prisma.batch.findFirstOrThrow({ where: { batchNumber: "L1" } });
    // 100 − 10 bán − 5 thiếu = 85.
    expect(batch.quantityOnHand).toBe(85);
    const movement = await prisma.stockMovement.findFirstOrThrow({ where: { type: "ADJUSTMENT" } });
    expect(movement.baseQuantity).toBe(-5);
    expect(movement.balanceAfter).toBe(85);
  });

  it("hủy đợt không đụng tới tồn và cho phép mở đợt mới", async () => {
    await makeBatch(product.id, "L1", 100);
    const id = (await open().expect(201)).body.data.count.id;
    await saveCounts(id, [{ lineId: lineOf(await detail(id), "L1").id, unitId: product.pillId, quantity: 10 }]).expect(200);

    const cancelled = await api().post(`/api/v1/stock-counts/${id}/cancel`).set(h(pharmacistToken)).send({ reason: "Đếm nhầm kệ" }).expect(200);
    expect(cancelled.body.data.count.status).toBe("CANCELLED");
    expect((await prisma.batch.findFirstOrThrow({ where: { batchNumber: "L1" } })).quantityOnHand).toBe(100);
    expect(await prisma.stockAdjustment.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "STOCK_COUNT_CANCEL" } })).toBe(1);

    await open().expect(201);
  });

  it("danh sách đợt kiểm kê hiện tiến độ và đợt đang mở", async () => {
    await makeBatch(product.id, "L1", 100);
    await makeBatch(product.id, "L2", 50);
    const id = (await open().expect(201)).body.data.count.id;
    await saveCounts(id, [{ lineId: lineOf(await detail(id), "L1").id, unitId: product.pillId, quantity: 90 }]).expect(200);

    const list = (await api().get("/api/v1/stock-counts").set(h(pharmacistToken)).expect(200)).body.data;
    expect(list.open).toMatchObject({ id });
    expect(list.items[0]).toMatchObject({ totalLines: 2, countedLines: 1, differenceLines: 1, createdByName: "Dược sĩ" });

    const onlyClosed = (await api().get("/api/v1/stock-counts?status=CLOSED").set(h(pharmacistToken)).expect(200)).body.data;
    expect(onlyClosed.items).toEqual([]);
  });

  it("không thấy đợt kiểm kê của cửa hàng khác", async () => {
    await makeBatch(product.id, "L1", 100);
    const id = (await open().expect(201)).body.data.count.id;
    await api().get(`/api/v1/stock-counts/${id}`).set(authHeaders(adminToken, fixture.otherStoreId)).expect(404);
  });
});
