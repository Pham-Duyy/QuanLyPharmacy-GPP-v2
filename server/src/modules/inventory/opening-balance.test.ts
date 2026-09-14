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
let categoryId: string;
let productId: string;
let unitId: string;

function idem(): Record<string, string> {
  return { "Idempotency-Key": randomUUID() };
}

function futureDate(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function submit(body: Record<string, unknown>) {
  return api()
    .post("/api/v1/inventory/opening-balances")
    .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
    .send(body);
}

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;

  categoryId = (await prisma.category.create({ data: { name: "Thuốc" } })).id;
  const product = await prisma.product.create({
    data: {
      code: "TH0001",
      name: "Paracetamol 500mg",
      productType: "DRUG",
      drugClass: "OTC",
      categoryId,
      units: { create: { name: "Hộp", conversionToBase: 100, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  productId = product.id;
  unitId = product.units[0]!.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Nhập tồn đầu kỳ", () => {
  it("tạo lô AVAILABLE và thẻ kho OPENING_BALANCE", async () => {
    const response = await submit({
      lines: [
        {
          productId,
          unitId,
          quantity: 5,
          batchNumber: "TDK001",
          expiryDate: futureDate(365),
          unitCost: 80000,
        },
      ],
    }).expect(201);

    expect(response.body.data.type ?? response.body.data.status).toBeTruthy();
    expect(response.body.data.status).toBe("CONFIRMED");

    const batch = await prisma.batch.findFirst({ where: { productId, batchNumber: "TDK001" } });
    expect(batch).toMatchObject({ status: "AVAILABLE", quantityOnHand: 500 });

    const movement = await prisma.stockMovement.findFirst({ where: { batchId: batch!.id } });
    expect(movement).toMatchObject({
      type: "OPENING_BALANCE",
      baseQuantity: 500,
      balanceAfter: 500,
    });
  });

  it("cộng dồn khi trùng số lô có cùng hạn dùng", async () => {
    await submit({
      lines: [
        {
          productId,
          unitId,
          quantity: 2,
          batchNumber: "TDK002",
          expiryDate: futureDate(200),
          unitCost: 80000,
        },
        {
          productId,
          unitId,
          quantity: 3,
          batchNumber: "TDK002",
          expiryDate: futureDate(200),
          unitCost: 80000,
        },
      ],
    }).expect(201);

    const batch = await prisma.batch.findFirst({ where: { productId, batchNumber: "TDK002" } });
    expect(batch?.quantityOnHand).toBe(500);
  });

  it("chặn trùng số lô nhưng khác hạn dùng", async () => {
    const response = await submit({
      lines: [
        {
          productId,
          unitId,
          quantity: 2,
          batchNumber: "TDK003",
          expiryDate: futureDate(100),
          unitCost: 80000,
        },
        {
          productId,
          unitId,
          quantity: 3,
          batchNumber: "TDK003",
          expiryDate: futureDate(200),
          unitCost: 80000,
        },
      ],
    }).expect(409);

    expect(response.body.error.code).toBe("BATCH_EXPIRY_MISMATCH");
  });

  it("chặn đơn vị không thuộc sản phẩm", async () => {
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

    const response = await submit({
      lines: [
        {
          productId,
          unitId: other.units[0]!.id,
          quantity: 1,
          batchNumber: "TDK004",
          expiryDate: futureDate(100),
          unitCost: 1000,
        },
      ],
    }).expect(422);

    expect(response.body.error.code).toBe("UNIT_NOT_IN_PRODUCT");
  });

  it("yêu cầu Idempotency-Key", async () => {
    const response = await api()
      .post("/api/v1/inventory/opening-balances")
      .set(authHeaders(adminToken, fixture.storeId))
      .send({
        lines: [
          {
            productId,
            unitId,
            quantity: 1,
            batchNumber: "TDK005",
            expiryDate: futureDate(100),
            unitCost: 1000,
          },
        ],
      })
      .expect(400);

    expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("từ chối khi cửa hàng đã có hóa đơn", async () => {
    // Tự tạo một lô và bán một hóa đơn để cửa hàng coi như đã vận hành.
    await prisma.productPrice.create({
      data: {
        productUnitId: unitId,
        salePrice: 95000n,
        vatRatePercent: 5,
        effectiveFrom: new Date(Date.now() - 86_400_000),
      },
    });
    await prisma.batch.create({
      data: {
        storeId: fixture.storeId,
        productId,
        batchNumber: "CO_SAN",
        expiryDate: new Date(futureDate(300)),
        quantityOnHand: 1000,
      },
    });
    await api()
      .post("/api/v1/invoices")
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({ lines: [{ productId, unitId, quantity: 1 }] })
      .expect(201);

    const response = await submit({
      lines: [
        {
          productId,
          unitId,
          quantity: 1,
          batchNumber: "TDK006",
          expiryDate: futureDate(100),
          unitCost: 1000,
        },
      ],
    }).expect(409);

    expect(response.body.error.code).toBe("INVALID_STATE");
  });

  it("xem lại được qua GET /goods-receipts vì dùng chung dữ liệu", async () => {
    const created = await submit({
      lines: [
        {
          productId,
          unitId,
          quantity: 1,
          batchNumber: "TDK007",
          expiryDate: futureDate(100),
          unitCost: 1000,
        },
      ],
    }).expect(201);

    const response = await api()
      .get(`/api/v1/goods-receipts/${created.body.data.id}`)
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    expect(response.body.data.status).toBe("CONFIRMED");
    expect(response.body.data.supplier).toBeNull();
  });
});
