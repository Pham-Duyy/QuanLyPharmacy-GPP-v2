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

const h = (token = adminToken) => authHeaders(token, fixture.storeId);

function dayOffset(days: number): Date {
  const vnToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  const date = new Date(`${vnToday}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

async function makeBatch(batchNumber: string, daysToExpiry: number, quantity = 100, unitCost = 1000) {
  const batch = await prisma.batch.create({
    data: { storeId: fixture.storeId, productId, batchNumber, expiryDate: dayOffset(daysToExpiry), quantityOnHand: quantity, unitCost, shelfLocation: "Kệ A1" },
  });
  return batch.id;
}

const list = async (query = "", token = adminToken) => (await api().get(`/api/v1/expiry-alerts${query}`).set(h(token)).expect(200)).body.data;
const row = (data: { items: Array<{ batchNumber: string }> }, batchNumber: string) => data.items.find((item) => item.batchNumber === batchNumber) as Record<string, unknown> | undefined;

const plan = (body: Record<string, unknown>, token = pharmacistToken) => api().post("/api/v1/expiry-alerts/plans").set(h(token)).send(body);

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
      units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
    },
  });
  productId = product.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Danh sách hàng cận hạn", () => {
  it("chia nhóm theo mốc 30, 60, 90 ngày và tính giá trị tồn đang treo", async () => {
    await makeBatch("HET", -5, 10, 1000);
    await makeBatch("D30", 20, 100, 1000);
    await makeBatch("D60", 45, 50, 2000);
    await makeBatch("D90", 80, 20, 3000);
    await makeBatch("XA", 200, 500, 1000);

    const data = await list();
    // Lô còn hạn dài không nằm trong danh sách cảnh báo.
    expect(data.items.map((item: { batchNumber: string }) => item.batchNumber)).toEqual(["HET", "D30", "D60", "D90"]);
    expect(row(data, "HET")).toMatchObject({ bucket: "EXPIRED", daysLeft: -5, stockValue: 10000 });
    expect(row(data, "D30")).toMatchObject({ bucket: "D30", stockValue: 100000, baseUnitName: "Viên", shelfLocation: "Kệ A1" });
    expect(row(data, "D60")).toMatchObject({ bucket: "D60", stockValue: 100000 });
    expect(row(data, "D90")).toMatchObject({ bucket: "D90", stockValue: 60000 });

    expect(data.summary.byBucket.D30).toMatchObject({ batches: 1, quantity: 100, value: 100000, withoutPlan: 1 });
    expect(data.summary).toMatchObject({ totalBatches: 4, withoutPlan: 4, overduePlans: 0, totalValue: 270000 });
  });

  it("giá trị tồn chỉ hiện với người có quyền xem giá vốn", async () => {
    await makeBatch("D30", 10, 100, 1000);
    const forPharmacist = await list("", pharmacistToken);
    expect(row(forPharmacist, "D30")).toMatchObject({ stockValue: null });
    expect(forPharmacist.summary.totalValue).toBeNull();
  });

  it("lọc theo mốc và lọc lô chưa có kế hoạch", async () => {
    await makeBatch("D30", 10);
    await makeBatch("D60", 50);
    const planned = await makeBatch("D30B", 12);
    await plan({ batchId: planned, action: "RETURN_SUPPLIER", dueDate: dayOffset(3).toISOString().slice(0, 10) }).expect(201);

    expect((await list("?bucket=D30")).items.map((item: { batchNumber: string }) => item.batchNumber)).toEqual(["D30", "D30B"]);
    expect((await list("?onlyWithoutPlan=true")).items.map((item: { batchNumber: string }) => item.batchNumber)).toEqual(["D30", "D60"]);
    // Tầm nhìn ngắn hơn thì lô xa hơn không còn trong danh sách.
    expect((await list("?horizonDays=30")).items.map((item: { batchNumber: string }) => item.batchNumber)).toEqual(["D30", "D30B"]);
  });

  it("gợi ý nhà cung cấp của lô để biết gọi ai khi muốn trả hàng", async () => {
    const supplier = await prisma.supplier.create({ data: { name: "Công ty Dược Minh Tâm" } });
    const unit = await prisma.productUnit.findFirstOrThrow({ where: { productId } });
    const receipt = await api()
      .post("/api/v1/goods-receipts")
      .set({ ...h(pharmacistToken), "Idempotency-Key": randomUUID() })
      .send({
        supplierId: supplier.id,
        lines: [{ productId, unitId: unit.id, quantity: 40, unitCost: 900, batchNumber: "NCC1", expiryDate: dayOffset(45).toISOString().slice(0, 10) }],
      })
      .expect(201);
    await api()
      .post(`/api/v1/goods-receipts/${receipt.body.data.id}/confirm`)
      .set({ ...h(pharmacistToken), "Idempotency-Key": randomUUID() })
      .send({ lines: receipt.body.data.lines.map((line: { id: string }) => ({ lineId: line.id, passed: true })) })
      .expect(200);

    expect(row(await list(), "NCC1")).toMatchObject({ lastSupplier: { name: "Công ty Dược Minh Tâm" }, quantityOnHand: 40 });
  });
});

describe("Kế hoạch xử lý lô cận hạn", () => {
  it("lập kế hoạch, sửa lại và đóng khi xong", async () => {
    const batchId = await makeBatch("D30", 20);

    const created = await plan({ batchId, action: "RETURN_SUPPLIER", dueDate: dayOffset(5).toISOString().slice(0, 10), note: "Đã gọi NCC, chờ xác nhận" }).expect(201);
    const afterCreate = row(await list(), "D30")!;
    expect(afterCreate.plan).toMatchObject({ action: "RETURN_SUPPLIER", status: "PLANNED", createdByName: "Dược sĩ", overdue: false });
    expect((await list()).summary.withoutPlan).toBe(0);

    // Lập lại cho cùng lô thì cập nhật kế hoạch đang mở, không tạo thêm.
    await plan({ batchId, action: "DISCOUNT", note: "Giảm giá 30% để đẩy hàng" }).expect(201);
    expect(await prisma.batchExpiryPlan.count({ where: { status: "PLANNED" } })).toBe(1);
    expect(row(await list(), "D30")!.plan).toMatchObject({ action: "DISCOUNT", note: "Giảm giá 30% để đẩy hàng", version: 2 });

    await api()
      .post(`/api/v1/expiry-alerts/plans/${created.body.data.id}/close`)
      .set(h(pharmacistToken))
      .send({ status: "DONE", outcome: "Đã bán hết trong đợt giảm giá" })
      .expect(200);

    const afterClose = await list();
    expect(row(afterClose, "D30")!.plan).toBeNull();
    expect(afterClose.summary.withoutPlan).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "EXPIRY_PLAN_DONE" } })).toBe(1);

    // Đóng lần nữa thì báo lỗi rõ ràng.
    const again = await api().post(`/api/v1/expiry-alerts/plans/${created.body.data.id}/close`).set(h(pharmacistToken)).send({}).expect(409);
    expect(again.body.error.message).toContain("đã đóng rồi");
  });

  it("kế hoạch quá ngày hẹn được đánh dấu để báo lại", async () => {
    const batchId = await makeBatch("D30", 25);
    await plan({ batchId, action: "PRIORITIZE_SALE", dueDate: dayOffset(-2).toISOString().slice(0, 10) }).expect(201);

    const data = await list();
    expect(row(data, "D30")!.plan).toMatchObject({ overdue: true });
    expect(data.summary.overduePlans).toBe(1);
  });

  it("lịch sử xử lý của lô giữ lại cả kế hoạch đã đóng", async () => {
    const batchId = await makeBatch("D30", 20);
    const first = await plan({ batchId, action: "RETURN_SUPPLIER" }).expect(201);
    await api().post(`/api/v1/expiry-alerts/plans/${first.body.data.id}/close`).set(h(pharmacistToken)).send({ status: "CANCELLED", outcome: "NCC không nhận trả" }).expect(200);
    await plan({ batchId, action: "DISPOSE", note: "Lên lịch hủy cuối tháng" }).expect(201);

    const history = (await api().get(`/api/v1/expiry-alerts/batches/${batchId}/plans`).set(h()).expect(200)).body.data;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ action: "DISPOSE", status: "PLANNED" });
    expect(history[1]).toMatchObject({ action: "RETURN_SUPPLIER", status: "CANCELLED", outcome: "NCC không nhận trả" });
  });

  it("kiểm tra quyền, lô không thuộc cửa hàng và dữ liệu sai", async () => {
    const batchId = await makeBatch("D30", 20);
    await api().get("/api/v1/expiry-alerts").set(h(salesToken)).expect(200);
    await plan({ batchId, action: "DISPOSE" }, salesToken).expect(403);
    await plan({ batchId, action: "KHONG_CO" }).expect(422);
    await plan({ batchId: randomUUID(), action: "DISPOSE" }).expect(404);

    const other = await prisma.batch.create({
      data: { storeId: fixture.otherStoreId, productId, batchNumber: "KHAC", expiryDate: dayOffset(10), quantityOnHand: 5 },
    });
    await plan({ batchId: other.id, action: "DISPOSE" }).expect(404);
    expect(row(await list(), "KHAC")).toBeUndefined();
  });
});
