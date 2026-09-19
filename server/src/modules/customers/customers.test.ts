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

describe("Danh sách khách hàng", () => {
  it("không truyền search thì trả danh sách phân trang, mới tạo trước, số điện thoại che bớt", async () => {
    const first = await createCustomer({ fullName: "Khách thứ nhất", phone: "0901111222" });
    const second = await createCustomer({ fullName: "Khách thứ hai", phone: "0903333444" });
    await prisma.customer.update({
      where: { id: first },
      data: { createdAt: new Date("2026-01-01") },
    });

    const response = await api()
      .get("/api/v1/customers")
      .query({ page: 1, limit: 1 })
      .set(authHeaders(salesToken))
      .expect(200);

    expect(response.body.data.pagination).toEqual({ page: 1, limit: 1, total: 2 });
    expect(response.body.data.items).toEqual([
      expect.objectContaining({
        id: second,
        fullName: "Khách thứ hai",
        phone: "090****444",
        hasHealthConsent: false,
      }),
    ]);
    // Không trả hồ sơ sức khỏe hay ghi chú trong danh sách.
    expect(response.body.data.items[0]).not.toHaveProperty("note");

    const page2 = await api()
      .get("/api/v1/customers")
      .query({ page: 2, limit: 1 })
      .set(authHeaders(salesToken))
      .expect(200);
    expect(page2.body.data.items[0].id).toBe(first);
  });

  it("không liệt kê khách đã ẩn danh", async () => {
    const id = await createCustomer();
    await prisma.customer.update({
      where: { id },
      data: { isAnonymized: true, fullName: null, phone: null },
    });
    const response = await api().get("/api/v1/customers").set(authHeaders(salesToken)).expect(200);
    expect(response.body.data.pagination.total).toBe(0);
  });

  it("vẫn yêu cầu quyền customer.read", async () => {
    await api().get("/api/v1/customers").expect(401);
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

describe("Bắt buộc có định danh khi tạo khách hàng", () => {
  it("chặn khi cả họ tên lẫn số điện thoại đều thiếu", async () => {
    const response = await api()
      .post("/api/v1/customers")
      .set(authHeaders(salesToken))
      .send({ note: "Chỉ có ghi chú, không có tên hay số điện thoại" })
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("chặn khi cả hai đều là chuỗi rỗng hoặc chỉ có khoảng trắng", async () => {
    const response = await api()
      .post("/api/v1/customers")
      .set(authHeaders(salesToken))
      .send({ fullName: "   ", phone: "" })
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("chỉ có họ tên vẫn tạo được", async () => {
    const response = await api()
      .post("/api/v1/customers")
      .set(authHeaders(salesToken))
      .send({ fullName: "Chỉ có tên" })
      .expect(201);

    expect(response.body.data.fullName).toBe("Chỉ có tên");
    expect(response.body.data.phone).toBeNull();
  });

  it("chỉ có số điện thoại vẫn tạo được", async () => {
    const response = await api()
      .post("/api/v1/customers")
      .set(authHeaders(salesToken))
      .send({ phone: "0909090909" })
      .expect(201);

    expect(response.body.data.phone).toBe("0909090909");
    expect(response.body.data.fullName).toBeNull();
  });
});

describe("Sửa khách hàng không được xóa hết định danh", () => {
  it("xóa số điện thoại vẫn được vì còn họ tên", async () => {
    const id = await createCustomer({ fullName: "Còn tên", phone: "0901111111" });
    const before = await api().get(`/api/v1/customers/${id}`).set(authHeaders(salesToken));

    const response = await api()
      .patch(`/api/v1/customers/${id}`)
      .set(authHeaders(salesToken))
      .send({ version: before.body.data.version, phone: null })
      .expect(200);

    expect(response.body.data.phone).toBeNull();
    expect(response.body.data.fullName).toBe("Còn tên");
  });

  it("chặn xóa nốt trường còn lại khi trường kia đã bị xóa từ trước", async () => {
    const id = await createCustomer({ fullName: "Sắp rỗng", phone: "0902222222" });
    const afterFirstPatch = await api()
      .patch(`/api/v1/customers/${id}`)
      .set(authHeaders(salesToken))
      .send({ version: 1, phone: null })
      .expect(200);

    const response = await api()
      .patch(`/api/v1/customers/${id}`)
      .set(authHeaders(salesToken))
      .send({ version: afterFirstPatch.body.data.version, fullName: null })
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");

    // Xác nhận dữ liệu không đổi sau request bị chặn.
    const stillThere = await prisma.customer.findUniqueOrThrow({ where: { id } });
    expect(stillThere.fullName).toBe("Sắp rỗng");
    expect(stillThere.version).toBe(afterFirstPatch.body.data.version);
  });

  it("xóa cả hai trong cùng một request bị chặn ngay, không sửa gì cả", async () => {
    const id = await createCustomer({ fullName: "Trước khi xóa", phone: "0903333333" });
    const before = await api().get(`/api/v1/customers/${id}`).set(authHeaders(salesToken));

    const response = await api()
      .patch(`/api/v1/customers/${id}`)
      .set(authHeaders(salesToken))
      .send({ version: before.body.data.version, fullName: null, phone: null })
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");

    const stillThere = await prisma.customer.findUniqueOrThrow({ where: { id } });
    expect(stillThere.fullName).toBe("Trước khi xóa");
    expect(stillThere.phone).toBe("0903333333");
    expect(stillThere.version).toBe(before.body.data.version);
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

  it("ingredientId hợp lệ định dạng nhưng không tồn tại thì trả 422, không lưu gì cả", async () => {
    const id = await createCustomer();
    const fakeIngredientId = "00000000-0000-0000-0000-000000000000"; // UUID hợp lệ, không có trong bảng.

    const response = await api()
      .patch(`/api/v1/customers/${id}/health-profile`)
      .set(authHeaders(pharmacistToken))
      .send({
        consent: true,
        chronicConditions: "Không được lưu",
        allergies: [{ ingredientId: fakeIngredientId }],
      })
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");

    // Cả consent, hồ sơ sức khỏe lẫn dị ứng đều không được lưu dở dang.
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id } });
    expect(customer.healthDataConsentAt).toBeNull();

    const profile = await prisma.customerHealthProfile.findUnique({ where: { customerId: id } });
    expect(profile).toBeNull();

    const allergies = await prisma.customerAllergy.findMany({ where: { customerId: id } });
    expect(allergies).toHaveLength(0);
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

describe("Ẩn danh khách hàng", () => {
  it("xóa họ tên/SĐT/hồ sơ sức khỏe, giữ nguyên hóa đơn đã phát sinh", async () => {
    const customerId = await createCustomer({ fullName: "Trần Thị B", phone: "0912345678" });
    await api()
      .patch(`/api/v1/customers/${customerId}/health-profile`)
      .set(authHeaders(pharmacistToken))
      .send({ consent: true, chronicConditions: "Tiểu đường", allergies: [] })
      .expect(200);

    const category = await prisma.category.create({ data: { name: "Thuốc" } });
    const product = await prisma.product.create({
      data: {
        code: "TH0001",
        name: "Paracetamol 500mg",
        productType: "DRUG",
        drugClass: "OTC",
        categoryId: category.id,
        units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
      },
      include: { units: true },
    });
    await prisma.productPrice.create({
      data: {
        productUnitId: product.units[0]!.id,
        salePrice: 1000n,
        vatRatePercent: 5,
        effectiveFrom: new Date(Date.now() - 86_400_000),
      },
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
    const invoice = await api()
      .post("/api/v1/invoices")
      .set({ ...authHeaders(salesToken, fixture.storeId), ...idem() })
      .send({
        customerId,
        lines: [{ productId: product.id, unitId: product.units[0]!.id, quantity: 1 }],
      })
      .expect(201);

    const response = await api()
      .post(`/api/v1/customers/${customerId}/anonymize`)
      .set(authHeaders(pharmacistToken))
      .send({ reason: "Khách yêu cầu xóa dữ liệu cá nhân" })
      .expect(200);

    expect(response.body.data.fullName).toMatch(/^KH-AN-/);
    expect(response.body.data.phone).toBeNull();
    expect(response.body.data.hasHealthConsent).toBe(false);

    const health = await api()
      .get(`/api/v1/customers/${customerId}/health-profile`)
      .set(authHeaders(pharmacistToken))
      .expect(200);
    expect(health.body.data.chronicConditions).toBeNull();
    expect(health.body.data.allergies).toEqual([]);

    // Hóa đơn đã phát sinh vẫn còn nguyên, chỉ tên khách đổi theo mã ẩn danh mới.
    const invoiceDetail = await api()
      .get(`/api/v1/invoices/${invoice.body.data.id}`)
      .set(authHeaders(salesToken, fixture.storeId))
      .expect(200);
    expect(invoiceDetail.body.data.customer.id).toBe(customerId);
    expect(invoiceDetail.body.data.customer.fullName).toMatch(/^KH-AN-/);

    const audit = await prisma.auditLog.findFirst({
      where: { resourceType: "customer", resourceId: customerId, action: "CUSTOMER_ANONYMIZE" },
    });
    expect(audit).toMatchObject({ reason: "Khách yêu cầu xóa dữ liệu cá nhân" });
  });

  it("bắt buộc ghi lý do", async () => {
    const customerId = await createCustomer();
    const response = await api()
      .post(`/api/v1/customers/${customerId}/anonymize`)
      .set(authHeaders(pharmacistToken))
      .send({})
      .expect(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("không ẩn danh lại lần hai", async () => {
    const customerId = await createCustomer();
    await api()
      .post(`/api/v1/customers/${customerId}/anonymize`)
      .set(authHeaders(pharmacistToken))
      .send({ reason: "Lần 1" })
      .expect(200);

    const response = await api()
      .post(`/api/v1/customers/${customerId}/anonymize`)
      .set(authHeaders(pharmacistToken))
      .send({ reason: "Lần 2" })
      .expect(409);
    expect(response.body.error.code).toBe("INVALID_STATE");
  });

  it("khách đã ẩn danh không còn hiện trong tìm kiếm", async () => {
    const customerId = await createCustomer({ fullName: "Phạm Văn C", phone: "0987654321" });
    await api()
      .post(`/api/v1/customers/${customerId}/anonymize`)
      .set(authHeaders(pharmacistToken))
      .send({ reason: "Khách yêu cầu" })
      .expect(200);

    const response = await api()
      .get("/api/v1/customers")
      .query({ search: "Phạm Văn C" })
      .set(authHeaders(pharmacistToken))
      .expect(200);
    expect(response.body.data).toHaveLength(0);
  });

  it("nhân viên bán hàng không có quyền ẩn danh (thiếu customer.sensitive)", async () => {
    const customerId = await createCustomer();
    const response = await api()
      .post(`/api/v1/customers/${customerId}/anonymize`)
      .set(authHeaders(salesToken))
      .send({ reason: "Thử" })
      .expect(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});
