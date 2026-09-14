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
let salesToken: string;
let productId: string;

function idem(): Record<string, string> {
  return { "Idempotency-Key": randomUUID() };
}

async function makeBatch(batchNumber: string) {
  const expiryDate = new Date();
  expiryDate.setUTCFullYear(expiryDate.getUTCFullYear() + 1);
  return prisma.batch.create({
    data: { storeId: fixture.storeId, productId, batchNumber, expiryDate, quantityOnHand: 50 },
  });
}

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
  salesToken = (await login("banhang")).token;

  const categoryId = (await prisma.category.create({ data: { name: "Thuốc" } })).id;
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

describe("Xem audit log", () => {
  it("thấy đúng bản ghi do nghiệp vụ thật tạo ra, lọc theo resourceType/action", async () => {
    const batch = await makeBatch("L1");
    await api()
      .post(`/api/v1/inventory/batches/${batch.id}/quarantine`)
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({ reason: "Bao bì rách, chờ kiểm tra", version: batch.version })
      .expect(200);

    const response = await api()
      .get("/api/v1/audit-logs")
      .query({ resourceType: "batch", action: "BATCH_QUARANTINE" })
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0]).toMatchObject({
      action: "BATCH_QUARANTINE",
      resourceType: "batch",
      resourceId: batch.id,
      reason: "Bao bì rách, chờ kiểm tra",
    });
    expect(response.body.data.items[0].actorName).toBeTruthy();
  });

  it("lọc theo actorId", async () => {
    await api()
      .post("/api/v1/users")
      .set(authHeaders(adminToken, fixture.storeId))
      .send({ username: "nhanvienmoi", fullName: "Nhân viên mới" })
      .expect(201);

    const admin = await prisma.user.findUniqueOrThrow({ where: { username: "admin" } });
    const response = await api()
      .get("/api/v1/audit-logs")
      .query({ actorId: admin.id, action: "USER_CREATE" })
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].action).toBe("USER_CREATE");
  });

  it("phân trang theo con trỏ, mới nhất trước", async () => {
    for (let i = 0; i < 5; i++) {
      await api()
        .post("/api/v1/users")
        .set(authHeaders(adminToken, fixture.storeId))
        .send({ username: `nv${i}`, fullName: `Nhân viên ${i}` })
        .expect(201);
    }

    const first = await api()
      .get("/api/v1/audit-logs")
      .query({ action: "USER_CREATE", limit: 2 })
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);
    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.nextCursor).toBeTruthy();

    const second = await api()
      .get("/api/v1/audit-logs")
      .query({ action: "USER_CREATE", limit: 2, cursor: first.body.data.nextCursor })
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);
    expect(second.body.data.items).toHaveLength(2);
    expect(second.body.data.items[0].id).not.toBe(first.body.data.items[0].id);
  });

  it("nhân viên bán hàng không có quyền xem audit log", async () => {
    const response = await api()
      .get("/api/v1/audit-logs")
      .set(authHeaders(salesToken, fixture.storeId))
      .expect(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});
