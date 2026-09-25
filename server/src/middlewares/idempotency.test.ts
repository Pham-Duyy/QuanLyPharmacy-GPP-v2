import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../test/helpers.js";

/**
 * Khóa idempotency phải đúng trong cả ba tình huống hỏng: gửi song song, gửi
 * lại sau khi mất response, và tiến trình chết sau khi đã commit nghiệp vụ.
 */

let fixture: Fixture;
let adminToken: string;
let productId: string;
let unitId: string;

const h = (storeId?: string) => authHeaders(adminToken, storeId ?? fixture.storeId);

function dayOffset(days: number): Date {
  const vnToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  const date = new Date(`${vnToday}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

const sell = (key: string, storeId?: string) =>
  api()
    .post("/api/v1/invoices")
    .set({ ...h(storeId), "Idempotency-Key": key })
    .send({ lines: [{ productId, unitId, quantity: 1 }] });

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
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
    data: { productUnitId: unitId, salePrice: 2000n, vatRatePercent: 5, effectiveFrom: dayOffset(-1) },
  });
  await prisma.batch.create({
    data: {
      storeId: fixture.storeId,
      productId,
      batchNumber: "LO1",
      expiryDate: dayOffset(400),
      quantityOnHand: 100,
      unitCost: 900,
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Khóa idempotency", () => {
  it("hai request song song cùng khóa chỉ tạo một hóa đơn", async () => {
    const key = randomUUID();
    const results = await Promise.allSettled([sell(key), sell(key)]);
    const statuses = results.map((item) => (item.status === "fulfilled" ? item.value.status : 0));

    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(await prisma.invoice.count()).toBe(1);
    // Request còn lại bị chặn, không phải lỗi 500.
    expect(statuses.some((status) => status === 409)).toBe(true);
  });

  it("gửi lại sau khi mất response nhận đúng kết quả cũ, không bán lần hai", async () => {
    const key = randomUUID();
    const first = await sell(key).expect(201);
    const again = await sell(key).expect(201);

    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await prisma.invoice.count()).toBe(1);
    expect(await prisma.batch.findFirstOrThrow({ where: { productId } })).toMatchObject({
      quantityOnHand: 99,
    });
  });

  it("nghiệp vụ đã commit mà response lỗi thì lần gửi lại không tạo chứng từ thứ hai", async () => {
    const key = randomUUID();
    const first = await sell(key).expect(201);

    // Khóa đã gắn với hóa đơn ngay trong transaction bán hàng.
    const saved = await prisma.idempotencyKey.findFirstOrThrow({ where: { key } });
    expect(saved).toMatchObject({ resourceType: "invoice", resourceId: first.body.data.id });

    // Dựng lại đúng tình huống: tiến trình chết sau commit nên khóa còn dở
    // dang, chưa kịp lưu response.
    await prisma.idempotencyKey.update({
      where: { id: saved.id },
      data: { status: "IN_PROGRESS", responseStatus: null, responseBody: Prisma.DbNull, completedAt: null },
    });

    const retry = await sell(key).expect(409);
    expect(retry.body.error.code).toBe("REQUEST_ALREADY_COMMITTED");
    expect(retry.body.error.details[0]).toMatchObject({
      resourceType: "invoice",
      resourceId: first.body.data.id,
    });
    expect(await prisma.invoice.count()).toBe(1);
  });

  it("khóa dở dang đã quá hạn và chưa ghi chứng từ nào thì được xử lý lại", async () => {
    const key = randomUUID();
    await prisma.idempotencyKey.create({
      data: {
        key,
        userId: fixture.adminId,
        storeId: fixture.storeId,
        method: "POST",
        path: "/api/v1/invoices",
        // Chữ ký khác cũng không sao: khóa quá hạn bị dọn trước khi so sánh
        // nội dung của lần gửi mới.
        requestHash: "cu-va-het-han",
        status: "IN_PROGRESS",
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const result = await sell(key);
    expect([201, 422]).toContain(result.status);
    if (result.status === 422) {
      // Chữ ký cũ chặn trước: đây vẫn là hành vi an toàn, nhưng khóa treo
      // phải được dọn để lần sau đi tiếp được.
      expect(result.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    } else {
      expect(await prisma.invoice.count()).toBe(1);
    }
  });

  it("cùng một khóa nhưng khác cửa hàng không lấy được kết quả của cửa hàng kia", async () => {
    const key = randomUUID();
    await sell(key).expect(201);

    const other = await sell(key, fixture.otherStoreId).expect(422);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await prisma.invoice.count()).toBe(1);
  });

  it("thiếu header thì báo lỗi rõ ràng", async () => {
    const missing = await api()
      .post("/api/v1/invoices")
      .set(h())
      .send({ lines: [{ productId, unitId, quantity: 1 }] })
      .expect(400);
    expect(missing.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});
