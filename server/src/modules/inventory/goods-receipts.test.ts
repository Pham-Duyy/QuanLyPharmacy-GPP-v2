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
let token: string;
let productId: string;
let unitId: string;
let supplierId: string;

/** Mỗi thao tác một khóa mới, đúng như client thật sinh khóa cho mỗi lần bấm. */
function idem(): Record<string, string> {
  return { "Idempotency-Key": randomUUID() };
}

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  token = (await login("admin")).token;

  const category = await prisma.category.create({ data: { name: "Thuốc giảm đau" } });
  const product = await prisma.product.create({
    data: {
      code: "TH0001",
      name: "Paracetamol 500mg",
      productType: "DRUG",
      drugClass: "OTC",
      categoryId: category.id,
      units: { create: { name: "Hộp", conversionToBase: 100, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  productId = product.id;
  unitId = product.units[0]!.id;

  const supplier = await prisma.supplier.create({ data: { name: "Công ty Dược ABC" } });
  supplierId = supplier.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function draftBody(overrides: Record<string, unknown> = {}) {
  return {
    supplierId,
    supplierInvoiceNumber: "0001234",
    receivedAt: new Date().toISOString(),
    lines: [
      {
        productId,
        unitId,
        quantity: 20,
        unitCost: 82000,
        batchNumber: "PA250110",
        expiryDate: "2027-01-09",
      },
    ],
    ...overrides,
  };
}

function createDraft(body = draftBody()) {
  return api()
    .post("/api/v1/goods-receipts")
    .set({ ...authHeaders(token, fixture.storeId), ...idem() })
    .send(body);
}

async function stockOf(batchNumber: string): Promise<number> {
  const batch = await prisma.batch.findFirst({ where: { batchNumber } });
  return batch?.quantityOnHand ?? 0;
}

describe("Tạo phiếu nhập", () => {
  it("tạo phiếu nháp và chưa đụng gì tới tồn kho", async () => {
    const response = await createDraft().expect(201);

    expect(response.body.data.status).toBe("DRAFT");
    expect(response.body.data.totalCost).toBe(1_640_000);
    expect(response.body.data.lines[0].baseQuantity).toBe(2000);
    expect(await prisma.batch.count()).toBe(0);
    expect(await prisma.stockMovement.count()).toBe(0);
  });

  it("từ chối khi thiếu Idempotency-Key", async () => {
    const response = await api()
      .post("/api/v1/goods-receipts")
      .set(authHeaders(token, fixture.storeId))
      .send(draftBody())
      .expect(400);

    expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("gửi lại cùng một khóa thì trả lại đúng phiếu cũ, không tạo phiếu thứ hai", async () => {
    const headers = { ...authHeaders(token, fixture.storeId), ...idem() };
    // Cùng một nội dung: đây là lần gửi lại do mạng lỗi, không phải thao tác mới.
    const body = draftBody();

    const first = await api().post("/api/v1/goods-receipts").set(headers).send(body).expect(201);
    const second = await api().post("/api/v1/goods-receipts").set(headers).send(body).expect(201);

    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await prisma.goodsReceipt.count()).toBe(1);
  });

  it("cùng khóa nhưng nội dung khác thì bị từ chối", async () => {
    const headers = { ...authHeaders(token, fixture.storeId), ...idem() };
    const body = draftBody();
    await api().post("/api/v1/goods-receipts").set(headers).send(body).expect(201);

    // Chỉ khác đúng một trường: vẫn phải bị coi là thao tác khác.
    const response = await api()
      .post("/api/v1/goods-receipts")
      .set(headers)
      .send({ ...body, supplierInvoiceNumber: "0009999" })
      .expect(422);

    expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("chặn đơn vị tính không thuộc sản phẩm", async () => {
    const other = await prisma.product.create({
      data: {
        code: "TH0002",
        name: "Thuốc khác",
        productType: "DRUG",
        drugClass: "OTC",
        categoryId: (await prisma.category.findFirstOrThrow()).id,
        units: { create: { name: "Viên", conversionToBase: 1 } },
      },
      include: { units: true },
    });

    const response = await createDraft(
      draftBody({ lines: [{ ...draftBody().lines[0], unitId: other.units[0]!.id }] }),
    ).expect(422);

    expect(response.body.error.code).toBe("UNIT_NOT_IN_PRODUCT");
  });

  it("chặn hạn dùng đã qua", async () => {
    const response = await createDraft(
      draftBody({ lines: [{ ...draftBody().lines[0], expiryDate: "2020-01-01" }] }),
    ).expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("Xác nhận phiếu nhập", () => {
  it("tạo lô, cộng tồn và ghi thẻ kho trong cùng một lần xác nhận", async () => {
    const draft = await createDraft().expect(201);

    const response = await api()
      .post(`/api/v1/goods-receipts/${draft.body.data.id}/confirm`)
      .set({ ...authHeaders(token, fixture.storeId), ...idem() })
      .send({})
      .expect(200);

    expect(response.body.data.status).toBe("CONFIRMED");

    const batch = await prisma.batch.findFirstOrThrow({ where: { batchNumber: "PA250110" } });
    expect(batch.quantityOnHand).toBe(2000);
    expect(batch.status).toBe("AVAILABLE");
    expect(batch.storeId).toBe(fixture.storeId);

    const movements = await prisma.stockMovement.findMany({ where: { batchId: batch.id } });
    expect(movements).toHaveLength(1);
    expect(movements[0]?.type).toBe("RECEIPT");
    expect(movements[0]?.baseQuantity).toBe(2000);
    expect(movements[0]?.balanceAfter).toBe(2000);

    // Bất biến ở ERD §10: tồn của lô bằng tổng thẻ kho.
    const total = movements.reduce((sum, movement) => sum + movement.baseQuantity, 0);
    expect(batch.quantityOnHand).toBe(total);
  });

  it("xác nhận lần thứ hai bị chặn và tồn không đổi", async () => {
    const draft = await createDraft().expect(201);
    const url = `/api/v1/goods-receipts/${draft.body.data.id}/confirm`;

    await api()
      .post(url)
      .set({ ...authHeaders(token, fixture.storeId), ...idem() })
      .send({})
      .expect(200);

    // Khóa idempotency khác: đây là lần bấm mới, không phải retry.
    const second = await api()
      .post(url)
      .set({ ...authHeaders(token, fixture.storeId), ...idem() })
      .send({})
      .expect(409);

    expect(second.body.error.code).toBe("INVALID_STATE");
    expect(await stockOf("PA250110")).toBe(2000);
  });

  it("bấm xác nhận hai lần cùng lúc thì tồn chỉ cộng một lần", async () => {
    const draft = await createDraft().expect(201);
    const url = `/api/v1/goods-receipts/${draft.body.data.id}/confirm`;

    const [first, second] = await Promise.all([
      api()
        .post(url)
        .set({ ...authHeaders(token, fixture.storeId), ...idem() })
        .send({}),
      api()
        .post(url)
        .set({ ...authHeaders(token, fixture.storeId), ...idem() })
        .send({}),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(await stockOf("PA250110")).toBe(2000);
    expect(await prisma.stockMovement.count()).toBe(1);
  });

  it("gửi lại đúng khóa idempotency khi mạng lỗi thì không cộng tồn thêm lần nữa", async () => {
    const draft = await createDraft().expect(201);
    const url = `/api/v1/goods-receipts/${draft.body.data.id}/confirm`;
    const headers = { ...authHeaders(token, fixture.storeId), ...idem() };

    await api().post(url).set(headers).send({}).expect(200);
    const retry = await api().post(url).set(headers).send({}).expect(200);

    expect(retry.body.data.status).toBe("CONFIRMED");
    expect(await stockOf("PA250110")).toBe(2000);
    expect(await prisma.stockMovement.count()).toBe(1);
  });

  it("nhập lại cùng số lô thì cộng vào lô cũ, không tạo lô mới", async () => {
    const first = await createDraft().expect(201);
    await api()
      .post(`/api/v1/goods-receipts/${first.body.data.id}/confirm`)
      .set({ ...authHeaders(token, fixture.storeId), ...idem() })
      .send({})
      .expect(200);

    const second = await createDraft(
      draftBody({ lines: [{ ...draftBody().lines[0], quantity: 5 }] }),
    ).expect(201);
    await api()
      .post(`/api/v1/goods-receipts/${second.body.data.id}/confirm`)
      .set({ ...authHeaders(token, fixture.storeId), ...idem() })
      .send({})
      .expect(200);

    expect(await prisma.batch.count()).toBe(1);
    expect(await stockOf("PA250110")).toBe(2500);

    const movements = await prisma.stockMovement.findMany({ orderBy: { id: "asc" } });
    expect(movements.map((movement) => movement.balanceAfter)).toEqual([2000, 2500]);
  });

  it("cùng số lô nhưng khác hạn dùng thì bị chặn và không thay đổi gì", async () => {
    const first = await createDraft().expect(201);
    await api()
      .post(`/api/v1/goods-receipts/${first.body.data.id}/confirm`)
      .set({ ...authHeaders(token, fixture.storeId), ...idem() })
      .send({})
      .expect(200);

    const second = await createDraft(
      draftBody({ lines: [{ ...draftBody().lines[0], expiryDate: "2028-05-05" }] }),
    ).expect(201);

    const response = await api()
      .post(`/api/v1/goods-receipts/${second.body.data.id}/confirm`)
      .set({ ...authHeaders(token, fixture.storeId), ...idem() })
      .send({})
      .expect(409);

    expect(response.body.error.code).toBe("BATCH_EXPIRY_MISMATCH");
    expect(await stockOf("PA250110")).toBe(2000);
    expect(
      await prisma.goodsReceipt.findFirstOrThrow({ where: { id: second.body.data.id } }),
    ).toMatchObject({
      status: "DRAFT",
    });
  });
});

describe("Hủy phiếu và phân quyền", () => {
  it("hủy được phiếu còn nháp", async () => {
    const draft = await createDraft().expect(201);
    const response = await api()
      .post(`/api/v1/goods-receipts/${draft.body.data.id}/cancel`)
      .set({ ...authHeaders(token, fixture.storeId), ...idem() })
      .send({ reason: "Nhập nhầm nhà cung cấp" })
      .expect(200);

    expect(response.body.data.status).toBe("CANCELLED");
    expect(await prisma.batch.count()).toBe(0);
  });

  it("không hủy được phiếu đã xác nhận", async () => {
    const draft = await createDraft().expect(201);
    await api()
      .post(`/api/v1/goods-receipts/${draft.body.data.id}/confirm`)
      .set({ ...authHeaders(token, fixture.storeId), ...idem() })
      .send({})
      .expect(200);

    const response = await api()
      .post(`/api/v1/goods-receipts/${draft.body.data.id}/cancel`)
      .set({ ...authHeaders(token, fixture.storeId), ...idem() })
      .send({ reason: "Thử hủy" })
      .expect(409);

    expect(response.body.error.code).toBe("INVALID_STATE");
  });

  it("nhân viên bán hàng không được tạo phiếu nhập", async () => {
    const sales = await login("banhang");
    const response = await api()
      .post("/api/v1/goods-receipts")
      .set({ ...authHeaders(sales.token, fixture.storeId), ...idem() })
      .send(draftBody())
      .expect(403);

    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});
