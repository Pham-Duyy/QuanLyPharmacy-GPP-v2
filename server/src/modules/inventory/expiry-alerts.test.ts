import { useTestRole } from "../../test/helpers.js";
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
let productId: string;

const h = (token = adminToken) => authHeaders(token, fixture.storeId);

const vnToday = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());

function dayOffset(days: number): Date {
  const date = new Date(`${vnToday()}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

/** Ngày `day` của tháng sau `monthsAhead` tháng, để test không phụ thuộc hôm nay là ngày mấy. */
function monthDay(monthsAhead: number, day: number): Date {
  const [year, month] = vnToday().split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1 + monthsAhead, day));
}

const monthLabel = (date: Date) =>
  `Tháng ${String(date.getUTCMonth() + 1).padStart(2, "0")}/${date.getUTCFullYear()}`;

async function makeBatch(
  batchNumber: string,
  expiry: number | Date,
  quantity = 100,
  unitCost: number | null = 1000,
) {
  const batch = await prisma.batch.create({
    data: {
      storeId: fixture.storeId,
      productId,
      batchNumber,
      expiryDate: typeof expiry === "number" ? dayOffset(expiry) : expiry,
      quantityOnHand: quantity,
      unitCost,
      shelfLocation: "Kệ A1",
    },
  });
  return batch.id;
}

const list = async (query = "", token = adminToken) =>
  (await api().get(`/api/v1/expiry-alerts${query}`).set(h(token)).expect(200)).body.data;
const row = (data: { items: Array<{ batchNumber: string }> }, batchNumber: string) =>
  data.items.find((item) => item.batchNumber === batchNumber) as
    Record<string, unknown> | undefined;

const plan = (body: Record<string, unknown>, token = pharmacistToken) =>
  api().post("/api/v1/expiry-alerts/plans").set(h(token)).send(body);

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
    expect(data.items.map((item: { batchNumber: string }) => item.batchNumber)).toEqual([
      "HET",
      "D30",
      "D60",
      "D90",
    ]);
    expect(row(data, "HET")).toMatchObject({ bucket: "EXPIRED", daysLeft: -5, stockValue: 10000 });
    expect(row(data, "D30")).toMatchObject({
      bucket: "D30",
      stockValue: 100000,
      baseUnitName: "Viên",
      shelfLocation: "Kệ A1",
    });
    expect(row(data, "D60")).toMatchObject({ bucket: "D60", stockValue: 100000 });
    expect(row(data, "D90")).toMatchObject({ bucket: "D90", stockValue: 60000 });

    expect(data.summary.byBucket.D30).toEqual({
      label: "Còn dưới 30 ngày",
      batches: 1,
      value: 100000,
      withoutPlan: 1,
    });
    expect(data.summary).toMatchObject({
      totalBatches: 4,
      withoutPlan: 4,
      overduePlans: 0,
      totalValue: 270000,
    });
  });

  it("gom theo tháng: hết hạn đứng đầu, tháng gần trước, trong tháng lô còn nhiều hàng trước", async () => {
    await makeBatch("HET_IT", -3, 5);
    await makeBatch("HET_NHIEU", -10, 200);
    await makeBatch("A_GAN", monthDay(1, 2), 10);
    await makeBatch("A_NHIEU", monthDay(1, 28), 500);
    await makeBatch("A_BANG", monthDay(1, 20), 10);
    await makeBatch("B_RAT_NHIEU", monthDay(2, 5), 1000);

    const data = await list();
    // Bằng số lượng thì lô hết hạn sớm hơn trước; tháng sau dù nhiều hàng vẫn đứng sau.
    expect(data.items.map((item: { batchNumber: string }) => item.batchNumber)).toEqual([
      "HET_NHIEU",
      "HET_IT",
      "A_NHIEU",
      "A_GAN",
      "A_BANG",
      "B_RAT_NHIEU",
    ]);
    // Mỗi dòng vẫn có ngày hết hạn và số ngày còn lại.
    expect(row(data, "A_GAN")).toMatchObject({ daysLeft: expect.any(Number) });
    expect(row(data, "A_GAN")!.expiryDate).toBe(monthDay(1, 2).toISOString());

    const nextKey = monthDay(1, 1).toISOString().slice(0, 7);
    expect(row(data, "A_GAN")).toMatchObject({ group: nextKey });
    expect(data.groups).toEqual([
      { key: "EXPIRED", label: "Đã hết hạn", batches: 2, value: 205000, withoutCost: 0 },
      {
        key: nextKey,
        label: monthLabel(monthDay(1, 1)),
        batches: 3,
        value: 520000,
        withoutCost: 0,
      },
      {
        key: monthDay(2, 1).toISOString().slice(0, 7),
        label: monthLabel(monthDay(2, 1)),
        batches: 1,
        value: 1000000,
        withoutCost: 0,
      },
    ]);
  });

  it("chọn sắp trong nhóm theo hạn gần nhất hoặc theo giá trị tồn", async () => {
    await makeBatch("GAN_IT_TIEN", monthDay(1, 3), 10, 100);
    await makeBatch("XA_NHIEU_TIEN", monthDay(1, 25), 10, 9000);
    await makeBatch("NHIEU_HANG", monthDay(1, 15), 300, 10);
    await makeBatch("CHUA_GIA", monthDay(1, 10), 50, null);

    const order = async (sort: string) =>
      (await list(`?sort=${sort}`)).items.map((item: { batchNumber: string }) => item.batchNumber);
    expect(await order("expiry")).toEqual([
      "GAN_IT_TIEN",
      "CHUA_GIA",
      "NHIEU_HANG",
      "XA_NHIEU_TIEN",
    ]);
    // Lô chưa có giá vốn xuống cuối, không coi như giá trị 0.
    expect(await order("value")).toEqual([
      "XA_NHIEU_TIEN",
      "NHIEU_HANG",
      "GAN_IT_TIEN",
      "CHUA_GIA",
    ]);
    expect(await order("quantity")).toEqual([
      "NHIEU_HANG",
      "CHUA_GIA",
      "GAN_IT_TIEN",
      "XA_NHIEU_TIEN",
    ]);

    // Tổng nhóm báo rõ có lô chưa có giá vốn để không coi là đủ.
    expect((await list()).groups[0]).toMatchObject({ batches: 4, value: 94000, withoutCost: 1 });
    await api().get("/api/v1/expiry-alerts?sort=khac").set(h()).expect(422);
  });

  it("nhóm tạo sau khi lọc, nhóm không còn lô nào thì không có", async () => {
    await makeBatch("HET", -2, 10);
    await makeBatch("THANG_SAU", monthDay(1, 10), 20);
    const planned = await makeBatch("CO_KE_HOACH", monthDay(2, 10), 30);
    await plan({ batchId: planned, action: "PRIORITIZE_SALE" }).expect(201);

    const expiredOnly = await list("?bucket=EXPIRED");
    expect(expiredOnly.groups.map((group: { key: string }) => group.key)).toEqual(["EXPIRED"]);

    const withoutPlan = await list("?onlyWithoutPlan=true");
    expect(withoutPlan.groups).toHaveLength(2);
    expect(withoutPlan.groups.map((group: { batches: number }) => group.batches)).toEqual([1, 1]);
    // Thống kê phía trên vẫn tính trên toàn bộ, không theo bộ lọc.
    expect(withoutPlan.summary.totalBatches).toBe(3);
  });

  it("lô hết hạn đúng hôm nay vào nhóm Đã hết hạn, cùng cách tính với quầy bán", async () => {
    await makeBatch("HOMNAY", 0, 12, 1000);
    await makeBatch("MAI", 1, 8, 1000);

    const data = await list();
    expect(row(data, "HOMNAY")).toMatchObject({ bucket: "EXPIRED", daysLeft: 0 });
    expect(row(data, "MAI")).toMatchObject({ bucket: "D30", daysLeft: 1 });
    expect(data.summary.byBucket.EXPIRED).toMatchObject({ batches: 1 });
  });

  it("giá trị tồn chỉ hiện với người có quyền xem giá vốn", async () => {
    await makeBatch("D30", 10, 100, 1000);
    const forPharmacist = await list("", pharmacistToken);
    expect(row(forPharmacist, "D30")).toMatchObject({ stockValue: null });
    expect(forPharmacist.summary.totalValue).toBeNull();
    expect(forPharmacist.groups[0]).toMatchObject({ batches: 1, value: null, withoutCost: 0 });

    // Thứ tự theo giá trị cũng để lộ giá vốn nên API chặn, không chỉ ẩn nút trên trang.
    const bySort = await api()
      .get("/api/v1/expiry-alerts?sort=value")
      .set(h(pharmacistToken))
      .expect(403);
    expect(bySort.body.error.message).toContain("giá vốn");
  });

  it("lọc theo mốc và lọc lô chưa có kế hoạch", async () => {
    await makeBatch("D30", 10);
    await makeBatch("D60", 50);
    const planned = await makeBatch("D30B", 12);
    await plan({
      batchId: planned,
      action: "RETURN_SUPPLIER",
      dueDate: dayOffset(3).toISOString().slice(0, 10),
    }).expect(201);

    expect(
      (await list("?bucket=D30")).items.map((item: { batchNumber: string }) => item.batchNumber),
    ).toEqual(["D30", "D30B"]);
    expect(
      (await list("?onlyWithoutPlan=true")).items.map(
        (item: { batchNumber: string }) => item.batchNumber,
      ),
    ).toEqual(["D30", "D60"]);
    // Tầm nhìn ngắn hơn thì lô xa hơn không còn trong danh sách.
    expect(
      (await list("?horizonDays=30")).items.map(
        (item: { batchNumber: string }) => item.batchNumber,
      ),
    ).toEqual(["D30", "D30B"]);
  });

  it("gợi ý nhà cung cấp của lô để biết gọi ai khi muốn trả hàng", async () => {
    const supplier = await prisma.supplier.create({ data: { name: "Công ty Dược Minh Tâm" } });
    const unit = await prisma.productUnit.findFirstOrThrow({ where: { productId } });
    const receipt = await api()
      .post("/api/v1/goods-receipts")
      .set({ ...h(pharmacistToken), "Idempotency-Key": randomUUID() })
      .send({
        supplierId: supplier.id,
        lines: [
          {
            productId,
            unitId: unit.id,
            quantity: 40,
            unitCost: 900,
            batchNumber: "NCC1",
            expiryDate: dayOffset(45).toISOString().slice(0, 10),
          },
        ],
      })
      .expect(201);
    await api()
      .post(`/api/v1/goods-receipts/${receipt.body.data.id}/confirm`)
      .set({ ...h(pharmacistToken), "Idempotency-Key": randomUUID() })
      .send({
        lines: receipt.body.data.lines.map((line: { id: string }) => ({
          lineId: line.id,
          passed: true,
        })),
      })
      .expect(200);

    expect(row(await list(), "NCC1")).toMatchObject({
      lastSupplier: { name: "Công ty Dược Minh Tâm" },
      quantityOnHand: 40,
    });
  });
});

describe("Kế hoạch xử lý lô cận hạn", () => {
  it("lập kế hoạch, sửa lại và đóng khi xong", async () => {
    const batchId = await makeBatch("D30", 20);

    const created = await plan({
      batchId,
      action: "RETURN_SUPPLIER",
      dueDate: dayOffset(5).toISOString().slice(0, 10),
      note: "Đã gọi NCC, chờ xác nhận",
    }).expect(201);
    const afterCreate = row(await list(), "D30")!;
    expect(afterCreate.plan).toMatchObject({
      action: "RETURN_SUPPLIER",
      status: "PLANNED",
      createdByName: "Dược sĩ",
      overdue: false,
    });
    expect((await list()).summary.withoutPlan).toBe(0);

    // Lập lại cho cùng lô thì cập nhật kế hoạch đang mở, không tạo thêm.
    await plan({ batchId, action: "DISCOUNT", note: "Giảm giá 30% để đẩy hàng" }).expect(201);
    expect(await prisma.batchExpiryPlan.count({ where: { status: "PLANNED" } })).toBe(1);
    expect(row(await list(), "D30")!.plan).toMatchObject({
      action: "DISCOUNT",
      note: "Giảm giá 30% để đẩy hàng",
      version: 2,
    });

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
    const again = await api()
      .post(`/api/v1/expiry-alerts/plans/${created.body.data.id}/close`)
      .set(h(pharmacistToken))
      .send({})
      .expect(409);
    expect(again.body.error.message).toContain("đã đóng rồi");
  });

  it("kế hoạch quá ngày hẹn được đánh dấu để báo lại", async () => {
    const batchId = await makeBatch("D30", 25);
    await plan({
      batchId,
      action: "PRIORITIZE_SALE",
      dueDate: dayOffset(-2).toISOString().slice(0, 10),
    }).expect(201);

    const data = await list();
    expect(row(data, "D30")!.plan).toMatchObject({ overdue: true });
    expect(data.summary.overduePlans).toBe(1);
  });

  it("lịch sử xử lý của lô giữ lại cả kế hoạch đã đóng", async () => {
    const batchId = await makeBatch("D30", 20);
    const first = await plan({ batchId, action: "RETURN_SUPPLIER" }).expect(201);
    await api()
      .post(`/api/v1/expiry-alerts/plans/${first.body.data.id}/close`)
      .set(h(pharmacistToken))
      .send({ status: "CANCELLED", outcome: "NCC không nhận trả" })
      .expect(200);
    await plan({ batchId, action: "DISPOSE", note: "Lên lịch hủy cuối tháng" }).expect(201);

    const history = (
      await api().get(`/api/v1/expiry-alerts/batches/${batchId}/plans`).set(h()).expect(200)
    ).body.data;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ action: "DISPOSE", status: "PLANNED" });
    expect(history[1]).toMatchObject({
      action: "RETURN_SUPPLIER",
      status: "CANCELLED",
      outcome: "NCC không nhận trả",
    });
  });

  it("kiểm tra quyền, lô không thuộc cửa hàng và dữ liệu sai", async () => {
    await useTestRole(fixture.salesId, "auditor", fixture.storeId, []);
    const batchId = await makeBatch("D30", 20);
    await api().get("/api/v1/expiry-alerts").set(h(salesToken)).expect(200);
    await plan({ batchId, action: "DISPOSE" }, salesToken).expect(403);
    await plan({ batchId, action: "KHONG_CO" }).expect(422);
    await plan({ batchId: randomUUID(), action: "DISPOSE" }).expect(404);

    const other = await prisma.batch.create({
      data: {
        storeId: fixture.otherStoreId,
        productId,
        batchNumber: "KHAC",
        expiryDate: dayOffset(10),
        quantityOnHand: 5,
      },
    });
    await plan({ batchId: other.id, action: "DISPOSE" }).expect(404);
    expect(row(await list(), "KHAC")).toBeUndefined();
  });
});
