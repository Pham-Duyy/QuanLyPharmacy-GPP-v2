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

function idem(): Record<string, string> {
  return { "Idempotency-Key": randomUUID() };
}

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
  pharmacistToken = (await login("duocsi")).token;
  salesToken = (await login("banhang")).token;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createCustomer(overrides: Record<string, unknown> = {}) {
  const response = await api()
    .post("/api/v1/customers")
    .set(authHeaders(salesToken))
    .send({ fullName: "Nguyễn Văn A", phone: "0901234567", ...overrides })
    .expect(201);
  return response.body.data.id as string;
}

describe("Tìm kiếm khách hàng", () => {
  it("tìm theo tên không dấu, che bớt số điện thoại", async () => {
    await createCustomer({ fullName: "Nguyễn Thị Hoa", phone: "0901234567" });

    const response = await api()
      .get("/api/v1/customers")
      .query({ search: "hoa" }) // gõ không dấu vẫn ra "Hoa"
      .set(authHeaders(pharmacistToken))
      .expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].fullName).toBe("Nguyễn Thị Hoa");
    expect(response.body.data[0].phone).toBe("090****567");
  });

  it("tìm theo số điện thoại", async () => {
    await createCustomer({ fullName: "Trần Văn B", phone: "0987654321" });

    const response = await api()
      .get("/api/v1/customers")
      .query({ search: "0987654321" })
      .set(authHeaders(pharmacistToken))
      .expect(200);

    expect(response.body.data).toHaveLength(1);
  });

  it("bắt buộc gõ ít nhất 3 ký tự", async () => {
    const response = await api()
      .get("/api/v1/customers")
      .query({ search: "ab" })
      .set(authHeaders(pharmacistToken))
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("không cần X-Store-Id vì khách hàng dùng chung toàn chuỗi", async () => {
    await createCustomer();
    await api()
      .get("/api/v1/customers")
      .query({ search: "Nguyễn" })
      .set(authHeaders(pharmacistToken)) // không có storeId
      .expect(200);
  });
});

describe("Tạo và sửa khách hàng", () => {
  it("xem chi tiết thấy đầy đủ số điện thoại, không che", async () => {
    const id = await createCustomer({ phone: "0901234567" });

    const response = await api()
      .get(`/api/v1/customers/${id}`)
      .set(authHeaders(salesToken))
      .expect(200);

    expect(response.body.data.phone).toBe("0901234567");
  });

  it("sửa được thông tin cơ bản, đúng version", async () => {
    const id = await createCustomer();
    const before = await api().get(`/api/v1/customers/${id}`).set(authHeaders(salesToken));

    const response = await api()
      .patch(`/api/v1/customers/${id}`)
      .set(authHeaders(salesToken))
      .send({ version: before.body.data.version, note: "Khách quen" })
      .expect(200);

    expect(response.body.data.note).toBe("Khách quen");
    expect(response.body.data.version).toBe(before.body.data.version + 1);
  });

  it("chặn khi version không khớp", async () => {
    const id = await createCustomer();
    const response = await api()
      .patch(`/api/v1/customers/${id}`)
      .set(authHeaders(salesToken))
      .send({ version: 999, note: "..." })
      .expect(409);

    expect(response.body.error.code).toBe("VERSION_CONFLICT");
  });

  it("chặn tạo khách khi chưa đăng nhập", async () => {
    // admin/pharmacist/sales_staff trong fixture đều có customer.manage,
    // nên phép thử ngắn nhất cho cổng permission ở đây là bỏ hẳn token.
    const response = await api()
      .post("/api/v1/customers")
      .send({ fullName: "Không token" })
      .expect(401);

    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });
});

