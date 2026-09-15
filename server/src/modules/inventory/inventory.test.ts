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

async function makeBatch(
  status: "AVAILABLE" | "QUARANTINED" | "RECALLED" = "AVAILABLE",
  quantity = 50,
  expiryOffsetDays = 365,
  storeId = fixture.storeId,
  ownProductId = productId,
) {
  const expiryDate = new Date();
  expiryDate.setUTCDate(expiryDate.getUTCDate() + expiryOffsetDays);
  return prisma.batch.create({
    data: {
      storeId,
      productId: ownProductId,
      batchNumber: `L-${randomUUID().slice(0, 8)}`,
      expiryDate,
      quantityOnHand: quantity,
      status,
    },
  });
}

async function makeMovement(
  batchId: string,
  type: string,
  baseQuantity: number,
  balanceAfter: number,
  overrides: Partial<{ storeId: string; productId: string }> = {},
) {
  return prisma.stockMovement.create({
    data: {
      storeId: overrides.storeId ?? fixture.storeId,
      batchId,
      productId: overrides.productId ?? productId,
      type,
      baseQuantity,
      balanceAfter,
      sourceType: "TEST",
      sourceId: randomUUID(),
      sourceLineId: randomUUID(),
    },
  });
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
      minStockBaseQuantity: 100,
      units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
    },
  });
  productId = product.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Tồn tổng hợp theo sản phẩm", () => {
  it("gộp đúng theo trạng thái và hạn dùng lô", async () => {
    await makeBatch("AVAILABLE", 30, 365);
    await makeBatch("QUARANTINED", 20, 365);
    await makeBatch("RECALLED", 5, 365);
    await makeBatch("AVAILABLE", 10, -1); // đã hết hạn

    const response = await api()
      .get("/api/v1/inventory")
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    const item = response.body.data.items.find(
      (row: { productId: string }) => row.productId === productId,
    );
    expect(item.stock).toEqual({ sellable: 30, quarantined: 20, recalled: 5, expired: 10 });
  });

  it("lọc belowMinStock: chỉ trả sản phẩm có tồn bán được dưới tối thiểu", async () => {
    await makeBatch("AVAILABLE", 30, 365); // dưới mức tối thiểu 100

    const other = await prisma.product.create({
      data: {
        code: "TH0002",
        name: "Amoxicillin 500mg",
        productType: "DRUG",
        drugClass: "RX",
        categoryId,
        minStockBaseQuantity: 10,
        units: { create: { name: "Viên", conversionToBase: 1 } },
      },
    });
    await makeBatch("AVAILABLE", 500, 365, fixture.storeId, other.id); // trên mức tối thiểu

    const response = await api()
      .get("/api/v1/inventory")
      .query({ belowMinStock: "true" })
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    const ids = response.body.data.items.map((row: { productId: string }) => row.productId);
    expect(ids).toContain(productId);
    expect(ids).not.toContain(other.id);
  });

  it("tìm theo tên không dấu hoặc mã sản phẩm", async () => {
    await prisma.product.create({
      data: {
        code: "TH0009",
        name: "Thuốc ho Bảo Thanh",
        productType: "DRUG",
        drugClass: "OTC",
        categoryId,
        units: { create: { name: "Chai", conversionToBase: 1 } },
      },
    });

    const byName = await api()
      .get("/api/v1/inventory")
      .query({ search: "thuoc ho" })
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);
    expect(byName.body.data.items.map((row: { code: string }) => row.code)).toEqual(["TH0009"]);

    const byCode = await api()
      .get("/api/v1/inventory")
      .query({ search: "th0001" })
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);
    expect(byCode.body.data.items.map((row: { code: string }) => row.code)).toEqual(["TH0001"]);
  });

  it("không tính tồn của cửa hàng khác", async () => {
    await makeBatch("AVAILABLE", 30, 365, fixture.otherStoreId);

    const response = await api()
      .get("/api/v1/inventory")
      .query({ productId })
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    expect(response.body.data.items[0].stock).toEqual({
      sellable: 0,
      quarantined: 0,
      recalled: 0,
      expired: 0,
    });
  });
});

describe("Thẻ kho", () => {
  it("lọc theo batchId và type", async () => {
    const batch = await makeBatch();
    const other = await makeBatch();
    await makeMovement(batch.id, "RECEIPT", 50, 50);
    await makeMovement(batch.id, "SALE", -5, 45);
    await makeMovement(other.id, "RECEIPT", 20, 20);

    const response = await api()
      .get("/api/v1/inventory/transactions")
      .query({ batchId: batch.id, type: "SALE" })
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0]).toMatchObject({
      type: "SALE",
      baseQuantity: -5,
      balanceAfter: 45,
      batchId: batch.id,
    });
  });

  it("phân trang theo con trỏ, mới nhất trước", async () => {
    const batch = await makeBatch();
    for (let i = 0; i < 5; i++) {
      await makeMovement(batch.id, "RECEIPT", 10, (i + 1) * 10);
    }

    const first = await api()
      .get("/api/v1/inventory/transactions")
      .query({ batchId: batch.id, limit: 2 })
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.items[0].balanceAfter).toBe(50);
    expect(first.body.data.items[1].balanceAfter).toBe(40);
    expect(first.body.data.nextCursor).toBeTruthy();

    const second = await api()
      .get("/api/v1/inventory/transactions")
      .query({ batchId: batch.id, limit: 2, cursor: first.body.data.nextCursor })
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    expect(second.body.data.items).toHaveLength(2);
    expect(second.body.data.items[0].balanceAfter).toBe(30);
    expect(second.body.data.items[1].balanceAfter).toBe(20);
  });

  it("không thấy thẻ kho của cửa hàng khác", async () => {
    const batch = await makeBatch("AVAILABLE", 50, 365, fixture.otherStoreId);
    await makeMovement(batch.id, "RECEIPT", 50, 50, { storeId: fixture.otherStoreId });

    const response = await api()
      .get("/api/v1/inventory/transactions")
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    expect(response.body.data.items).toHaveLength(0);
  });
});
