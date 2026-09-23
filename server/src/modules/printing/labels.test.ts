import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../../test/helpers.js";

let fixture: Fixture;
let adminToken: string;
let salesToken: string;
let categoryId: string;
let withBarcode: { id: string; pillId: string; boxId: string };
let withoutBarcode: { id: string; pillId: string };

const h = (token = adminToken) => authHeaders(token, fixture.storeId);

async function makeProduct(code: string, name: string, barcodes: { pill?: string; box?: string } = {}) {
  const product = await prisma.product.create({
    data: {
      code,
      name,
      productType: "DRUG",
      drugClass: "OTC",
      categoryId,
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
  const box = product.units.find((unit) => unit.name === "Hộp")!;
  if (barcodes.pill) await prisma.productBarcode.create({ data: { productUnitId: pill.id, barcode: barcodes.pill } });
  if (barcodes.box) await prisma.productBarcode.create({ data: { productUnitId: box.id, barcode: barcodes.box } });
  await prisma.productPrice.create({ data: { productUnitId: pill.id, salePrice: 1500n, vatRatePercent: 5, effectiveFrom: new Date(Date.now() - 86_400_000) } });
  return { id: product.id, pillId: pill.id, boxId: box.id };
}

function print(body: Record<string, unknown>, token = adminToken, query = "") {
  return api().post(`/api/v1/labels/print${query}`).set(h(token)).send(body).buffer(true).type("json");
}

const warningsOf = (response: { headers: Record<string, string> }) =>
  JSON.parse(decodeURIComponent(response.headers["x-label-warnings"] ?? "%5B%5D")) as Array<{ productName: string; message: string }>;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [adminToken, salesToken] = await Promise.all([login("admin").then((item) => item.token), login("banhang").then((item) => item.token)]);
  categoryId = (await prisma.category.create({ data: { name: "Thuốc giảm đau" } })).id;
  // 8935049500001 là mã EAN-13 hợp lệ (đầu 893 của Việt Nam, số kiểm 1).
  withBarcode = await makeProduct("TH0001", "Paracetamol 500mg", { pill: "8935049500001" });
  withoutBarcode = await makeProduct("TH0002", "Thuốc chưa có mã vạch");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Khổ tem", () => {
  it("liệt kê các khổ tem hỗ trợ", async () => {
    const sizes = (await api().get("/api/v1/labels/sizes").set(h()).expect(200)).body.data;
    expect(sizes.map((item: { value: string }) => item.value)).toEqual(["50x30", "40x30", "35x22", "A4_38x21"]);
    expect(sizes[0]).toMatchObject({ width: 50, height: 30, sheet: false });
    expect(sizes.at(-1)).toMatchObject({ width: 38, height: 21, sheet: true });
  });
});

describe("In tem mã vạch", () => {
  it("in đúng số tem, kèm tên thuốc, mã vạch và giá theo đơn vị", async () => {
    const response = await print({ size: "50x30", items: [{ productId: withBarcode.id, unitId: withBarcode.pillId, quantity: 3 }] }).expect(200);

    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["x-label-count"]).toBe("3");
    const html = response.text;
    expect(html.match(/class="label"/g)).toHaveLength(3);
    expect(html).toContain("Paracetamol 500mg");
    expect(html).toContain("8935049500001");
    // EAN-13 luôn có đúng 30 cụm vạch; in nhầm sang Code128 thì số này khác ngay.
    expect(html.match(/<rect /g)).toHaveLength(3 * 30);
    expect(html).toContain("1.500 đ/Viên");
    expect(html).toContain("Nhà thuốc kiểm thử 1");
    // Khổ tem nhiệt: mỗi tem một trang đúng kích thước.
    expect(html).toContain("@page { size: 50mm 30mm; margin: 0; }");
    expect(html).toContain("<svg");
    expect(warningsOf(response)).toEqual([]);
  });

  it("thuốc chưa có mã vạch thì in mã nội bộ và nói rõ, không bịa mã EAN", async () => {
    const response = await print({ items: [{ productId: withoutBarcode.id, unitId: withoutBarcode.pillId, quantity: 1 }] }).expect(200);

    expect(response.text).toContain("TH0002");
    expect(response.text).toContain("mã nội bộ");
    expect(warningsOf(response)[0]).toMatchObject({ productName: "Thuốc chưa có mã vạch", message: expect.stringContaining("mã nội bộ") });
  });

  it("đơn vị chưa có mã vạch riêng thì dùng mã của đơn vị khác và cảnh báo", async () => {
    const response = await print({ items: [{ productId: withBarcode.id, unitId: withBarcode.boxId, quantity: 1 }] }).expect(200);

    expect(response.text).toContain("8935049500001");
    expect(warningsOf(response)[0]!.message).toContain("chưa có mã vạch riêng");
  });

  it("đơn vị chưa có giá thì in tem không kèm giá và báo cho người in", async () => {
    const response = await print({ items: [{ productId: withBarcode.id, unitId: withBarcode.boxId, quantity: 1 }] }).expect(200);

    expect(response.text).not.toContain("đ/Hộp");
    expect(response.text).toContain(">Hộp<");
    expect(warningsOf(response).some((warning) => warning.message.includes("chưa có giá bán"))).toBe(true);
  });

  it("in tem theo lô thì có số lô và hạn dùng", async () => {
    const batch = await prisma.batch.create({
      data: { storeId: fixture.storeId, productId: withBarcode.id, batchNumber: "PA260901", expiryDate: new Date("2028-09-01"), quantityOnHand: 100 },
    });

    const response = await print({
      size: "40x30",
      showBatch: true,
      items: [{ productId: withBarcode.id, unitId: withBarcode.pillId, batchId: batch.id, quantity: 2 }],
    }).expect(200);

    expect(response.text).toContain("Lô PA260901");
    expect(response.text).toContain("HSD 01/09/2028");
    expect(response.headers["x-label-count"]).toBe("2");
  });

  it("giấy decal A4 xếp lưới nhiều tem trên một trang", async () => {
    const response = await print({ size: "A4_38x21", items: [{ productId: withBarcode.id, quantity: 12 }] }).expect(200);

    expect(response.text).toContain("@page { size: A4; margin: 10mm 6mm; }");
    expect(response.text).toContain("grid-template-columns: repeat(5, 38mm)");
    expect(response.text.match(/class="label"/g)).toHaveLength(12);
  });

  it("xem trước thì không tự bật hộp thoại in", async () => {
    const preview = await print({ items: [{ productId: withBarcode.id, quantity: 1 }] }, adminToken, "?autoprint=0").expect(200);
    expect(preview.text).not.toContain("window.print()");

    const toPrint = await print({ items: [{ productId: withBarcode.id, quantity: 1 }] }).expect(200);
    expect(toPrint.text).toContain("window.print()");
  });

  it("không in tem cho lô của cửa hàng khác", async () => {
    const otherBatch = await prisma.batch.create({
      data: { storeId: fixture.otherStoreId, productId: withBarcode.id, batchNumber: "KHAC", expiryDate: new Date("2028-01-01"), quantityOnHand: 10 },
    });
    const response = await print({ showBatch: true, items: [{ productId: withBarcode.id, batchId: otherBatch.id, quantity: 1 }] }).expect(422);
    expect(response.body.error.message).toContain("không tìm thấy lô");
  });

  it("mã vạch trong danh mục sai số kiểm thì in Code128 và cảnh báo", async () => {
    const wrong = await makeProduct("TH0003", "Thuốc mã sai số kiểm", { pill: "8935049500005" });
    const response = await print({ items: [{ productId: wrong.id, unitId: wrong.pillId, quantity: 1 }] }).expect(200);

    expect(response.text).toContain("8935049500005");
    expect(warningsOf(response)[0]!.message).toContain("sai số kiểm");
  });

  it("kiểm tra dữ liệu đầu vào và quyền", async () => {
    await print({ items: [] }).expect(422);
    await print({ items: [{ productId: withBarcode.id, quantity: 0 }] }).expect(422);
    await print({ items: [{ productId: withBarcode.id, quantity: 501 }] }).expect(422);
    await print({ size: "99x99", items: [{ productId: withBarcode.id, quantity: 1 }] }).expect(422);
    // Nhân viên bán hàng có catalog.read nên in được tem giá.
    await print({ items: [{ productId: withBarcode.id, quantity: 1 }] }, salesToken).expect(200);
    await api().post("/api/v1/labels/print").send({ items: [] }).expect(401);
  });
});
