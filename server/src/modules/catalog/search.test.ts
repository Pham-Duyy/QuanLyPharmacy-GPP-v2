import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../../test/helpers.js";

/**
 * Tìm kiếm danh mục phải phân trang và đếm đúng.
 *
 * Trước đây tầng tìm kiếm chỉ trả về tối đa 500 id sản phẩm (200 với hoạt
 * chất) rồi mới lọc tiếp, nên nhà thuốc có nhiều mặt hàng sẽ thấy tổng số
 * kết quả đứng yên ở mức trần và không lật được sang các trang sau.
 */

let fixture: Fixture;
let token: string;
let categoryId: string;

const h = () => authHeaders(token, fixture.storeId);

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  token = (await login("admin")).token;
  categoryId = (await prisma.category.create({ data: { name: "Hàng nhà thuốc" } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Phân trang khi có nhiều kết quả khớp", () => {
  it("sản phẩm: tổng số đúng và trang sau mức trần cũ vẫn có dữ liệu", async () => {
    await prisma.product.createMany({
      data: Array.from({ length: 520 }, (_, index) => ({
        code: `TH${String(index + 1).padStart(5, "0")}`,
        name: `Thuốc ho Bổ phế số ${String(index + 1).padStart(3, "0")}`,
        productType: "DRUG",
        drugClass: "OTC",
        categoryId,
      })),
    });
    // Một mặt hàng không khớp, để chắc chắn bộ lọc vẫn hoạt động.
    await prisma.product.create({
      data: { code: "KHAC01", name: "Băng gạc y tế", productType: "MEDICAL_DEVICE", categoryId },
    });

    // Gõ không dấu vẫn khớp tên có dấu.
    const first = await api().get("/api/v1/products?search=thuoc ho&page=1&limit=20").set(h()).expect(200);
    expect(first.body.data.pagination.total).toBe(520);

    // Trang 26 nằm ngoài mức trần 500 của cách làm cũ.
    const late = await api().get("/api/v1/products?search=thuoc ho&page=26&limit=20").set(h()).expect(200);
    expect(late.body.data.items).toHaveLength(20);
    expect(late.body.data.pagination.total).toBe(520);

    // Không trang nào trả về trùng mặt hàng của trang trước.
    const firstCodes = new Set(first.body.data.items.map((item: { code: string }) => item.code));
    for (const item of late.body.data.items as Array<{ code: string }>) {
      expect(firstCodes.has(item.code)).toBe(false);
    }
  });

  it("hoạt chất: tổng số đúng khi vượt mức trần cũ", async () => {
    await prisma.activeIngredient.createMany({
      data: Array.from({ length: 230 }, (_, index) => ({
        name: `Paracetamol biến thể ${String(index + 1).padStart(3, "0")}`,
      })),
    });

    const result = await api()
      .get("/api/v1/active-ingredients?search=paracetamol&page=12&limit=20")
      .set(h())
      .expect(200);

    expect(result.body.data.pagination.total).toBe(230);
    expect(result.body.data.items).toHaveLength(10);
  });

  it("lọc kết hợp tìm kiếm vẫn đếm đúng", async () => {
    await prisma.product.createMany({
      data: [
        ...Array.from({ length: 5 }, (_, index) => ({
          code: `RX${index}`,
          name: `Amoxicillin ${index}`,
          productType: "DRUG",
          drugClass: "RX",
          categoryId,
        })),
        ...Array.from({ length: 3 }, (_, index) => ({
          code: `OT${index}`,
          name: `Amoxicillin OTC ${index}`,
          productType: "DRUG",
          drugClass: "OTC",
          categoryId,
        })),
      ],
    });

    const rx = await api().get("/api/v1/products?search=amoxicillin&drugClass=RX").set(h()).expect(200);
    expect(rx.body.data.pagination.total).toBe(5);

    const all = await api().get("/api/v1/products?search=amoxicillin").set(h()).expect(200);
    expect(all.body.data.pagination.total).toBe(8);
  });
});
