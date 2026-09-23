import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../../test/helpers.js";

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let categoryId: string;
let supplierId: string;

const idem = () => ({ "Idempotency-Key": randomUUID() });
const h = (token = adminToken) => authHeaders(token, fixture.storeId);

type Made = { id: string; pillId: string; boxId: string };

async function makeProduct(code: string, name: string, minStock = 0): Promise<Made> {
  const product = await prisma.product.create({
    data: {
      code,
      name,
      productType: "DRUG",
      drugClass: "OTC",
      categoryId,
      minStockBaseQuantity: minStock,
      units: {
        create: [
          { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true },
          { name: "Hộp", conversionToBase: 100 },
        ],
      },
    },
    include: { units: true },
  });
  const pill = product.units.find((unit) => unit.name === "Viên")!;
  await prisma.productPrice.create({ data: { productUnitId: pill.id, salePrice: 1000n, vatRatePercent: 5, effectiveFrom: new Date(Date.now() - 86_400_000) } });
  return { id: product.id, pillId: pill.id, boxId: product.units.find((unit) => unit.name === "Hộp")!.id };
}

async function stock(productId: string, quantity: number, batchNumber = "L1") {
  const expiryDate = new Date();
  expiryDate.setUTCFullYear(expiryDate.getUTCFullYear() + 1);
  await prisma.batch.create({ data: { storeId: fixture.storeId, productId, batchNumber, expiryDate, quantityOnHand: quantity } });
}

/** Bán qua thẻ kho thật để tốc độ bán tính từ dữ liệu thật. */
async function sell(product: Made, quantity: number) {
  await api()
    .post("/api/v1/invoices")
    .set({ ...h(pharmacistToken), ...idem() })
    .send({ lines: [{ productId: product.id, unitId: product.pillId, quantity }] })
    .expect(201);
}

