import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  useTestRole,
  type Fixture,
} from "../../test/helpers.js";
import { normalizeShelfLocation } from "./shelf-location.js";

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let productId: string;
let unitId: string;
let supplierId: string;

const idem = () => ({ "Idempotency-Key": randomUUID() });
const h = (token = pharmacistToken, storeId = fixture.storeId) => authHeaders(token, storeId);

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [adminToken, pharmacistToken] = await Promise.all([
    login("admin").then((item) => item.token),
    login("duocsi").then((item) => item.token),
  ]);
  const category = await prisma.category.create({ data: { name: "Thuốc giảm đau" } });
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
  productId = product.id;
  unitId = product.units[0]!.id;
  supplierId = (await prisma.supplier.create({ data: { name: "Công ty Dược Minh Tâm" } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Nhập một lô rồi kiểm nhập, kèm vị trí nếu có. Trả id lô. */
async function receive(batchNumber: string, expiryDate: string, shelfLocation?: string) {
  const created = await api()
    .post("/api/v1/goods-receipts")
    .set({ ...h(), ...idem() })
    .send({
      supplierId,
      lines: [{ productId, unitId, quantity: 10, unitCost: 1000, batchNumber, expiryDate }],
    })
    .expect(201);
  await api()
    .post(`/api/v1/goods-receipts/${created.body.data.id}/confirm`)
    .set({ ...h(), ...idem() })
    .send({
      lines: [{ lineId: created.body.data.lines[0].id, passed: true, shelfLocation }],
    })
    .expect(200);
  return (await prisma.batch.findFirstOrThrow({ where: { batchNumber } })).id;
}

describe("Vị trí tủ–kệ–ngăn của lô", () => {
  it("chuẩn hóa: viết hoa, bỏ khoảng trắng thừa, rỗng là chưa có", () => {
    expect(normalizeShelfLocation("  a-02-03 ")).toBe("A-02-03");
    expect(normalizeShelfLocation("tủ   lạnh")).toBe("TỦ LẠNH");
    expect(normalizeShelfLocation("   ")).toBeNull();
    expect(normalizeShelfLocation(null)).toBeNull();
  });

  it("ghi vị trí lúc kiểm nhập; lô sau không chọn thì lấy vị trí cũ của cùng thuốc", async () => {
    const first = await receive("L1", "2028-06-30", " a-02-03 ");
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: first } })).shelfLocation).toBe(
      "A-02-03",
    );

    const second = await receive("L2", "2028-12-31");
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: second } })).shelfLocation).toBe(
      "A-02-03",
    );

    const hints = (
      await api()
        .get("/api/v1/inventory/batches/locations")
        .query({ productIds: productId })
        .set(h())
        .expect(200)
    ).body.data;
    expect(hints).toEqual({ locations: ["A-02-03"], byProduct: { [productId]: "A-02-03" } });
  });

  it("dời lô sang kệ khác có ghi nhật ký; không sửa được lô cửa hàng khác; kiểm toán không sửa được", async () => {
    const batchId = await receive("L1", "2028-06-30", "A-02-03");
    const moved = await api()
      .patch(`/api/v1/inventory/batches/${batchId}/location`)
      .set(h())
      .send({ shelfLocation: "b-01-01" })
      .expect(200);
    expect(moved.body.data.shelfLocation).toBe("B-01-01");
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "BATCH_LOCATION_UPDATE" },
    });
    expect(audit).toMatchObject({
      before: { shelfLocation: "A-02-03" },
      after: { shelfLocation: "B-01-01" },
    });

    await api()
      .patch(`/api/v1/inventory/batches/${batchId}/location`)
      .set(h(adminToken, fixture.otherStoreId))
      .send({ shelfLocation: "C-01-01" })
      .expect(404);

    await useTestRole(fixture.salesId, "auditor", fixture.storeId);
    const auditor = (await login("banhang")).token;
    await api()
      .patch(`/api/v1/inventory/batches/${batchId}/location`)
      .set(h(auditor))
      .send({ shelfLocation: "C-01-01" })
      .expect(403);
  });

  it("quầy bán thấy vị trí của lô sẽ bán trước (hạn dùng gần nhất)", async () => {
    await prisma.productPrice.create({
      data: {
        productUnitId: unitId,
        salePrice: 2000n,
        vatRatePercent: 0,
        effectiveFrom: new Date("2026-01-01"),
      },
    });
    await receive("XA", "2029-12-31", "B-05-01");
    await receive("GAN", "2028-03-31", "A-01-02");

    const list = (
      await api().get("/api/v1/products").query({ inStock: "true" }).set(h()).expect(200)
    ).body.data.items;
    expect(list[0]).toMatchObject({ id: productId, shelfLocation: "A-01-02" });
  });

  it("nhập tồn đầu kỳ kèm vị trí", async () => {
    await api()
      .post("/api/v1/inventory/opening-balances")
      .set({ ...h(adminToken), ...idem() })
      .send({
        lines: [
          {
            productId,
            unitId,
            quantity: 5,
            batchNumber: "TD1",
            expiryDate: "2028-01-31",
            unitCost: 900,
            shelfLocation: "tủ lạnh",
          },
        ],
      })
      .expect(201);
    expect(
      (await prisma.batch.findFirstOrThrow({ where: { batchNumber: "TD1" } })).shelfLocation,
    ).toBe("TỦ LẠNH");
  });
});
