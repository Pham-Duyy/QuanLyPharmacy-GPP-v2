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
let salesToken: string;
let categoryId: string;
let productId: string;

// PNG 1x1 hợp lệ.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
// JPEG tối thiểu (chỉ cần đúng chữ ký đầu tệp để qua kiểm tra nội dung).
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);

const h = (token = adminToken) => authHeaders(token, fixture.storeId);

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
  salesToken = (await login("banhang")).token;
  categoryId = (await prisma.category.create({ data: { name: "Vitamin" } })).id;
  productId = (await makeProduct("TP0001", "Vitamin C 500mg", "SUPPLEMENT", null)).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function makeProduct(
  code: string,
  name: string,
  productType: string,
  drugClass: string | null,
  minStockBaseQuantity = 0,
) {
  return prisma.product.create({
    data: {
      code,
      name,
      productType,
      drugClass,
      categoryId,
      minStockBaseQuantity,
      units: {
        create: [
          { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: false },
          { name: "Lọ", conversionToBase: 100, isDefaultSaleUnit: true },
        ],
      },
    },
  });
}

function upload(file: Buffer, name = "anh.png", thumb?: Buffer, token = adminToken) {
  const request = api()
    .post(`/api/v1/products/${productId}/images`)
    .set(h(token))
    .attach("file", file, name);
  return thumb ? request.attach("thumb", thumb, "thumb.png") : request;
}

async function detail() {
  return (await api().get(`/api/v1/products/${productId}`).set(h()).expect(200)).body.data;
}

describe("Ảnh sản phẩm", () => {
  it("sản phẩm chưa có ảnh thì danh sách và chi tiết trả rỗng", async () => {
    const list = await api().get("/api/v1/products").set(h()).expect(200);
    expect(list.body.data.items[0].primaryImage).toBeNull();
    expect((await detail()).images).toEqual([]);
  });

  it("ảnh đầu tiên là ảnh chính, xem được qua URL có chữ ký, thumb riêng", async () => {
    const created = await upload(PNG, "anh.png", JPEG).expect(201);
    expect(created.body.data.isPrimary).toBe(true);

    const list = await api().get("/api/v1/products").set(h()).expect(200);
    const primary = list.body.data.items[0].primaryImage;
    expect(primary.id).toBe(created.body.data.id);

    const full = await api().get(primary.url).expect(200);
    expect(full.headers["content-type"]).toBe("image/png");
    expect(full.headers["cache-control"]).toContain("private");
    expect(Buffer.from(full.body).equals(PNG)).toBe(true);

    const thumb = await api().get(primary.thumbUrl).expect(200);
    expect(thumb.headers["content-type"]).toBe("image/jpeg");
  });

  it("URL ảnh bị sửa chữ ký hoặc đổi biến thể thì bị từ chối", async () => {
    const created = await upload(PNG).expect(201);
    const { url, thumbUrl } = created.body.data;

    await api()
      .get(url.replace(/sig=[0-9a-f]{4}/, "sig=0000"))
      .expect(403);
    // Chữ ký của ảnh thu nhỏ không mở được ảnh gốc.
    await api().get(thumbUrl.replace("v=thumb", "v=full")).expect(403);
    await api().get(`/api/v1/product-images/${created.body.data.id}`).expect(403);
  });

  it("URL ổn định trong cùng khung giờ để trình duyệt dùng lại ảnh đã tải", async () => {
    await upload(PNG).expect(201);
    const first = (await detail()).images[0].thumbUrl;
    const second = (await detail()).images[0].thumbUrl;
    expect(second).toBe(first);
  });

  it("từ chối SVG, PDF và tệp giả dạng ảnh", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const svgResponse = await upload(svg, "logo.svg").expect(422);
    expect(svgResponse.body.error.details[0].field).toBe("file");

    await upload(Buffer.from("%PDF-1.4 tài liệu"), "tai-lieu.pdf").expect(422);
    await upload(Buffer.from("<html>không phải ảnh</html>"), "gia.png").expect(422);
    const badThumb = await upload(PNG, "anh.png", Buffer.from("xx")).expect(422);
    expect(badThumb.body.error.details[0].field).toBe("thumb");

    expect(await prisma.productImage.count()).toBe(0);
  });

  it("thiếu tệp thì báo lỗi rõ", async () => {
    await api().post(`/api/v1/products/${productId}/images`).set(h()).expect(400);
  });

  it("nhân viên bán hàng không có quyền quản lý ảnh", async () => {
    await upload(PNG, "anh.png", undefined, salesToken).expect(403);
    const created = await upload(PNG).expect(201);
    await api()
      .post(`/api/v1/products/${productId}/images/${created.body.data.id}/primary`)
      .set(h(salesToken))
      .expect(403);
    await api()
      .delete(`/api/v1/products/${productId}/images/${created.body.data.id}`)
      .set(h(salesToken))
      .expect(403);
  });

  it("đổi ảnh chính, gỡ ảnh chính thì ảnh kế tiếp được đưa lên", async () => {
    const first = (await upload(PNG).expect(201)).body.data;
    const second = (await upload(JPEG, "anh.jpg").expect(201)).body.data;
    expect(second.isPrimary).toBe(false);

    const switched = await api()
      .post(`/api/v1/products/${productId}/images/${second.id}/primary`)
      .set(h())
      .expect(200);
    expect(switched.body.data[0]).toMatchObject({ id: second.id, isPrimary: true });
    expect(
      switched.body.data.filter((image: { isPrimary: boolean }) => image.isPrimary),
    ).toHaveLength(1);

    const removed = await api()
      .delete(`/api/v1/products/${productId}/images/${second.id}`)
      .set(h())
      .expect(200);
    expect(removed.body.data).toEqual([expect.objectContaining({ id: first.id, isPrimary: true })]);
    await api().get(second.url).expect(404);

    const audit = await prisma.auditLog.findMany({ where: { resourceId: productId } });
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "PRODUCT_IMAGE_UPLOAD",
        "PRODUCT_IMAGE_SET_PRIMARY",
        "PRODUCT_IMAGE_DELETE",
      ]),
    );
  });

  it("không thao tác được ảnh của sản phẩm khác qua id sản phẩm sai", async () => {
    const created = (await upload(PNG).expect(201)).body.data;
    const other = await makeProduct("TP0002", "Kẽm", "SUPPLEMENT", null);
    await api().delete(`/api/v1/products/${other.id}/images/${created.id}`).set(h()).expect(404);
  });

  it("giới hạn 8 ảnh mỗi sản phẩm", async () => {
    for (let i = 0; i < 8; i++) await upload(PNG).expect(201);
    const response = await upload(PNG).expect(422);
    expect(response.body.error.message).toContain("tối đa 8 ảnh");
  });

  it("đổi ảnh không đụng tới tồn kho hay thông tin sản phẩm", async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    await upload(PNG).expect(201);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(after.version).toBe(before.version);
    expect(await prisma.batch.count()).toBe(0);
  });
});

