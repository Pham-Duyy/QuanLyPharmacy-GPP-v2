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
let categoryId: string;
let productId: string;
let unitId: string;

function idem(): Record<string, string> {
  return { "Idempotency-Key": randomUUID() };
}

async function makeBatch(batchNumber: string, quantity: number) {
  const expiryDate = new Date();
  expiryDate.setUTCFullYear(expiryDate.getUTCFullYear() + 1);
  const batch = await prisma.batch.create({
    data: {
      storeId: fixture.storeId,
      productId,
      batchNumber,
      expiryDate,
      quantityOnHand: quantity,
    },
  });
  return batch.id;
}

/** Lập phiếu bằng dược sĩ (có stock.adjust.create), để admin duyệt (khác người lập). */
function createDraft(body: Record<string, unknown>) {
  return api()
    .post("/api/v1/stock-adjustments")
    .set(authHeaders(pharmacistToken, fixture.storeId))
    .send(body);
}

function approve(id: string, token = adminToken) {
  return api()
    .post(`/api/v1/stock-adjustments/${id}/approve`)
    .set({ ...authHeaders(token, fixture.storeId), ...idem() })
    .send({});
}

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
  pharmacistToken = (await login("duocsi")).token;

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
      effectiveFrom: new Date(Date.now() - 86_400_000),
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Lập phiếu điều chỉnh", () => {
  it("chụp đúng tồn hệ thống của lô tại thời điểm lập với COUNT_DIFFERENCE", async () => {
    const batchId = await makeBatch("L1", 100);

    const response = await createDraft({
      reason: "Kiểm kê định kỳ tháng 9",
      lines: [{ batchId, unitId, reasonCode: "COUNT_DIFFERENCE", countedQuantity: 90 }],
    }).expect(201);

    expect(response.body.data.status).toBe("DRAFT");
    expect(response.body.data.lines[0]).toMatchObject({
      reasonCode: "COUNT_DIFFERENCE",
      countedQuantity: 90,
      systemBaseQuantityAtCount: 100,
      deltaBaseQuantity: null,
    });

    // Lập phiếu chưa đụng tới tồn.
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.quantityOnHand).toBe(100);
  });

  it("chặn gửi cả countedQuantity lẫn quantity", async () => {
    const batchId = await makeBatch("L1", 100);

    const response = await createDraft({
      lines: [
        { batchId, unitId, reasonCode: "COUNT_DIFFERENCE", countedQuantity: 90, quantity: 5 },
      ],
    }).expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("chặn đơn vị không thuộc sản phẩm của lô", async () => {
    const batchId = await makeBatch("L1", 100);
    const other = await prisma.product.create({
      data: {
        code: "TH0002",
        name: "Amoxicillin 500mg",
        productType: "DRUG",
        drugClass: "RX",
        categoryId,
        units: { create: { name: "Viên", conversionToBase: 1 } },
      },
      include: { units: true },
    });

    const response = await createDraft({
      lines: [
        {
          batchId,
          unitId: other.units[0]!.id,
          reasonCode: "DAMAGED",
          quantity: 5,
        },
      ],
    }).expect(422);

    expect(response.body.error.code).toBe("UNIT_NOT_IN_PRODUCT");
  });

  it("không cần Idempotency-Key khi lập phiếu", async () => {
    const batchId = await makeBatch("L1", 100);
    await createDraft({
      lines: [{ batchId, unitId, reasonCode: "DAMAGED", quantity: 5 }],
    }).expect(201);
  });
});

