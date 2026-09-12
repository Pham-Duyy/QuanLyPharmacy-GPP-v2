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
let categoryId: string;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  token = (await login("admin")).token;

  const category = await prisma.category.create({ data: { name: "Thuốc giảm đau" } });
  categoryId = category.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function newProduct(overrides: Record<string, unknown> = {}) {
  return {
    code: "TH0001",
    name: "Paracetamol 500mg",
    productType: "DRUG",
    drugClass: "OTC",
    categoryId,
    baseUnitName: "Viên",
    ...overrides,
  };
}

describe("Tạo sản phẩm", () => {
  it("tạo sản phẩm kèm đơn vị cơ bản trong cùng một lần gọi", async () => {
    const response = await api()
      .post("/api/v1/products")
      .set(authHeaders(token, fixture.storeId))
      .send(newProduct())
      .expect(201);

    const units = await prisma.productUnit.findMany({
      where: { productId: response.body.data.id },
    });
    expect(units).toHaveLength(1);
    expect(units[0]?.conversionToBase).toBe(1);
    expect(units[0]?.isDefaultSaleUnit).toBe(true);
  });

  it("chặn thuốc không có phân loại kê đơn", async () => {
    const response = await api()
      .post("/api/v1/products")
      .set(authHeaders(token, fixture.storeId))
      .send(newProduct({ drugClass: undefined }))
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details[0].field).toBe("drugClass");
  });

  it("chặn hàng không phải thuốc mà lại có phân loại kê đơn", async () => {
    await api()
      .post("/api/v1/products")
      .set(authHeaders(token, fixture.storeId))
      .send(newProduct({ productType: "MEDICAL_DEVICE", drugClass: "OTC" }))
      .expect(422);
  });

  it("chặn trùng mã sản phẩm", async () => {
    await api()
      .post("/api/v1/products")
      .set(authHeaders(token, fixture.storeId))
      .send(newProduct())
      .expect(201);
    const response = await api()
      .post("/api/v1/products")
      .set(authHeaders(token, fixture.storeId))
      .send(newProduct({ name: "Tên khác" }))
      .expect(409);

    expect(response.body.error.code).toBe("DUPLICATE");
  });
});

describe("Sửa sản phẩm", () => {
  it("từ chối khi version không khớp, giữ nguyên dữ liệu cũ", async () => {
    const created = await api()
      .post("/api/v1/products")
      .set(authHeaders(token, fixture.storeId))
      .send(newProduct())
      .expect(201);

    const response = await api()
      .patch(`/api/v1/products/${created.body.data.id}`)
      .set(authHeaders(token, fixture.storeId))
      .send({ name: "Tên mới", version: 99 })
      .expect(409);

    expect(response.body.error.code).toBe("VERSION_CONFLICT");
    const product = await prisma.product.findUniqueOrThrow({ where: { id: created.body.data.id } });
    expect(product.name).toBe("Paracetamol 500mg");
  });

  it("tăng version sau mỗi lần sửa thành công", async () => {
    const created = await api()
      .post("/api/v1/products")
      .set(authHeaders(token, fixture.storeId))
      .send(newProduct())
      .expect(201);

    const updated = await api()
      .patch(`/api/v1/products/${created.body.data.id}`)
      .set(authHeaders(token, fixture.storeId))
      .send({ name: "Paracetamol 500mg (hộp mới)", version: 1 })
      .expect(200);

    expect(updated.body.data.version).toBe(2);
  });
});

describe("Đơn vị quy đổi và mã vạch", () => {
  it("thêm đơn vị mới và chuyển cờ đơn vị bán mặc định sang đơn vị đó", async () => {
    const created = await api()
      .post("/api/v1/products")
      .set(authHeaders(token, fixture.storeId))
      .send(newProduct())
      .expect(201);
    const productId = created.body.data.id as string;

    await api()
      .post(`/api/v1/products/${productId}/units`)
      .set(authHeaders(token, fixture.storeId))
      .send({
        name: "Vỉ",
        conversionToBase: 10,
        isDefaultSaleUnit: true,
        barcodes: ["8934567000011"],
      })
      .expect(201);

    const units = await prisma.productUnit.findMany({
      where: { productId },
      orderBy: { conversionToBase: "asc" },
    });
    expect(units.map((unit) => [unit.name, unit.conversionToBase, unit.isDefaultSaleUnit])).toEqual(
      [
        ["Viên", 1, false],
        ["Vỉ", 10, true],
      ],
    );
  });

  it("chặn dùng lại mã vạch đã thuộc sản phẩm khác", async () => {
    const first = await api()
      .post("/api/v1/products")
      .set(authHeaders(token, fixture.storeId))
      .send(newProduct())
      .expect(201);
    await api()
      .post(`/api/v1/products/${first.body.data.id}/units`)
      .set(authHeaders(token, fixture.storeId))
      .send({ name: "Vỉ", conversionToBase: 10, barcodes: ["8934567000011"] })
      .expect(201);

    const second = await api()
      .post("/api/v1/products")
      .set(authHeaders(token, fixture.storeId))
      .send(newProduct({ code: "TH0002", name: "Thuốc khác" }))
      .expect(201);

    const response = await api()
      .post(`/api/v1/products/${second.body.data.id}/units`)
      .set(authHeaders(token, fixture.storeId))
      .send({ name: "Vỉ", conversionToBase: 10, barcodes: ["8934567000011"] })
      .expect(409);

    expect(response.body.error.code).toBe("DUPLICATE");
  });

  it("quét mã vạch trả đúng sản phẩm, đơn vị và giá hiện hành", async () => {
    const created = await api()
      .post("/api/v1/products")
      .set(authHeaders(token, fixture.storeId))
      .send(newProduct())
      .expect(201);
    const unit = await api()
      .post(`/api/v1/products/${created.body.data.id}/units`)
      .set(authHeaders(token, fixture.storeId))
      .send({ name: "Vỉ", conversionToBase: 10, barcodes: ["8934567000011"] })
      .expect(201);
    await api()
      .post(`/api/v1/products/${created.body.data.id}/prices`)
      .set(authHeaders(token, fixture.storeId))
      .send({ unitId: unit.body.data.id, salePrice: 11000, vatRatePercent: 5 })
      .expect(201);

    const response = await api()
      .get("/api/v1/product-units/by-barcode/8934567000011")
      .set(authHeaders(token, fixture.storeId))
      .expect(200);

    expect(response.body.data.product.name).toBe("Paracetamol 500mg");
    expect(response.body.data.unit.conversionToBase).toBe(10);
    expect(response.body.data.currentPrice.salePrice).toBe(11000);
  });
});

