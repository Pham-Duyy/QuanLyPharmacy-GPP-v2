import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db/prisma.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  type Fixture,
} from "../test/helpers.js";

/**
 * Dữ liệu biên ở các form nhập tay (Phase 7, bước 7.1, D28). Mỗi ca ở đây là
 * một lỗi tìm được khi rà: trước khi sửa, máy chủ nhận dữ liệu sai hoặc trả 500.
 */

let fixture: Fixture;
let token: string;
let categoryId: string;
let productId: string;
let unitId: string;
let supplierId: string;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  token = (await login("admin")).token;
  categoryId = (await prisma.category.create({ data: { name: "Thuốc giảm đau" } })).id;
  const product = await prisma.product.create({
    data: {
      code: "TH0001",
      name: "Paracetamol 500mg",
      productType: "DRUG",
      drugClass: "OTC",
      categoryId,
      units: {
        create: {
          name: "Viên",
          conversionToBase: 1,
          isDefaultSaleUnit: true,
          barcodes: { create: { barcode: "8934567000011" } },
        },
      },
    },
    include: { units: true },
  });
  productId = product.id;
  unitId = product.units[0]!.id;
  supplierId = (
    await prisma.supplier.create({ data: { name: "Công ty Dược A", taxCode: "0100108536" } })
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const post = (path: string, body: unknown) =>
  api()
    .post(`/api/v1${path}`)
    .set({ ...authHeaders(token, fixture.storeId), "Idempotency-Key": randomUUID() })
    .send(body as object);

const fieldMessages = (body: { error: { details: Array<{ field: string; message: string }> } }) =>
  Object.fromEntries(body.error.details.map((item) => [item.field, item.message]));

describe("Nhà cung cấp", () => {
  it("chặn trùng mã số thuế và nói rõ nhà cung cấp đang dùng", async () => {
    const response = await post("/suppliers", { name: "Công ty B", taxCode: "0100108536" }).expect(
      409,
    );
    expect(response.body.error.code).toBe("DUPLICATE_TAX_CODE");
    expect(response.body.error.message).toContain("Công ty Dược A");
  });

  it("chặn trùng tên, không phân biệt hoa thường", async () => {
    const response = await post("/suppliers", { name: "công ty dược a" }).expect(409);
    expect(response.body.error.code).toBe("DUPLICATE_NAME");
  });

  it("sửa chính nó với tên và mã số thuế cũ thì không bị coi là trùng", async () => {
    await api()
      .patch(`/api/v1/suppliers/${supplierId}`)
      .set(authHeaders(token, fixture.storeId))
      .send({ name: "Công ty Dược A", taxCode: "0100108536", version: 1 })
      .expect(200);
  });

  it("kiểm tra định dạng mã số thuế và số điện thoại, chuẩn hóa số điện thoại", async () => {
    const bad = await post("/suppliers", { name: "Công ty C", taxCode: "12", phone: "abc" }).expect(
      422,
    );
    expect(Object.keys(fieldMessages(bad.body)).sort()).toEqual(["phone", "taxCode"]);

    const ok = await post("/suppliers", { name: "Công ty C", phone: "+84 901 234 567" }).expect(
      201,
    );
    expect(ok.body.data.phone).toBe("0901234567");
  });
});

describe("Khách hàng, cửa hàng, nhân viên", () => {
  it("số điện thoại viết khác kiểu vẫn bị nhận ra là trùng", async () => {
    await post("/customers", { fullName: "Chị Lan", phone: "0901234567" }).expect(201);
    const response = await post("/customers", {
      fullName: "Người khác",
      phone: "+84 90 123 4567",
    }).expect(409);
    expect(response.body.error.code).toBe("DUPLICATE_PHONE");
  });

  it("từ chối số điện thoại sai ở khách hàng, cửa hàng và nhân viên", async () => {
    await post("/customers", { fullName: "A", phone: "123" }).expect(422);
    await post("/stores", { code: "NT09", name: "Cửa hàng 9", phone: "abc" }).expect(422);
    await post("/users", { username: "nhanvien9", fullName: "B", phone: "abc" }).expect(422);
  });
});

describe("Danh mục sản phẩm", () => {
  const product = (overrides: Record<string, unknown>) => ({
    code: "TH0002",
    name: "Thử",
    productType: "SUPPLEMENT",
    categoryId,
    baseUnitName: "Hộp",
    ...overrides,
  });

  it("mã sản phẩm lưu chữ hoa nên mã chữ thường cũng bị chặn trùng", async () => {
    const response = await post("/products", product({ code: "th0001" })).expect(409);
    expect(response.body.error.message).toContain("TH0001");
    const created = await post("/products", product({ code: "tp0002" })).expect(201);
    expect(created.body.data.code).toBe("TP0002");
  });

  it("số quá lớn trả lỗi kiểm tra thay vì lỗi 500 của CSDL", async () => {
    await post("/products", product({ minStockBaseQuantity: 1e12 })).expect(422);
    await post(`/products/${productId}/units`, { name: "Thùng", conversionToBase: 1e12 }).expect(
      422,
    );
  });

  it("đơn vị trùng tên và mã vạch đã gắn cho đơn vị khác báo rõ chỗ trùng", async () => {
    const unit = await post(`/products/${productId}/units`, {
      name: "viên",
      conversionToBase: 5,
    }).expect(409);
    expect(unit.body.error.code).toBe("DUPLICATE_UNIT");

    const barcode = await post(`/products/${productId}/units`, {
      name: "Vỉ",
      conversionToBase: 10,
      barcodes: ["8934567000011"],
    }).expect(409);
    expect(barcode.body.error.code).toBe("DUPLICATE_BARCODE");
    expect(barcode.body.error.message).toContain("TH0001");

    await post(`/products/${productId}/units`, {
      name: "Hộp",
      conversionToBase: 100,
      barcodes: ["89-ab!"],
    }).expect(422);
  });

  it("giá chỉ nhận thuế suất 0, 5, 8, 10 % và không lùi ngày hiệu lực", async () => {
    await post(`/products/${productId}/prices`, {
      unitId,
      salePrice: 1000,
      vatRatePercent: 7,
    }).expect(422);
    await post(`/products/${productId}/prices`, {
      unitId,
      salePrice: 1000,
      vatRatePercent: 5,
      effectiveFrom: "2020-01-01",
    }).expect(422);
    await post(`/products/${productId}/prices`, {
      unitId,
      salePrice: 1000,
      vatRatePercent: 8,
    }).expect(201);
  });

  it("nhóm gốc và hoạt chất trùng tên không phân biệt hoa thường", async () => {
    await post("/categories", { name: "THUỐC GIẢM ĐAU" }).expect(409);
    await post("/active-ingredients", { name: "Ibuprofen" }).expect(201);
    await post("/active-ingredients", { name: "ibuprofen" }).expect(409);
  });
});

describe("Phiếu nhập", () => {
  const line = (overrides: Record<string, unknown> = {}) => ({
    productId,
    unitId,
    quantity: 10,
    unitCost: 1000,
    batchNumber: "PA01",
    expiryDate: "2028-01-01",
    ...overrides,
  });

  it("chặn ngày ở tương lai và năm gõ nhầm", async () => {
    const response = await post("/goods-receipts", {
      supplierId,
      supplierInvoiceDate: "2099-01-01",
      receivedAt: "2099-01-01",
      lines: [
        line({ manufactureDate: "1800-01-01" }),
        line({ batchNumber: "PA02", expiryDate: "2200-01-01" }),
      ],
    }).expect(422);
    expect(Object.keys(fieldMessages(response.body)).sort()).toEqual([
      "lines.0.manufactureDate",
      "lines.1.expiryDate",
      "receivedAt",
      "supplierInvoiceDate",
    ]);
  });

  it("một lô chỉ được nằm trên một dòng", async () => {
    const response = await post("/goods-receipts", {
      supplierId,
      lines: [line(), line({ batchNumber: "pa01" })],
    }).expect(422);
    expect(fieldMessages(response.body)["lines.1.batchNumber"]).toContain("dòng 1");
  });

  it("số lượng quá lớn bị chặn trước khi nhân hệ số quy đổi", async () => {
    await post("/goods-receipts", { supplierId, lines: [line({ quantity: 1e12 })] }).expect(422);
  });
});