describe("Danh sách sản phẩm cho màn hình mới", () => {
  it("lọc chung nhóm kê đơn gồm RX và CONTROLLED", async () => {
    await makeProduct("TH0001", "Amoxicillin", "DRUG", "RX");
    await makeProduct("TH0002", "Morphin", "DRUG", "CONTROLLED");
    await makeProduct("TH0003", "Paracetamol", "DRUG", "OTC");

    const response = await api()
      .get("/api/v1/products")
      .query({ productType: "DRUG", drugClass: "RX,CONTROLLED", sortBy: "name", order: "asc" })
      .set(h())
      .expect(200);
    expect(response.body.data.items.map((item: { code: string }) => item.code)).toEqual([
      "TH0001",
      "TH0002",
    ]);
  });

  it("trả đơn vị cơ bản, tồn 0 khi chưa có lô và cờ dưới mức tồn tối thiểu", async () => {
    const low = await makeProduct("TH0010", "Omeprazole", "DRUG", "RX", 50);
    await prisma.batch.create({
      data: {
        storeId: fixture.storeId,
        productId: low.id,
        batchNumber: "OM1",
        expiryDate: new Date("2030-01-01"),
        quantityOnHand: 20,
        status: "AVAILABLE",
      },
    });

    const response = await api()
      .get("/api/v1/products")
      .query({ sortBy: "code", order: "asc" })
      .set(h())
      .expect(200);
    const [lowItem, noBatch] = response.body.data.items;

    expect(lowItem).toMatchObject({
      code: "TH0010",
      baseUnit: { name: "Viên" },
      defaultUnit: { name: "Lọ" },
      isBelowMinStock: true,
      stock: { sellable: 20 },
    });
    expect(noBatch).toMatchObject({
      code: "TP0001",
      isBelowMinStock: false,
      stock: { sellable: 0 },
    });

    // Không chọn cửa hàng thì tồn là "không rõ", không phải 0.
    const chain = await api().get("/api/v1/products").set(authHeaders(adminToken)).expect(200);
    expect(chain.body.data.items[0].stock).toBeNull();
    expect(chain.body.data.items[0].isBelowMinStock).toBe(false);
  });

  it("tồn kho theo đúng cửa hàng đang chọn", async () => {
    await prisma.batch.create({
      data: {
        storeId: fixture.otherStoreId,
        productId,
        batchNumber: "VC1",
        expiryDate: new Date("2030-01-01"),
        quantityOnHand: 300,
        status: "AVAILABLE",
      },
    });
    const here = await api().get(`/api/v1/products/${productId}`).set(h()).expect(200);
    const there = await api()
      .get(`/api/v1/products/${productId}`)
      .set(authHeaders(adminToken, fixture.otherStoreId))
      .expect(200);
    expect(here.body.data.stock.sellable).toBe(0);
    expect(there.body.data.stock.sellable).toBe(300);
  });
});