describe("Hồ sơ sức khỏe — permission tách biệt với customer.read/manage", () => {
  it("admin và nhân viên bán hàng không xem được hồ sơ sức khỏe", async () => {
    const id = await createCustomer();

    for (const token of [adminToken, salesToken]) {
      const response = await api()
        .get(`/api/v1/customers/${id}/health-profile`)
        .set(authHeaders(token))
        .expect(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }
  });

  it("chặn lưu hồ sơ sức khỏe khi chưa ghi nhận đồng ý của khách", async () => {
    const id = await createCustomer();
    const ingredient = await prisma.activeIngredient.create({ data: { name: "Paracetamol" } });

    const response = await api()
      .patch(`/api/v1/customers/${id}/health-profile`)
      .set(authHeaders(pharmacistToken))
      .send({ allergies: [{ ingredientId: ingredient.id }] })
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("dược sĩ ghi nhận đồng ý và lưu dị ứng, có ghi audit", async () => {
    const id = await createCustomer();
    const ingredient = await prisma.activeIngredient.create({ data: { name: "Penicillin" } });

    const response = await api()
      .patch(`/api/v1/customers/${id}/health-profile`)
      .set(authHeaders(pharmacistToken))
      .send({
        consent: true,
        chronicConditions: "Tiểu đường type 2",
        allergies: [{ ingredientId: ingredient.id, note: "Nổi mề đay" }],
      })
      .expect(200);

    expect(response.body.data.hasHealthConsent).toBe(true);
    expect(response.body.data.chronicConditions).toBe("Tiểu đường type 2");
    expect(response.body.data.allergies).toEqual([
      expect.objectContaining({ ingredientId: ingredient.id, ingredientName: "Penicillin" }),
    ]);

    const auditRows = await prisma.auditLog.findMany({
      where: { resourceType: "customer", resourceId: id },
    });
    expect(auditRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["CUSTOMER_HEALTH_PROFILE_UPDATE", "CUSTOMER_HEALTH_PROFILE_VIEW"]),
    );
  });

  it("lần sau không cần gửi lại consent vì khách đã đồng ý", async () => {
    const id = await createCustomer();
    await api()
      .patch(`/api/v1/customers/${id}/health-profile`)
      .set(authHeaders(pharmacistToken))
      .send({ consent: true, allergies: [] })
      .expect(200);

    const response = await api()
      .patch(`/api/v1/customers/${id}/health-profile`)
      .set(authHeaders(pharmacistToken))
      .send({ chronicConditions: "Hen suyễn", allergies: [] })
      .expect(200);

    expect(response.body.data.chronicConditions).toBe("Hen suyễn");
  });

  it("mỗi lần xem hồ sơ đều ghi audit riêng", async () => {
    const id = await createCustomer();
    await api()
      .get(`/api/v1/customers/${id}/health-profile`)
      .set(authHeaders(pharmacistToken))
      .expect(200);
    await api()
      .get(`/api/v1/customers/${id}/health-profile`)
      .set(authHeaders(pharmacistToken))
      .expect(200);

    const views = await prisma.auditLog.count({
      where: { resourceType: "customer", resourceId: id, action: "CUSTOMER_HEALTH_PROFILE_VIEW" },
    });
    expect(views).toBe(2);
  });
});

describe("Cảnh báo dị ứng khi bán hàng — kiểm chứng đầu cuối", () => {
  it("safety-check trả ALLERGY_MATCH đúng theo hồ sơ khách vừa lưu", async () => {
    const customerId = await createCustomer();
    const ingredient = await prisma.activeIngredient.create({ data: { name: "Amoxicillin" } });
    await api()
      .patch(`/api/v1/customers/${customerId}/health-profile`)
      .set(authHeaders(pharmacistToken))
      .send({ consent: true, allergies: [{ ingredientId: ingredient.id }] })
      .expect(200);

    const category = await prisma.category.create({ data: { name: "Kháng sinh" } });
    const product = await prisma.product.create({
      data: {
        code: "TH0099",
        name: "Amoxicillin 500mg",
        productType: "DRUG",
        drugClass: "OTC",
        categoryId: category.id,
        units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
        ingredients: { create: { ingredientId: ingredient.id } },
      },
      include: { units: true },
    });

    const response = await api()
      .post("/api/v1/sales/safety-check")
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .send({
        customerId,
        lines: [{ productId: product.id, unitId: product.units[0]!.id, quantity: 1 }],
      })
      .expect(200);

    expect(response.body.data.warnings).toContainEqual(
      expect.objectContaining({ code: "ALLERGY_MATCH", requiresAck: true }),
    );
  });
});

describe("Lịch sử mua hàng", () => {
  it("xem được lịch sử, gộp từ mọi cửa hàng, có ghi audit", async () => {
    const customerId = await createCustomer();
    const category = await prisma.category.create({ data: { name: "Vitamin" } });
    const product = await prisma.product.create({
      data: {
        code: "TH0100",
        name: "Vitamin C 500mg",
        productType: "DRUG",
        drugClass: "OTC",
        categoryId: category.id,
        units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
      },
      include: { units: true },
    });
    await prisma.batch.create({
      data: {
        storeId: fixture.storeId,
        productId: product.id,
        batchNumber: "L1",
        expiryDate: new Date(Date.now() + 365 * 86_400_000),
        quantityOnHand: 100,
      },
    });
    await prisma.productPrice.create({
      data: {
        productUnitId: product.units[0]!.id,
        salePrice: 1000n,
        vatRatePercent: 5,
        effectiveFrom: new Date(Date.now() - 86_400_000),
      },
    });

    await api()
      .post("/api/v1/invoices")
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send({
        customerId,
        lines: [{ productId: product.id, unitId: product.units[0]!.id, quantity: 2 }],
      })
      .expect(201);

    const response = await api()
      .get(`/api/v1/customers/${customerId}/invoices`)
      .set(authHeaders(pharmacistToken))
      .expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({ storeCode: "NT01", lineCount: 1 });

    const audit = await prisma.auditLog.count({
      where: { resourceType: "customer", resourceId: customerId, action: "CUSTOMER_INVOICES_VIEW" },
    });
    expect(audit).toBe(1);
  });

  it("nhân viên bán hàng không xem được lịch sử mua (thiếu customer.sensitive)", async () => {
    const customerId = await createCustomer();
    const response = await api()
      .get(`/api/v1/customers/${customerId}/invoices`)
      .set(authHeaders(salesToken))
      .expect(403);

    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});

describe("Không tìm thấy khách hàng", () => {
  it("trả 404 cho id không tồn tại", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const response = await api()
      .get(`/api/v1/customers/${fakeId}`)
      .set(authHeaders(pharmacistToken))
      .expect(404);

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
