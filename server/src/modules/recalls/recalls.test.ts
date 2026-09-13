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
let categoryId: string;
let productId: string;
let unitId: string;

function idem(): Record<string, string> {
  return { "Idempotency-Key": randomUUID() };
}

function dayOffset(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return new Date(date.toISOString().slice(0, 10));
}

async function makeBatch(batchNumber: string, quantity: number, status = "AVAILABLE") {
  const batch = await prisma.batch.create({
    data: {
      storeId: fixture.storeId,
      productId,
      batchNumber,
      expiryDate: dayOffset(365),
      quantityOnHand: quantity,
      status,
    },
  });
  return batch.id;
}

function createRecall(body: Record<string, unknown>) {
  return api()
    .post("/api/v1/recalls")
    .set({ ...authHeaders(adminToken), ...idem() })
    .send(body);
}

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
  salesToken = (await login("banhang")).token;

  categoryId = (await prisma.category.create({ data: { name: "Thuốc" } })).id;
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
    data: {
      productUnitId: unitId,
      salePrice: 1000n,
      vatRatePercent: 5,
      effectiveFrom: dayOffset(-1),
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Tạo thông báo thu hồi", () => {
  it("chuyển lô AVAILABLE và QUARANTINED khớp sang RECALLED", async () => {
    const available = await makeBatch("L1", 50, "AVAILABLE");
    const quarantined = await makeBatch("L2", 30, "QUARANTINED");
    const untouched = await makeBatch("L3", 20, "AVAILABLE");

    const response = await createRecall({
      documentNumber: "CV-001",
      issuedBy: "Cục Quản lý Dược",
      issuedAt: dayOffset(-1).toISOString(),
      reason: "Phát hiện tạp chất",
      items: [
        { productId, batchNumber: "L1" },
        { productId, batchNumber: "L2" },
      ],
    }).expect(201);

    expect(response.body.data.status).toBe("OPEN");
    expect(response.body.data.remainingBaseQuantity).toBe(80);

    const batches = await prisma.batch.findMany({ where: { productId } });
    const byId = new Map(batches.map((batch) => [batch.id, batch]));
    expect(byId.get(available)?.status).toBe("RECALLED");
    expect(byId.get(quarantined)?.status).toBe("RECALLED");
    expect(byId.get(untouched)?.status).toBe("AVAILABLE");
  });

  it("vẫn ghi lại số lô không có trong kho để đối chiếu", async () => {
    const response = await createRecall({
      documentNumber: "CV-002",
      issuedAt: new Date().toISOString(),
      items: [{ productId, batchNumber: "KHONG_TON_TAI" }],
    }).expect(201);

    expect(response.body.data.items).toEqual([
      expect.objectContaining({ batchNumber: "KHONG_TON_TAI", foundInStock: false }),
    ]);
  });

  it("lô đã RECALLED từ trước không bị đụng tới lại và không lỗi", async () => {
    await makeBatch("L1", 10, "RECALLED");

    const response = await createRecall({
      documentNumber: "CV-003",
      issuedAt: new Date().toISOString(),
      items: [{ productId, batchNumber: "L1" }],
    }).expect(201);

    expect(response.body.data.items[0].foundInStock).toBe(false);
  });

  it("lô bị thu hồi biến mất khỏi lựa chọn FEFO khi bán", async () => {
    await makeBatch("L1", 100, "AVAILABLE");
    await createRecall({
      documentNumber: "CV-004",
      issuedAt: new Date().toISOString(),
      items: [{ productId, batchNumber: "L1" }],
    }).expect(201);

    const response = await api()
      .post("/api/v1/sales/safety-check")
      .set(authHeaders(adminToken, fixture.storeId))
      .send({ lines: [{ productId, unitId, quantity: 5 }] })
      .expect(200);

    expect(response.body.data.blocking).toContainEqual(
      expect.objectContaining({ code: "INSUFFICIENT_STOCK", productId }),
    );
  });

  it("chặn trùng số công văn", async () => {
    await createRecall({
      documentNumber: "CV-005",
      issuedAt: new Date().toISOString(),
      items: [{ productId, batchNumber: "L1" }],
    }).expect(201);

    const response = await createRecall({
      documentNumber: "CV-005",
      issuedAt: new Date().toISOString(),
      items: [{ productId, batchNumber: "L2" }],
    }).expect(409);

    expect(response.body.error.code).toBe("DUPLICATE");
  });

  it("chặn người không có quyền recall.manage", async () => {
    const response = await api()
      .post("/api/v1/recalls")
      .set({ ...authHeaders(salesToken), ...idem() })
      .send({
        documentNumber: "CV-006",
        issuedAt: new Date().toISOString(),
        items: [{ productId, batchNumber: "L1" }],
      })
      .expect(403);

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("yêu cầu Idempotency-Key", async () => {
    const response = await api()
      .post("/api/v1/recalls")
      .set(authHeaders(adminToken))
      .send({
        documentNumber: "CV-007",
        issuedAt: new Date().toISOString(),
        items: [{ productId, batchNumber: "L1" }],
      })
      .expect(400);

    expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});

describe("Đóng thông báo thu hồi", () => {
  it("chặn đóng khi các lô bị thu hồi còn tồn", async () => {
    await makeBatch("L1", 40, "AVAILABLE");
    const created = await createRecall({
      documentNumber: "CV-010",
      issuedAt: new Date().toISOString(),
      items: [{ productId, batchNumber: "L1" }],
    }).expect(201);

    const response = await api()
      .post(`/api/v1/recalls/${created.body.data.id}/close`)
      .set({ ...authHeaders(adminToken), ...idem() })
      .send({})
      .expect(409);

    expect(response.body.error.code).toBe("INVALID_STATE");
    expect(response.body.error.details[0]).toMatchObject({ remainingBaseQuantity: 40 });
  });

  it("đóng được khi lô đã bán hết trước lúc thu hồi", async () => {
    await makeBatch("L1", 0, "AVAILABLE");
    const created = await createRecall({
      documentNumber: "CV-011",
      issuedAt: new Date().toISOString(),
      items: [{ productId, batchNumber: "L1" }],
    }).expect(201);

    const response = await api()
      .post(`/api/v1/recalls/${created.body.data.id}/close`)
      .set({ ...authHeaders(adminToken), ...idem() })
      .send({})
      .expect(200);

    expect(response.body.data.status).toBe("CLOSED");
  });

  it("không đóng lại được thu hồi đã đóng", async () => {
    await makeBatch("L1", 0, "AVAILABLE");
    const created = await createRecall({
      documentNumber: "CV-012",
      issuedAt: new Date().toISOString(),
      items: [{ productId, batchNumber: "L1" }],
    }).expect(201);

    await api()
      .post(`/api/v1/recalls/${created.body.data.id}/close`)
      .set({ ...authHeaders(adminToken), ...idem() })
      .send({})
      .expect(200);

    const response = await api()
      .post(`/api/v1/recalls/${created.body.data.id}/close`)
      .set({ ...authHeaders(adminToken), ...idem() })
      .send({})
      .expect(409);

    expect(response.body.error.code).toBe("INVALID_STATE");
  });
});

describe("Khách hàng bị ảnh hưởng bởi thu hồi", () => {
  it("liệt kê đúng hóa đơn đã bán từ lô bị thu hồi và ghi audit mỗi lần xem", async () => {
    const batchId = await makeBatch("L1", 100, "AVAILABLE");
    const customer = await prisma.customer.create({
      data: { fullName: "Nguyễn Văn A", phone: "0900000001" },
    });

    const sale = await api()
      .post("/api/v1/invoices")
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({ customerId: customer.id, lines: [{ productId, unitId, quantity: 10 }] })
      .expect(201);

    // Lô còn 90, phải thu hồi hết mới đóng được — ở đây chỉ kiểm tra danh sách bị ảnh hưởng.
    const created = await createRecall({
      documentNumber: "CV-020",
      issuedAt: new Date().toISOString(),
      items: [{ productId, batchNumber: "L1" }],
    }).expect(201);

    const response = await api()
      .get(`/api/v1/recalls/${created.body.data.id}/affected-sales`)
      .set(authHeaders(adminToken))
      .expect(200);

    expect(response.body.data).toEqual([
      expect.objectContaining({
        invoiceId: sale.body.data.id,
        batchNumber: "L1",
        baseQuantity: 10,
        customer: expect.objectContaining({ id: customer.id, fullName: "Nguyễn Văn A" }),
      }),
    ]);

    const auditRows = await prisma.auditLog.findMany({
      where: { action: "RECALL_AFFECTED_SALES_VIEW", resourceId: created.body.data.id },
    });
    expect(auditRows).toHaveLength(1);
    expect(batchId).toBeTruthy();
  });
});