describe("Duyệt phiếu điều chỉnh", () => {
  it("áp dụng đúng CHÊNH LỆCH chứ không gán tồn bằng số đếm (P4)", async () => {
    const batchId = await makeBatch("L1", 100);

    const created = await createDraft({
      lines: [{ batchId, unitId, reasonCode: "COUNT_DIFFERENCE", countedQuantity: 90 }],
    }).expect(201);

    // Giữa lúc đếm và lúc duyệt, một hóa đơn bán ra 5 đơn vị.
    await api()
      .post("/api/v1/invoices")
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({ lines: [{ productId, unitId, quantity: 5 }] })
      .expect(201);

    let batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.quantityOnHand).toBe(95);

    const response = await approve(created.body.data.id).expect(200);
    expect(response.body.data.status).toBe("APPROVED");
    // Chênh lệch = 90 - 100 = -10, áp vào tồn hiện tại 95 -> 85, không phải 90.
    expect(response.body.data.lines[0].deltaBaseQuantity).toBe(-10);

    batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.quantityOnHand).toBe(85);

    const movement = await prisma.stockMovement.findFirst({
      where: { sourceId: created.body.data.id },
    });
    expect(movement).toMatchObject({ type: "ADJUSTMENT", baseQuantity: -10, balanceAfter: 85 });
  });

  it("không ghi thẻ kho khi đếm khớp tồn hệ thống (chênh lệch bằng 0)", async () => {
    const batchId = await makeBatch("L1", 100);
    const created = await createDraft({
      lines: [{ batchId, unitId, reasonCode: "COUNT_DIFFERENCE", countedQuantity: 100 }],
    }).expect(201);

    await approve(created.body.data.id).expect(200);

    const movements = await prisma.stockMovement.findMany({
      where: { sourceId: created.body.data.id },
    });
    expect(movements).toHaveLength(0);
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.quantityOnHand).toBe(100);
  });

  it("xuất hủy đúng số lượng và ghi thẻ kho DISPOSAL", async () => {
    const batchId = await makeBatch("L1", 100);
    const created = await createDraft({
      reason: "Hàng vỡ vỏ",
      lines: [{ batchId, unitId, reasonCode: "DAMAGED", quantity: 15 }],
    }).expect(201);

    await approve(created.body.data.id).expect(200);

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.quantityOnHand).toBe(85);

    const movement = await prisma.stockMovement.findFirst({
      where: { sourceId: created.body.data.id },
    });
    expect(movement).toMatchObject({ type: "DISPOSAL", baseQuantity: -15, balanceAfter: 85 });
  });

  it("chặn xuất hủy vượt quá tồn hiện có khi duyệt", async () => {
    const batchId = await makeBatch("L1", 20);
    const created = await createDraft({
      lines: [{ batchId, unitId, reasonCode: "DAMAGED", quantity: 15 }],
    }).expect(201);

    // Tồn giảm xuống dưới mức cần xuất hủy trước khi phiếu được duyệt.
    await api()
      .post("/api/v1/invoices")
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({ lines: [{ productId, unitId, quantity: 10 }] })
      .expect(201);

    const response = await approve(created.body.data.id).expect(409);
    expect(response.body.error.code).toBe("INSUFFICIENT_STOCK");
  });

  it("chặn tự duyệt phiếu mình lập", async () => {
    const batchId = await makeBatch("L1", 100);
    const created = await createDraft({
      lines: [{ batchId, unitId, reasonCode: "DAMAGED", quantity: 5 }],
    }).expect(201);

    const response = await approve(created.body.data.id, pharmacistToken).expect(422);
    expect(response.body.error.code).toBe("SELF_APPROVAL_NOT_ALLOWED");
  });

  it("không duyệt lại được phiếu đã duyệt", async () => {
    const batchId = await makeBatch("L1", 100);
    const created = await createDraft({
      lines: [{ batchId, unitId, reasonCode: "DAMAGED", quantity: 5 }],
    }).expect(201);

    await approve(created.body.data.id).expect(200);
    const response = await approve(created.body.data.id).expect(409);
    expect(response.body.error.code).toBe("INVALID_STATE");
  });

  it("yêu cầu Idempotency-Key khi duyệt", async () => {
    const batchId = await makeBatch("L1", 100);
    const created = await createDraft({
      lines: [{ batchId, unitId, reasonCode: "DAMAGED", quantity: 5 }],
    }).expect(201);

    const response = await api()
      .post(`/api/v1/stock-adjustments/${created.body.data.id}/approve`)
      .set(authHeaders(adminToken, fixture.storeId))
      .send({})
      .expect(400);

    expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});

