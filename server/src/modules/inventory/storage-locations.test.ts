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

/**
 * Trước đây khu vực bảo quản chỉ có từ dữ liệu mẫu: cửa hàng mở sau (TH005 của
 * dữ liệu mô phỏng) không có khu nào nên không ghi được sổ nhiệt độ – độ ẩm.
 */
let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
  pharmacistToken = (await login("duocsi")).token;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const h = (token: string, storeId = fixture.storeId) => authHeaders(token, storeId);
const locations = async (token = adminToken) =>
  (await api().get("/api/v1/storage-locations").set(h(token)).expect(200)).body.data;
const record = (location: string, temperatureC: number) =>
  api()
    .post("/api/v1/storage-logs")
    .set(h(pharmacistToken))
    .send({ location, recordedAt: new Date().toISOString(), temperatureC });

describe("Khu vực bảo quản", () => {
  it("cửa hàng chưa có khu: chủ nhà thuốc tạo hai khu mặc định một lần", async () => {
    expect(await locations(pharmacistToken)).toEqual([]);

    const created = await api()
      .post("/api/v1/storage-locations/defaults")
      .set(h(adminToken))
      .expect(201);
    expect(created.body.data).toMatchObject([
      { code: "FRIDGE", minTempC: 2, maxTempC: 8, maxHumidityPercent: null, isActive: true },
      { code: "RETAIL_AREA", minTempC: null, maxTempC: 30, maxHumidityPercent: 75 },
    ]);
    await api().post("/api/v1/storage-locations/defaults").set(h(adminToken)).expect(409);

    // Có khu rồi thì ghi sổ được ngay.
    await record("RETAIL_AREA", 27).expect(201);
    expect(await prisma.auditLog.count({ where: { action: "STORAGE_LOCATION_CREATE" } })).toBe(1);
  });

  it("dược sĩ xem được khu nhưng không thêm, không sửa", async () => {
    await api().post("/api/v1/storage-locations/defaults").set(h(pharmacistToken)).expect(403);
    await api()
      .post("/api/v1/storage-locations")
      .set(h(pharmacistToken))
      .send({ name: "Tủ mát" })
      .expect(403);
    const [fridge] = (
      await api().post("/api/v1/storage-locations/defaults").set(h(adminToken)).expect(201)
    ).body.data;
    await api()
      .patch(`/api/v1/storage-locations/${fridge.id}`)
      .set(h(pharmacistToken))
      .send({ maxTempC: 10 })
      .expect(403);
  });

  it("thêm khu tự đặt mã; ngưỡng mới áp cho lần đo sau; ngưng dùng thì không ghi sổ", async () => {
    const first = await api()
      .post("/api/v1/storage-locations")
      .set(h(adminToken))
      .send({ name: "Tủ mát vắc-xin", minTempC: 2, maxTempC: 8 })
      .expect(201);
    expect(first.body.data).toMatchObject({ code: "KV01", name: "Tủ mát vắc-xin" });
    const second = await api()
      .post("/api/v1/storage-locations")
      .set(h(adminToken))
      .send({ name: "Kho phụ", maxTempC: 30, maxHumidityPercent: 75 })
      .expect(201);
    expect(second.body.data.code).toBe("KV02");

    const before = await record("KV01", 9).expect(201);
    expect(before.body.data.outOfRange).toBe(true);

    const id = first.body.data.id as string;
    await api()
      .patch(`/api/v1/storage-locations/${id}`)
      .set(h(adminToken))
      .send({ maxTempC: 10 })
      .expect(200);
    const after = await record("KV01", 9).expect(201);
    expect(after.body.data.outOfRange).toBe(false);
    // Lần đo cũ giữ nguyên kết luận lúc ghi.
    const old = await prisma.storageLog.findUniqueOrThrow({
      where: { id: BigInt(before.body.data.id) },
    });
    expect(old.outOfRange).toBe(true);

    await api()
      .patch(`/api/v1/storage-locations/${id}`)
      .set(h(adminToken))
      .send({ minTempC: 12 })
      .expect(422);

    await api()
      .patch(`/api/v1/storage-locations/${id}`)
      .set(h(adminToken))
      .send({ isActive: false })
      .expect(200);
    await record("KV01", 5).expect(404);
    const list = await locations();
    expect(
      list.map((item: { code: string; isActive: boolean }) => [item.code, item.isActive]),
    ).toEqual([
      ["KV02", true],
      ["KV01", false],
    ]);
    // Lần sửa bị từ chối (422) không ghi nhật ký.
    expect(await prisma.auditLog.count({ where: { action: "STORAGE_LOCATION_UPDATE" } })).toBe(2);
  });

  it("không sửa được khu của cửa hàng khác", async () => {
    const other = await prisma.storageLocation.create({
      data: { storeId: fixture.otherStoreId, code: "KV01", name: "Khu cửa hàng khác" },
    });
    await api()
      .patch(`/api/v1/storage-locations/${other.id}`)
      .set(h(adminToken))
      .send({ name: "Đổi tên" })
      .expect(404);
  });

  it("mở cửa hàng mới thì có sẵn hai khu mặc định", async () => {
    const created = await api()
      .post("/api/v1/stores")
      .set(h(adminToken))
      .send({ code: "nt09", name: "Nhà thuốc chi nhánh 9" })
      .expect(201);
    const storeId = created.body.data.id as string;
    const list = (
      await api().get("/api/v1/storage-locations").set(h(adminToken, storeId)).expect(200)
    ).body.data;
    expect(list.map((item: { code: string }) => item.code)).toEqual(["FRIDGE", "RETAIL_AREA"]);
  });
});
