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
let pharmacistToken: string;
let salesToken: string;
let categoryId: string;
let productId: string;
let unitId: string;

function idem(): Record<string, string> {
  return { "Idempotency-Key": randomUUID() };
}

function isoDate(daysOffset = 0): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysOffset);
  return date.toISOString().slice(0, 10);
}

function draftBody(overrides: Record<string, unknown> = {}) {
  return {
    prescriberName: "BS. Nguyễn Văn B",
    facilityName: "Bệnh viện Đa khoa Hà Nội",
    prescribedDate: isoDate(),
    items: [{ productId, unitId, drugNameText: "Amoxicillin 500mg", quantity: 20 }],
    ...overrides,
  };
}

function createDraft(token: string, body = draftBody()) {
  return api().post("/api/v1/prescriptions").set(authHeaders(token, fixture.storeId)).send(body);
}

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  pharmacistToken = (await login("duocsi")).token;
  salesToken = (await login("banhang")).token;

  categoryId = (await prisma.category.create({ data: { name: "Thuốc kê đơn" } })).id;
  const product = await prisma.product.create({
    data: {
      code: "TH0002",
      name: "Amoxicillin 500mg",
      productType: "DRUG",
      drugClass: "RX",
      categoryId,
      units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  productId = product.id;
  unitId = product.units[0]!.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Tạo đơn thuốc", () => {
  it("tạo được đơn DRAFT, tự tính validUntil theo prescriptionValidityDays mặc định", async () => {
    const response = await createDraft(pharmacistToken).expect(201);

    expect(response.body.data.status).toBe("DRAFT");
    expect(response.body.data.validUntil.slice(0, 10)).toBe(isoDate(5));
    expect(response.body.data.items[0]).toMatchObject({
      productId,
      drugNameText: "Amoxicillin 500mg",
      quantity: 20,
      baseQuantity: 20,
    });
  });

  it("cho phép dòng thuốc chưa khớp sản phẩm trong danh mục", async () => {
    const response = await createDraft(
      pharmacistToken,
      draftBody({ items: [{ drugNameText: "Thuốc lạ chưa có trong hệ thống", quantity: 10 }] }),
    ).expect(201);

    expect(response.body.data.items[0]).toMatchObject({
      productId: null,
      drugNameText: "Thuốc lạ chưa có trong hệ thống",
      baseQuantity: null,
    });
  });

  it("nhân viên bán hàng cũng tạo được đơn nháp", async () => {
    await createDraft(salesToken).expect(201);
  });

  it("chặn unitId mà thiếu productId", async () => {
    const response = await createDraft(
      pharmacistToken,
      draftBody({ items: [{ unitId, drugNameText: "Thiếu productId", quantity: 1 }] }),
    ).expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("người xác nhận nhập thẳng validUntil cho đơn mạn tính thì giữ nguyên giá trị đó", async () => {
    const response = await createDraft(
      pharmacistToken,
      draftBody({ validUntil: isoDate(90) }),
    ).expect(201);

    expect(response.body.data.validUntil.slice(0, 10)).toBe(isoDate(90));
  });
});

describe("Sửa đơn thuốc", () => {
  it("sửa được khi còn DRAFT, đúng version", async () => {
    const draft = await createDraft(pharmacistToken).expect(201);

    const response = await api()
      .patch(`/api/v1/prescriptions/${draft.body.data.id}`)
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .send({ version: draft.body.data.version, diagnosisText: "Viêm họng cấp" })
      .expect(200);

    expect(response.body.data.diagnosisText).toBe("Viêm họng cấp");
    expect(response.body.data.version).toBe(draft.body.data.version + 1);
  });

  it("chặn khi version không khớp", async () => {
    const draft = await createDraft(pharmacistToken).expect(201);

    const response = await api()
      .patch(`/api/v1/prescriptions/${draft.body.data.id}`)
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .send({ version: draft.body.data.version + 1, diagnosisText: "..." })
      .expect(409);

    expect(response.body.error.code).toBe("VERSION_CONFLICT");
  });

  it("không sửa được đơn đã xác nhận", async () => {
    const draft = await createDraft(pharmacistToken).expect(201);
    await api()
      .post(`/api/v1/prescriptions/${draft.body.data.id}/verify`)
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send({})
      .expect(200);

    const response = await api()
      .patch(`/api/v1/prescriptions/${draft.body.data.id}`)
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .send({ version: draft.body.data.version, diagnosisText: "..." })
      .expect(409);

    expect(response.body.error.code).toBe("INVALID_STATE");
  });
});

describe("Nộp, xác nhận, từ chối", () => {
  it("nộp chuyển DRAFT sang PENDING_REVIEW", async () => {
    const draft = await createDraft(pharmacistToken).expect(201);

    const response = await api()
      .post(`/api/v1/prescriptions/${draft.body.data.id}/submit`)
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send({})
      .expect(200);

    expect(response.body.data.status).toBe("PENDING_REVIEW");
  });

  it("xác nhận chuyển VERIFIED, ghi verifiedBy từ phiên đăng nhập", async () => {
    const draft = await createDraft(pharmacistToken).expect(201);
    const pharmacist = await prisma.user.findUniqueOrThrow({ where: { username: "duocsi" } });

    const response = await api()
      .post(`/api/v1/prescriptions/${draft.body.data.id}/verify`)
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send({})
      .expect(200);

    expect(response.body.data.status).toBe("VERIFIED");
    expect(response.body.data.verifiedBy.id).toBe(pharmacist.id);
  });

  it("chặn xác nhận khi còn dòng chưa khớp sản phẩm", async () => {
    const draft = await createDraft(
      pharmacistToken,
      draftBody({ items: [{ drugNameText: "Chưa khớp danh mục", quantity: 5 }] }),
    ).expect(201);

    const response = await api()
      .post(`/api/v1/prescriptions/${draft.body.data.id}/verify`)
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send({})
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("nhân viên bán hàng không xác nhận được đơn (thiếu prescription.verify)", async () => {
    const draft = await createDraft(pharmacistToken).expect(201);

    const response = await api()
      .post(`/api/v1/prescriptions/${draft.body.data.id}/verify`)
      .set({ ...authHeaders(salesToken, fixture.storeId), ...idem() })
      .send({})
      .expect(403);

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("từ chối bắt buộc lý do", async () => {
    const draft = await createDraft(pharmacistToken).expect(201);

    const response = await api()
      .post(`/api/v1/prescriptions/${draft.body.data.id}/reject`)
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send({})
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("từ chối ghi lý do và chuyển REJECTED", async () => {
    const draft = await createDraft(pharmacistToken).expect(201);

    const response = await api()
      .post(`/api/v1/prescriptions/${draft.body.data.id}/reject`)
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send({ reason: "Chữ viết tay không đọc được, cần đơn khác" })
      .expect(200);

    expect(response.body.data.status).toBe("REJECTED");
    expect(response.body.data.rejectedReason).toBe("Chữ viết tay không đọc được, cần đơn khác");
  });

  it("không xác nhận lại được đơn đã từ chối", async () => {
    const draft = await createDraft(pharmacistToken).expect(201);
    await api()
      .post(`/api/v1/prescriptions/${draft.body.data.id}/reject`)
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send({ reason: "Không hợp lệ" })
      .expect(200);

    const response = await api()
      .post(`/api/v1/prescriptions/${draft.body.data.id}/verify`)
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send({})
      .expect(409);

    expect(response.body.error.code).toBe("INVALID_STATE");
  });

  it("yêu cầu Idempotency-Key khi xác nhận", async () => {
    const draft = await createDraft(pharmacistToken).expect(201);

    const response = await api()
      .post(`/api/v1/prescriptions/${draft.body.data.id}/verify`)
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .send({})
      .expect(400);

    expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});

describe("Dùng đơn đã xác nhận để bán thuốc kê đơn", () => {
  it("bán đúng theo đơn và cộng dồn số lượng đã bán", async () => {
    await prisma.batch.create({
      data: {
        storeId: fixture.storeId,
        productId,
        batchNumber: "L1",
        expiryDate: new Date(isoDate(365)),
        quantityOnHand: 100,
      },
    });
    await prisma.productPrice.create({
      data: {
        productUnitId: unitId,
        salePrice: 3000n,
        vatRatePercent: 5,
        effectiveFrom: new Date(Date.now() - 86_400_000),
      },
    });

    const draft = await createDraft(pharmacistToken).expect(201);
    await api()
      .post(`/api/v1/prescriptions/${draft.body.data.id}/verify`)
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send({})
      .expect(200);

    const itemId = draft.body.data.items[0].id;
    await api()
      .post("/api/v1/invoices")
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send({
        prescriptionId: draft.body.data.id,
        lines: [{ productId, unitId, quantity: 12, prescriptionItemId: itemId }],
      })
      .expect(201);

    const detail = await api()
      .get(`/api/v1/prescriptions/${draft.body.data.id}`)
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .expect(200);

    expect(detail.body.data.items[0].dispensedBaseQuantity).toBe(12);
    expect(detail.body.data.status).toBe("PARTIALLY_DISPENSED");
  });
});

describe("Đơn thuốc dùng chung toàn chuỗi", () => {
  it("tạo ở một cửa hàng vẫn xem và xác nhận được từ ngữ cảnh không chọn cửa hàng", async () => {
    const draft = await createDraft(pharmacistToken).expect(201);

    // Không gửi X-Store-Id: đơn thuốc là tài nguyên toàn chuỗi (contract §2.8).
    const response = await api()
      .get(`/api/v1/prescriptions/${draft.body.data.id}`)
      .set(authHeaders(pharmacistToken))
      .expect(200);

    expect(response.body.data.status).toBe("DRAFT");
  });

  it("bắt buộc chọn cửa hàng khi tạo mới", async () => {
    const response = await api()
      .post("/api/v1/prescriptions")
      .set(authHeaders(pharmacistToken))
      .send(draftBody())
      .expect(400);

    expect(response.body.error.code).toBe("STORE_REQUIRED");
  });
});