describe("Từ chối phiếu điều chỉnh", () => {
  it("bắt buộc ghi lý do", async () => {
    const batchId = await makeBatch("L1", 100);
    const created = await createDraft({
      lines: [{ batchId, unitId, reasonCode: "DAMAGED", quantity: 5 }],
    }).expect(201);

    const response = await api()
      .post(`/api/v1/stock-adjustments/${created.body.data.id}/reject`)
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({})
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("từ chối không đụng tới tồn", async () => {
    const batchId = await makeBatch("L1", 100);
    const created = await createDraft({
      lines: [{ batchId, unitId, reasonCode: "DAMAGED", quantity: 5 }],
    }).expect(201);

    const response = await api()
      .post(`/api/v1/stock-adjustments/${created.body.data.id}/reject`)
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({ reason: "Số liệu không hợp lý, đếm lại" })
      .expect(200);

    expect(response.body.data.status).toBe("REJECTED");
    expect(response.body.data.rejectedReason).toBe("Số liệu không hợp lý, đếm lại");

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.quantityOnHand).toBe(100);
  });
});

describe("Hủy phiếu điều chỉnh", () => {
  it("chỉ người lập mới hủy được", async () => {
    const batchId = await makeBatch("L1", 100);
    const created = await createDraft({
      lines: [{ batchId, unitId, reasonCode: "DAMAGED", quantity: 5 }],
    }).expect(201);

    const response = await api()
      .post(`/api/v1/stock-adjustments/${created.body.data.id}/cancel`)
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({})
      .expect(403);

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("người lập hủy được phiếu nháp của mình", async () => {
    const batchId = await makeBatch("L1", 100);
    const created = await createDraft({
      lines: [{ batchId, unitId, reasonCode: "DAMAGED", quantity: 5 }],
    }).expect(201);

    const response = await api()
      .post(`/api/v1/stock-adjustments/${created.body.data.id}/cancel`)
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send({})
      .expect(200);

    expect(response.body.data.status).toBe("CANCELLED");
  });

  it("không hủy được phiếu đã duyệt", async () => {
    const batchId = await makeBatch("L1", 100);
    const created = await createDraft({
      lines: [{ batchId, unitId, reasonCode: "DAMAGED", quantity: 5 }],
    }).expect(201);
    await approve(created.body.data.id).expect(200);

    const response = await api()
      .post(`/api/v1/stock-adjustments/${created.body.data.id}/cancel`)
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send({})
      .expect(409);

    expect(response.body.error.code).toBe("INVALID_STATE");
  });
});

describe("Phạm vi cửa hàng", () => {
  it("không thấy phiếu của cửa hàng khác", async () => {
    const batchId = await makeBatch("L1", 100);
    const created = await createDraft({
      lines: [{ batchId, unitId, reasonCode: "DAMAGED", quantity: 5 }],
    }).expect(201);

    await api()
      .get(`/api/v1/stock-adjustments/${created.body.data.id}`)
      .set(authHeaders(adminToken, fixture.otherStoreId))
      .expect(404);
  });
});

describe("Danh sách phiếu điều chỉnh", () => {
  it("lọc theo trạng thái, trả tên người lập/người duyệt", async () => {
    const batchId = await makeBatch("L1", 100);
    const draft = await createDraft({
      lines: [{ batchId, unitId, reasonCode: "DAMAGED", quantity: 5 }],
    }).expect(201);
    await approve(draft.body.data.id).expect(200);

    const batchId2 = await makeBatch("L2", 100);
    await createDraft({
      lines: [{ batchId: batchId2, unitId, reasonCode: "DAMAGED", quantity: 1 }],
    }).expect(201);

    const response = await api()
      .get("/api/v1/stock-adjustments")
      .query({ status: "APPROVED" })
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({
      status: "APPROVED",
      createdByName: "Dược sĩ",
      approvedByName: "Quản trị",
      lineCount: 1,
    });
  });
});