describe("Bảng giá", () => {
  it("giá riêng của cửa hàng đè lên giá chung toàn chuỗi", async () => {
    const created = await api()
      .post("/api/v1/products")
      .set(authHeaders(token, fixture.storeId))
      .send(newProduct())
      .expect(201);
    const productId = created.body.data.id as string;
    const unitId = (await prisma.productUnit.findFirstOrThrow({ where: { productId } })).id;
    const headers = authHeaders(token, fixture.storeId);

    await api()
      .post(`/api/v1/products/${productId}/prices`)
      .set(headers)
      .send({ unitId, salePrice: 1200, vatRatePercent: 5 })
      .expect(201);
    await api()
      .post(`/api/v1/products/${productId}/prices`)
      .set(headers)
      .send({ unitId, salePrice: 1100, vatRatePercent: 5, scope: "STORE" })
      .expect(201);

    const response = await api()
      .get(`/api/v1/products/${productId}/prices`)
      .set(headers)
      .expect(200);
    expect(response.body.data.units[0].currentPrice.salePrice).toBe(1100);
    expect(response.body.data.units[0].currentPrice.isStoreOverride).toBe(true);
    expect(response.body.data.units[0].history).toHaveLength(2);

    // Cửa hàng khác vẫn dùng giá chung toàn chuỗi.
    const other = await api()
      .get(`/api/v1/products/${productId}/prices`)
      .set(authHeaders(token, fixture.otherStoreId))
      .expect(200);
    expect(other.body.data.units[0].currentPrice.salePrice).toBe(1200);
    expect(other.body.data.units[0].currentPrice.isStoreOverride).toBe(false);
  });

  it("đặt giá riêng cho cửa hàng mà thiếu X-Store-Id thì bị chặn", async () => {
    const created = await api()
      .post("/api/v1/products")
      .set(authHeaders(token, fixture.storeId))
      .send(newProduct())
      .expect(201);
    const unitId = (
      await prisma.productUnit.findFirstOrThrow({
        where: { productId: created.body.data.id },
      })
    ).id;

    const response = await api()
      .post(`/api/v1/products/${created.body.data.id}/prices`)
      .set(authHeaders(token))
      .send({ unitId, salePrice: 1000, vatRatePercent: 5, scope: "STORE" })
      .expect(400);

    expect(response.body.error.code).toBe("STORE_REQUIRED");
  });
});

describe("Tìm kiếm sản phẩm", () => {
  beforeEach(async () => {
    const ingredient = await prisma.activeIngredient.create({ data: { name: "Paracetamol" } });
    const created = await api()
      .post("/api/v1/products")
      .set(authHeaders(token, fixture.storeId))
      .send(
        newProduct({ name: "Thuốc ho Bảo Thanh", ingredients: [{ ingredientId: ingredient.id }] }),
      )
      .expect(201);
    expect(created.body.data.id).toBeTruthy();
  });

  it("tìm được khi gõ không dấu", async () => {
    const response = await api()
      .get("/api/v1/products?search=thuoc ho")
      .set(authHeaders(token, fixture.storeId))
      .expect(200);
    expect(response.body.data.items[0].name).toBe("Thuốc ho Bảo Thanh");
  });

  it("tìm được theo mã sản phẩm", async () => {
    const response = await api()
      .get("/api/v1/products?search=TH0001")
      .set(authHeaders(token, fixture.storeId))
      .expect(200);
    expect(response.body.data.pagination.total).toBe(1);
  });

  it("tìm được theo tên hoạt chất", async () => {
    const response = await api()
      .get("/api/v1/products?search=paracetamol")
      .set(authHeaders(token, fixture.storeId))
      .expect(200);
    expect(response.body.data.items[0].name).toBe("Thuốc ho Bảo Thanh");
  });
});
