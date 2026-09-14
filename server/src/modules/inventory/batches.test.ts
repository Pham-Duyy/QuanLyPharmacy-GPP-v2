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
let pharmacistToken: string;
let productId: string;

function idem(): Record<string, string> {
  return { "Idempotency-Key": randomUUID() };
}

async function makeBatch(
  status: "AVAILABLE" | "QUARANTINED" | "RECALLED" = "AVAILABLE",
  storeId = fixture.storeId,
  unitCost: number | null = null,
) {
  const expiryDate = new Date();
  expiryDate.setUTCFullYear(expiryDate.getUTCFullYear() + 1);
  return prisma.batch.create({
    data: {
      storeId,
      productId,
      batchNumber: `L-${randomUUID().slice(0, 8)}`,
      expiryDate,
      quantityOnHand: 50,
      status,
      unitCost,
    },
  });
}

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
  salesToken = (await login("banhang")).token;
  pharmacistToken = (await login("duocsi")).token;

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

describe("Danh sách lô", () => {
  it("chỉ thấy lô của cửa hàng đang chọn", async () => {
    await makeBatch("AVAILABLE", fixture.storeId);
    await makeBatch("AVAILABLE", fixture.otherStoreId);

    const response = await api()
      .get("/api/v1/inventory/batches")
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    expect(response.body.data.items).toHaveLength(1);
  });

  it("lọc theo trạng thái", async () => {
    await makeBatch("AVAILABLE");
    await makeBatch("QUARANTINED");

    const response = await api()
      .get("/api/v1/inventory/batches")
      .query({ status: "QUARANTINED" })
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].status).toBe("QUARANTINED");
  });

  it("chỉ trả giá vốn cho người có quyền stock.cost.read", async () => {
    await makeBatch("AVAILABLE", fixture.storeId, 85000);

    const admin = await api()
      .get("/api/v1/inventory/batches")
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);
    expect(admin.body.data.items[0].unitCost).toBe(85000);

    // Dược sĩ có stock.read (thấy được lô) nhưng không có stock.cost.read.
    const pharmacist = await api()
      .get("/api/v1/inventory/batches")
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .expect(200);
    expect(pharmacist.body.data.items[0]).not.toHaveProperty("unitCost");
  });
});

describe("Biệt trữ lô", () => {
  it("chuyển AVAILABLE sang QUARANTINED, ghi audit log", async () => {
    const batch = await makeBatch("AVAILABLE");

    const response = await api()
      .post(`/api/v1/inventory/batches/${batch.id}/quarantine`)
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({ reason: "Bao bì rách, chờ kiểm tra", version: batch.version })
      .expect(200);

    expect(response.body.data.status).toBe("QUARANTINED");

    const updated = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(updated.status).toBe("QUARANTINED");
    expect(updated.version).toBe(batch.version + 1);

    const auditEntry = await prisma.auditLog.findFirst({ where: { resourceId: batch.id } });
    expect(auditEntry).toMatchObject({ action: "BATCH_QUARANTINE", resourceType: "batch" });
  });

  it("chặn khi lô không ở trạng thái AVAILABLE", async () => {
    const batch = await makeBatch("QUARANTINED");

    const response = await api()
      .post(`/api/v1/inventory/batches/${batch.id}/quarantine`)
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({ reason: "Thử biệt trữ lại", version: batch.version })
      .expect(409);

    expect(response.body.error.code).toBe("INVALID_STATE");
  });

  it("chặn khi version không khớp", async () => {
    const batch = await makeBatch("AVAILABLE");

    const response = await api()
      .post(`/api/v1/inventory/batches/${batch.id}/quarantine`)
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({ reason: "Bao bì rách, chờ kiểm tra", version: batch.version + 1 })
      .expect(409);

    expect(response.body.error.code).toBe("VERSION_CONFLICT");
  });

  it("bắt buộc ghi lý do tối thiểu 3 ký tự", async () => {
    const batch = await makeBatch("AVAILABLE");

    const response = await api()
      .post(`/api/v1/inventory/batches/${batch.id}/quarantine`)
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({ reason: "a", version: batch.version })
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("yêu cầu Idempotency-Key", async () => {
    const batch = await makeBatch("AVAILABLE");

    const response = await api()
      .post(`/api/v1/inventory/batches/${batch.id}/quarantine`)
      .set(authHeaders(adminToken, fixture.storeId))
      .send({ reason: "Bao bì rách, chờ kiểm tra", version: batch.version })
      .expect(400);

    expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("nhân viên bán hàng không có quyền biệt trữ", async () => {
    const batch = await makeBatch("AVAILABLE");

    const response = await api()
      .post(`/api/v1/inventory/batches/${batch.id}/quarantine`)
      .set({ ...authHeaders(salesToken, fixture.storeId), ...idem() })
      .send({ reason: "Bao bì rách, chờ kiểm tra", version: batch.version })
      .expect(403);

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("không thấy hoặc thao tác được lô của cửa hàng khác", async () => {
    const batch = await makeBatch("AVAILABLE", fixture.otherStoreId);

    const response = await api()
      .post(`/api/v1/inventory/batches/${batch.id}/quarantine`)
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({ reason: "Bao bì rách, chờ kiểm tra", version: batch.version })
      .expect(404);

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});

describe("Mở biệt trữ lô", () => {
  it("chuyển QUARANTINED về AVAILABLE, ghi audit log", async () => {
    const batch = await makeBatch("QUARANTINED");

    const response = await api()
      .post(`/api/v1/inventory/batches/${batch.id}/release`)
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({ reason: "Đã kiểm tra, hàng đạt yêu cầu", version: batch.version })
      .expect(200);

    expect(response.body.data.status).toBe("AVAILABLE");

    const auditEntry = await prisma.auditLog.findFirst({ where: { resourceId: batch.id } });
    expect(auditEntry).toMatchObject({ action: "BATCH_RELEASE", resourceType: "batch" });
  });

  it("chặn khi lô không ở trạng thái QUARANTINED", async () => {
    const batch = await makeBatch("AVAILABLE");

    const response = await api()
      .post(`/api/v1/inventory/batches/${batch.id}/release`)
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({ reason: "Đã kiểm tra, hàng đạt yêu cầu", version: batch.version })
      .expect(409);

    expect(response.body.error.code).toBe("INVALID_STATE");
  });

  it("lô đã thu hồi (RECALLED) không mở biệt trữ được", async () => {
    const batch = await makeBatch("RECALLED");

    const response = await api()
      .post(`/api/v1/inventory/batches/${batch.id}/release`)
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({ reason: "Thử mở lại", version: batch.version })
      .expect(409);

    expect(response.body.error.code).toBe("INVALID_STATE");
  });
});
