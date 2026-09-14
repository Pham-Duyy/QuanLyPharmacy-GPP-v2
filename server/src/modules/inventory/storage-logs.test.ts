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
let pharmacistToken: string;
let adminToken: string;
let salesToken: string;
let retailAreaCode: string;
let fridgeCode: string;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  pharmacistToken = (await login("duocsi")).token;
  adminToken = (await login("admin")).token;
  salesToken = (await login("banhang")).token;

  retailAreaCode = "RETAIL_AREA";
  fridgeCode = "FRIDGE";
  await prisma.storageLocation.create({
    data: {
      storeId: fixture.storeId,
      code: retailAreaCode,
      name: "Khu vực bán lẻ",
      maxTempC: 30,
      maxHumidityPercent: 75,
    },
  });
  await prisma.storageLocation.create({
    data: { storeId: fixture.storeId, code: fridgeCode, name: "Tủ lạnh", minTempC: 2, maxTempC: 8 },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function record(body: Record<string, unknown>, token = pharmacistToken) {
  return api().post("/api/v1/storage-logs").set(authHeaders(token, fixture.storeId)).send(body);
}

describe("Ghi sổ nhiệt độ – độ ẩm", () => {
  it("ghi đúng, không vượt ngưỡng", async () => {
    const response = await record({
      location: retailAreaCode,
      recordedAt: new Date().toISOString(),
      temperatureC: 27.5,
      humidityPercent: 60,
    }).expect(201);

    expect(response.body.data).toMatchObject({
      temperatureC: 27.5,
      humidityPercent: 60,
      outOfRange: false,
    });
    expect(response.body.data.storageLocation.code).toBe(retailAreaCode);
  });

  it("tự đánh dấu vượt ngưỡng nhiệt độ", async () => {
    const response = await record({
      location: retailAreaCode,
      recordedAt: new Date().toISOString(),
      temperatureC: 32,
    }).expect(201);

    expect(response.body.data.outOfRange).toBe(true);
  });

  it("tự đánh dấu vượt ngưỡng độ ẩm dù nhiệt độ bình thường", async () => {
    const response = await record({
      location: retailAreaCode,
      recordedAt: new Date().toISOString(),
      temperatureC: 25,
      humidityPercent: 80,
    }).expect(201);

    expect(response.body.data.outOfRange).toBe(true);
  });

  it("tủ lạnh dùng ngưỡng riêng (2–8 độ)", async () => {
    const tooWarm = await record({
      location: fridgeCode,
      recordedAt: new Date().toISOString(),
      temperatureC: 10,
    }).expect(201);
    expect(tooWarm.body.data.outOfRange).toBe(true);

    const ok = await record({
      location: fridgeCode,
      recordedAt: new Date().toISOString(),
      temperatureC: 5,
    }).expect(201);
    expect(ok.body.data.outOfRange).toBe(false);
  });

  it("báo lỗi khi khu vực không tồn tại", async () => {
    const response = await record({
      location: "KHONG_TON_TAI",
      recordedAt: new Date().toISOString(),
      temperatureC: 25,
    }).expect(404);

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("ghi bản sửa trỏ đúng correctsLogId, không đổi bản gốc", async () => {
    const original = await record({
      location: retailAreaCode,
      recordedAt: new Date().toISOString(),
      temperatureC: 99,
    }).expect(201);

    const correction = await record({
      location: retailAreaCode,
      recordedAt: new Date().toISOString(),
      temperatureC: 26,
      correctsLogId: original.body.data.id,
    }).expect(201);

    expect(correction.body.data.correctsLogId).toBe(original.body.data.id);

    const list = await api()
      .get("/api/v1/storage-logs")
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .expect(200);
    expect(list.body.data).toHaveLength(2);
  });

  it("nhân viên bán hàng không có quyền ghi sổ", async () => {
    const response = await record(
      { location: retailAreaCode, recordedAt: new Date().toISOString(), temperatureC: 25 },
      salesToken,
    ).expect(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});

describe("Xem sổ nhiệt độ – độ ẩm", () => {
  it("lọc theo khu vực và outOfRange", async () => {
    await record({
      location: retailAreaCode,
      recordedAt: new Date().toISOString(),
      temperatureC: 25,
    });
    await record({
      location: retailAreaCode,
      recordedAt: new Date().toISOString(),
      temperatureC: 33,
    });
    await record({ location: fridgeCode, recordedAt: new Date().toISOString(), temperatureC: 5 });

    const response = await api()
      .get("/api/v1/storage-logs")
      .query({ location: retailAreaCode, outOfRange: "true" })
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].temperatureC).toBe(33);
  });

  it("không thấy sổ của cửa hàng khác", async () => {
    await record({
      location: retailAreaCode,
      recordedAt: new Date().toISOString(),
      temperatureC: 25,
    });

    const response = await api()
      .get("/api/v1/storage-logs")
      .set(authHeaders(adminToken, fixture.otherStoreId))
      .expect(200);

    expect(response.body.data).toHaveLength(0);
  });
});

describe("Tổng hợp theo tháng", () => {
  it("đánh dấu đúng số lần đo và ngày có vượt ngưỡng", async () => {
    // Server ghi businessDate theo giờ Việt Nam (Asia/Ho_Chi_Minh), không
    // phải ngày UTC — dùng cùng cách quy đổi ở đây, nếu không test sẽ chập
    // chờn khoảng 17:00–23:59 UTC mỗi ngày (đã lúc đó là ngày mới ở VN).
    const now = new Date();
    const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(now);
    const month = todayKey.slice(0, 7);

    await record({ location: retailAreaCode, recordedAt: now.toISOString(), temperatureC: 25 });
    await record({ location: retailAreaCode, recordedAt: now.toISOString(), temperatureC: 33 });

    const response = await api()
      .get("/api/v1/storage-logs/summary")
      .query({ month })
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    const retail = response.body.data.find(
      (row: { locationCode: string }) => row.locationCode === retailAreaCode,
    );
    const day = retail.days.find((d: { businessDate: string }) => d.businessDate === todayKey);

    expect(day).toMatchObject({ count: 2, expectedCount: 2, hasOutOfRange: true });

    const fridge = response.body.data.find(
      (row: { locationCode: string }) => row.locationCode === fridgeCode,
    );
    const fridgeDay = fridge.days.find(
      (d: { businessDate: string }) => d.businessDate === todayKey,
    );
    expect(fridgeDay).toMatchObject({ count: 0, hasOutOfRange: false });
  });

  it("báo lỗi khi month sai định dạng", async () => {
    const response = await api()
      .get("/api/v1/storage-logs/summary")
      .query({ month: "2026" })
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});