const suggest = async (query = "") => (await api().get(`/api/v1/purchase-suggestions${query}`).set(h()).expect(200)).body.data;
type SuggestionView = Record<string, unknown> & { code: string };
const find = (data: { items: SuggestionView[] }, code: string): SuggestionView | undefined => data.items.find((item) => item.code === code);

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [adminToken, pharmacistToken] = await Promise.all([login("admin").then((item) => item.token), login("duocsi").then((item) => item.token)]);
  categoryId = (await prisma.category.create({ data: { name: "Thuốc giảm đau" } })).id;
  supplierId = (await prisma.supplier.create({ data: { name: "Công ty Dược Minh Tâm", taxCode: "0301234567" } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Đề xuất đặt hàng", () => {
  it("đề xuất theo tốc độ bán, cộng thời gian chờ hàng và làm tròn theo đơn vị đặt", async () => {
    const product = await makeProduct("TH0001", "Paracetamol 500mg");
    await stock(product.id, 900);
    // Bán 600 viên trong kỳ 30 ngày → trung bình 20 viên/ngày, còn lại 300.
    await sell(product, 600);

    const data = await suggest("?windowDays=30&coverDays=30&leadTimeDays=7");
    const item = find(data, "TH0001")!;
    expect(item).toMatchObject({
      sellableBaseQuantity: 300,
      soldBaseQuantity: 600,
      avgDailyBaseQuantity: 20,
      daysOfStock: 15,
      // 20 viên/ngày × (30 + 7) = 740 viên; còn 300 → thiếu 440 → 5 hộp (500 viên).
      targetBaseQuantity: 740,
      suggestedOrderQuantity: 5,
      suggestedBaseQuantity: 500,
      // Còn bán được 15 ngày, dài hơn 7 ngày chờ hàng, nhưng vẫn phải bổ sung cho kỳ tới.
      reason: "REFILL",
    });
    expect((item.orderUnit as { name: string }).name).toBe("Hộp");
  });

  it("hết hàng và dưới tồn tối thiểu được xếp lên trước", async () => {
    const out = await makeProduct("TH0002", "Amoxicillin 500mg", 100);
    const low = await makeProduct("TH0003", "Vitamin C", 200);
    const fine = await makeProduct("TH0004", "Oresol");
    await stock(low.id, 50);
    await stock(fine.id, 500);
    await sell(fine, 10);

    const data = await suggest();
    expect(data.items.map((item: { code: string }) => item.code)).toEqual(["TH0002", "TH0003"]);
    expect(find(data, "TH0002")).toMatchObject({ reason: "OUT_OF_STOCK", suggestedBaseQuantity: 100, suggestedOrderQuantity: 1 });
    expect(find(data, "TH0003")).toMatchObject({ reason: "BELOW_MIN", targetBaseQuantity: 200, suggestedBaseQuantity: 200 });
    expect(data.summary).toMatchObject({ total: 2, outOfStock: 1, belowMin: 1 });
    // Hàng còn đủ bán thì không đề xuất, trừ khi xem toàn bộ danh mục.
    expect(find(data, "TH0004")).toBeUndefined();
    const all = await suggest("?onlyNeeded=false");
    expect(find(all, "TH0004")).toMatchObject({ reason: "OK", suggestedOrderQuantity: 0 });
  });

  it("trừ hàng đã lập phiếu nhập nhưng chưa kiểm nhập", async () => {
    const product = await makeProduct("TH0005", "Omeprazole 20mg", 500);
    await stock(product.id, 100);

    const before = await suggest();
    expect(find(before, "TH0005")).toMatchObject({ onOrderBaseQuantity: 0, suggestedBaseQuantity: 400 });

    const expiry = new Date();
    expiry.setUTCFullYear(expiry.getUTCFullYear() + 2);
    await api()
      .post("/api/v1/goods-receipts")
      .set({ ...h(pharmacistToken), ...idem() })
      .send({
        supplierId,
        lines: [{ productId: product.id, unitId: product.boxId, quantity: 3, unitCost: 80000, batchNumber: "NEW1", expiryDate: expiry.toISOString().slice(0, 10) }],
      })
      .expect(201);

    const after = await suggest();
    // 300 viên đang trên đường về → chỉ còn thiếu 100 viên, làm tròn 1 hộp.
    expect(find(after, "TH0005")).toMatchObject({ onOrderBaseQuantity: 300, suggestedBaseQuantity: 100, suggestedOrderQuantity: 1 });
  });

  it("gợi ý nhà cung cấp và đơn giá theo lần nhập gần nhất", async () => {
    const product = await makeProduct("TH0006", "Cetirizin 10mg", 1000);
    const expiry = new Date();
    expiry.setUTCFullYear(expiry.getUTCFullYear() + 2);
    const receipt = await api()
      .post("/api/v1/goods-receipts")
      .set({ ...h(pharmacistToken), ...idem() })
      .send({
        supplierId,
        lines: [{ productId: product.id, unitId: product.boxId, quantity: 2, unitCost: 75000, batchNumber: "CET1", expiryDate: expiry.toISOString().slice(0, 10) }],
      })
      .expect(201);
    await api()
      .post(`/api/v1/goods-receipts/${receipt.body.data.id}/confirm`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({ lines: receipt.body.data.lines.map((line: { id: string }) => ({ lineId: line.id, passed: true })) })
      .expect(200);

    const data = await suggest();
    const item = find(data, "TH0006")!;
    expect(item.lastSupplier).toMatchObject({ name: "Công ty Dược Minh Tâm" });
    expect(item).toMatchObject({ lastUnitCost: 75000, suggestedOrderQuantity: 8, estimatedCost: 600000 });
    expect((item.orderUnit as { name: string }).name).toBe("Hộp");
    expect(data.summary.estimatedCost).toBe(600000);
    expect(data.summary.withoutSupplier).toBe(0);
  });

  it("lọc theo nhóm hàng, tìm theo tên và kiểm tra tham số", async () => {
    const otherCategory = await prisma.category.create({ data: { name: "Vitamin" } });
    await makeProduct("TH0007", "Paracetamol 500mg", 100);
    const vitamin = await prisma.product.create({
      data: { code: "TP0001", name: "Vitamin C 500mg", productType: "SUPPLEMENT", categoryId: otherCategory.id, minStockBaseQuantity: 50, units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } } },
    });
    void vitamin;

    expect((await suggest(`?categoryId=${otherCategory.id}`)).items.map((item: { code: string }) => item.code)).toEqual(["TP0001"]);
    expect((await suggest("?search=paracetamol")).items.map((item: { code: string }) => item.code)).toEqual(["TH0007"]);
    await api().get("/api/v1/purchase-suggestions?windowDays=2").set(h()).expect(422);
    await api().get("/api/v1/purchase-suggestions?coverDays=999").set(h()).expect(422);
  });

  it("không thấy dữ liệu của cửa hàng khác và cần quyền xem tồn kho", async () => {
    const product = await makeProduct("TH0008", "Loratadin 10mg", 100);
    await prisma.batch.create({
      data: { storeId: fixture.otherStoreId, productId: product.id, batchNumber: "OTHER", expiryDate: new Date("2030-01-01"), quantityOnHand: 999 },
    });

    // Tồn nằm ở cửa hàng khác nên cửa hàng này vẫn phải đặt hàng.
    expect(find(await suggest(), "TH0008")).toMatchObject({ sellableBaseQuantity: 0, suggestedBaseQuantity: 100 });
    await api().get("/api/v1/purchase-suggestions").expect(401);
  });
});
