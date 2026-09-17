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
import { vndInWords } from "./print-common.js";

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let salesToken: string;
let product: { id: string; boxId: string; pillId: string };
let supplierId: string;

const idem = () => ({ "Idempotency-Key": randomUUID() });
const h = (token = adminToken, storeId = fixture.storeId) => authHeaders(token, storeId);

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [adminToken, pharmacistToken, salesToken] = await Promise.all([
    login("admin").then((result) => result.token),
    login("duocsi").then((result) => result.token),
    login("banhang").then((result) => result.token),
  ]);

  const category = await prisma.category.create({ data: { name: "Thuốc giảm đau" } });
  const created = await prisma.product.create({
    data: {
      code: "TH0001",
      name: "Paracetamol 500mg <Hapacol>",
      productType: "DRUG",
      drugClass: "OTC",
      categoryId: category.id,
      units: {
        create: [
          { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true },
          { name: "Hộp", conversionToBase: 100, isDefaultSaleUnit: false },
        ],
      },
    },
    include: { units: true },
  });
  product = {
    id: created.id,
    pillId: created.units.find((unit) => unit.name === "Viên")!.id,
    boxId: created.units.find((unit) => unit.name === "Hộp")!.id,
  };
  await prisma.productPrice.create({
    data: {
      productUnitId: product.pillId,
      salePrice: 1500n,
      vatRatePercent: 5,
      effectiveFrom: new Date(Date.now() - 86_400_000),
    },
  });
  supplierId = (
    await prisma.supplier.create({
      data: { name: "Công ty Dược ABC", taxCode: "0301234567", address: "25 Nguyễn Trãi" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createReceipt(): Promise<string> {
  const response = await api()
    .post("/api/v1/goods-receipts")
    .set({ ...h(), ...idem() })
    .send({
      supplierId,
      supplierInvoiceNumber: "0001234",
      discountAmount: 40_000,
      lines: [
        {
          productId: product.id,
          unitId: product.boxId,
          quantity: 12,
          unitCost: 105_000,
          batchNumber: "PA2501",
          expiryDate: "2028-01-09",
        },
      ],
    })
    .expect(201);
  return response.body.data.id;
}

describe("Đọc số tiền bằng chữ", () => {
  it.each([
    [0, "Không đồng"],
    [15, "Mười lăm đồng"],
    [21, "Hai mươi mốt đồng"],
    [105_000, "Một trăm lẻ năm nghìn đồng"],
    [1_005_000, "Một triệu không trăm lẻ năm nghìn đồng"],
    [1_240_000, "Một triệu hai trăm bốn mươi nghìn đồng"],
    [2_000_000_000, "Hai tỷ đồng"],
    [54_000, "Năm mươi tư nghìn đồng"],
  ])("%d → %s", (value, words) => {
    expect(vndInWords(value)).toBe(words);
  });
});

describe("In phiếu nhập kho", () => {
  it("in đủ nhà cung cấp, lô, hạn dùng, tổng tiền bằng chữ và đánh dấu bản nháp", async () => {
    const id = await createReceipt();

    const response = await api()
      .get(`/api/v1/goods-receipts/${id}/print`)
      .query({ autoprint: "0" })
      .set(h(pharmacistToken))
      .expect(200);

    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["x-paper-size"]).toBe("A4");
    const html = response.text;
    expect(html).toContain("PHIẾU NHẬP KHO");
    expect(html).toContain("size: A4");
    expect(html).toContain("Công ty Dược ABC");
    expect(html).toContain("MST NCC");
    expect(html).toContain("PA2501");
    expect(html).toContain("09/01/2028");
    // Tên thuốc có ký tự đặc biệt phải được thoát.
    expect(html).toContain("Paracetamol 500mg &lt;Hapacol&gt;");
    expect(html).toContain("1.220.000");
    expect(html).toContain("Một triệu hai trăm hai mươi nghìn đồng");
    expect(html).toContain("Bản nháp");
    expect(html).toContain("Dược sĩ kiểm nhập");
    expect(html).not.toContain("window.print()");
  });

  it("mặc định tự bật hộp thoại in và không làm đổi phiếu", async () => {
    const id = await createReceipt();
    const before = await prisma.goodsReceipt.findUniqueOrThrow({ where: { id } });

    const response = await api().get(`/api/v1/goods-receipts/${id}/print`).set(h()).expect(200);
    expect(response.text).toContain("window.print()");
    expect(await prisma.goodsReceipt.findUniqueOrThrow({ where: { id } })).toEqual(before);
  });

  it("nhân viên bán hàng không có quyền xem phiếu nhập thì không in được", async () => {
    const id = await createReceipt();
    await api().get(`/api/v1/goods-receipts/${id}/print`).set(h(salesToken)).expect(403);
  });

  it("không in được phiếu của cửa hàng khác", async () => {
    const id = await createReceipt();
    await api()
      .get(`/api/v1/goods-receipts/${id}/print`)
      .set(h(adminToken, fixture.otherStoreId))
      .expect(404);
  });
});

describe("In phiếu trả hàng và phiếu điều chỉnh", () => {
  async function stockBatch(quantity: number): Promise<string> {
    const batch = await prisma.batch.create({
      data: {
        storeId: fixture.storeId,
        productId: product.id,
        batchNumber: "L-TRA",
        expiryDate: new Date("2028-06-30"),
        quantityOnHand: quantity,
        status: "AVAILABLE",
      },
    });
    return batch.id;
  }

  it("in phiếu trả hàng khổ nhiệt với tiền hoàn, lô và khách lẻ", async () => {
    await stockBatch(100);
    const sold = await api()
      .post("/api/v1/invoices")
      .set({ ...h(), ...idem() })
      .send({ lines: [{ productId: product.id, unitId: product.pillId, quantity: 10 }] })
      .expect(201);
    const line = sold.body.data.lines[0];
    const created = await api()
      .post(`/api/v1/invoices/${sold.body.data.id}/returns`)
      .set({ ...h(), ...idem() })
      .send({
        reason: "Khách mua nhầm",
        disposition: "RESTOCK",
        lines: [
          {
            invoiceLineId: line.id,
            allocationId: line.allocations[0].id,
            unitId: product.pillId,
            quantity: 4,
          },
        ],
      })
      .expect(201);

    const response = await api()
      .get(`/api/v1/returns/${created.body.data.id}/print`)
      .query({ autoprint: "0" })
      .set(h(salesToken))
      .expect(200);

    expect(response.headers["x-paper-size"]).toBe("K80");
    expect(response.text).toContain("size: 80mm auto");
    expect(response.text).toContain("PHIẾU TRẢ HÀNG");
    expect(response.text).toContain(sold.body.data.code);
    expect(response.text).toContain("Khách lẻ");
    expect(response.text).toContain("Lô L-TRA");
    expect(response.text).toContain("4 Viên");
    expect(response.text).toContain("6.000");
    expect(response.text).toContain("Sáu nghìn đồng");
  });

  it("in phiếu điều chỉnh tồn với tồn sổ sách, chênh lệch theo đơn vị cơ sở", async () => {
    const batchId = await stockBatch(200);
    const created = await api()
      .post("/api/v1/stock-adjustments")
      .set(h(pharmacistToken))
      .send({
        reason: "Kiểm kê cuối tháng",
        lines: [
          { batchId, unitId: product.pillId, reasonCode: "COUNT_DIFFERENCE", countedQuantity: 196 },
        ],
      })
      .expect(201);
    const id = created.body.data.id;

    const draft = await api()
      .get(`/api/v1/stock-adjustments/${id}/print`)
      .query({ autoprint: "0" })
      .set(h())
      .expect(200);
    expect(draft.text).toContain("PHIẾU ĐIỀU CHỈNH TỒN KHO");
    expect(draft.text).toContain("Chờ duyệt");
    expect(draft.text).toContain("Thực tế 196 Viên");
    expect(draft.text).toContain("200 Viên");
    expect(draft.text).toContain("Paracetamol 500mg &lt;Hapacol&gt;");

    await api()
      .post(`/api/v1/stock-adjustments/${id}/approve`)
      .set({ ...h(), ...idem() })
      .expect(200);
    const approved = await api()
      .get(`/api/v1/stock-adjustments/${id}/print`)
      .query({ autoprint: "0" })
      .set(h())
      .expect(200);
    expect(approved.text).toContain("-4 Viên");
    expect(approved.text).not.toContain("Chờ duyệt");
    expect(approved.text).toContain("Quản trị");
  });
});

describe("Cài đặt in chứng từ", () => {
  const URL = "/api/v1/settings/document-print";

  async function current() {
    return (await api().get(URL).set(h()).expect(200)).body.data;
  }

  it("mặc định đủ ba loại phiếu, lưu xong đọc lại và áp dụng vào bản in", async () => {
    const initial = await current();
    expect(initial.isDefault).toBe(true);
    expect(initial.settings.goodsReceipt.paperSize).toBe("A4");

    const settings = {
      ...initial.settings,
      goodsReceipt: {
        ...initial.settings.goodsReceipt,
        paperSize: "A5",
        title: "PHIẾU KIỂM NHẬP",
        showSignatures: false,
        showAmountInWords: false,
        footer: "Lưu hồ sơ GPP",
      },
    };
    await api().put(URL).set(h()).send(settings).expect(200);
    const saved = await current();
    expect(saved.isDefault).toBe(false);
    expect(saved.settings).toEqual(settings);

    const id = await createReceipt();
    const response = await api()
      .get(`/api/v1/goods-receipts/${id}/print`)
      .query({ autoprint: "0" })
      .set(h())
      .expect(200);
    expect(response.headers["x-paper-size"]).toBe("A5");
    expect(response.text).toContain("PHIẾU KIỂM NHẬP");
    expect(response.text).toContain("Lưu hồ sơ GPP");
    expect(response.text).not.toContain("Số tiền bằng chữ");
    expect(response.text).not.toContain("Ký, ghi rõ họ tên");

    // Cửa hàng khác vẫn dùng mặc định.
    const other = await api().get(URL).set(h(adminToken, fixture.otherStoreId)).expect(200);
    expect(other.body.data.isDefault).toBe(true);
  });

  it("chặn khổ nhiệt cho phiếu nhập và tiêu đề rỗng", async () => {
    const { settings } = await current();
    const response = await api()
      .put(URL)
      .set(h())
      .send({
        ...settings,
        goodsReceipt: { ...settings.goodsReceipt, paperSize: "K80", title: " " },
      })
      .expect(422);
    const fields = response.body.error.details.map((item: { field: string }) => item.field);
    expect(fields).toEqual(
      expect.arrayContaining(["goodsReceipt.paperSize", "goodsReceipt.title"]),
    );
  });

  it("chỉ admin được xem và sửa cài đặt in chứng từ", async () => {
    const { settings } = await current();
    await api().get(URL).set(h(pharmacistToken)).expect(403);
    await api().put(URL).set(h(pharmacistToken)).send(settings).expect(403);
  });

  it("xem trước từng loại phiếu bằng dữ liệu mẫu, không tạo chứng từ", async () => {
    const { settings } = await current();
    for (const type of ["goodsReceipt", "return", "stockAdjustment"]) {
      const response = await api()
        .post(`${URL}/preview`)
        .set(h())
        .send({ type, settings })
        .expect(200);
      expect(response.text).toContain(settings[type].title);
      expect(response.text).not.toContain("window.print()");
    }
    expect(await prisma.goodsReceipt.count()).toBe(0);
    expect(await prisma.return.count()).toBe(0);
    expect(await prisma.stockAdjustment.count()).toBe(0);
  });
});
