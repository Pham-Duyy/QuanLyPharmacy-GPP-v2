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
let token: string;
let rx: { productId: string; pillId: string };
let otc: { productId: string; pillId: string };

const h = () => ({ ...authHeaders(token, fixture.storeId), "Idempotency-Key": randomUUID() });

async function product(
  code: string,
  name: string,
  drugClass: string,
  extra: Record<string, unknown> = {},
) {
  const category =
    (await prisma.category.findFirst({ where: { name: "Thuốc" } })) ??
    (await prisma.category.create({ data: { name: "Thuốc" } }));
  const created = await prisma.product.create({
    data: {
      code,
      name,
      productType: "DRUG",
      drugClass,
      categoryId: category.id,
      ...extra,
      units: { create: [{ name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true }] },
    },
    include: { units: true },
  });
  const pill = created.units[0]!;
  await prisma.productPrice.create({
    data: {
      productUnitId: pill.id,
      salePrice: 1000n,
      vatRatePercent: 5,
      effectiveFrom: new Date(Date.now() - 86_400_000),
    },
  });
  await prisma.batch.create({
    data: {
      storeId: fixture.storeId,
      productId: created.id,
      batchNumber: `${code}-L1`,
      expiryDate: new Date("2029-06-30"),
      quantityOnHand: 100,
    },
  });
  return { productId: created.id, pillId: pill.id };
}

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  token = (await login("duocsi")).token;
  rx = await product("TH0201", "Amoxicillin 500mg", "RX", {
    dosageForm: "Viên nang",
    strengthText: "500 mg",
  });
  otc = await product("TH0202", "Paracetamol 500mg", "OTC", {
    dosageForm: "Viên nén",
    strengthText: "500 mg",
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Cách dùng và nhãn cách dùng (GPP II.3d)", () => {
  it("lưu cách dùng quầy ghi; bán theo đơn mà để trống thì lấy liều dùng trên đơn", async () => {
    const draft = await api()
      .post("/api/v1/prescriptions")
      .set(authHeaders(token, fixture.storeId))
      .send({
        prescriberName: "BS. Lê Văn D",
        prescribedDate: new Date().toISOString().slice(0, 10),
        items: [
          {
            productId: rx.productId,
            unitId: rx.pillId,
            drugNameText: "Amoxicillin 500mg",
            quantity: 14,
            dosageInstruction: "Uống 1 viên x 2 lần/ngày, sau ăn, 7 ngày",
          },
        ],
      })
      .expect(201);
    await api()
      .post(`/api/v1/prescriptions/${draft.body.data.id}/verify`)
      .set(h())
      .send({})
      .expect(200);

    const sold = await api()
      .post("/api/v1/invoices")
      .set(h())
      .send({
        prescriptionId: draft.body.data.id,
        lines: [
          {
            productId: rx.productId,
            unitId: rx.pillId,
            quantity: 14,
            prescriptionItemId: draft.body.data.items[0].id,
          },
          {
            productId: otc.productId,
            unitId: otc.pillId,
            quantity: 10,
            usageInstruction: "Uống 1 viên khi sốt trên 38,5°C, cách nhau ít nhất 4 giờ",
          },
          { productId: otc.productId, unitId: otc.pillId, quantity: 20 },
        ],
      })
      .expect(201);

    const lines = sold.body.data.lines as Array<{
      productName: string;
      quantity: number;
      usageInstruction: string | null;
    }>;
    expect(lines.map((line) => line.usageInstruction)).toEqual([
      "Uống 1 viên x 2 lần/ngày, sau ăn, 7 ngày",
      "Uống 1 viên khi sốt trên 38,5°C, cách nhau ít nhất 4 giờ",
      null,
    ]);

    const html = (
      await api()
        .get(`/api/v1/invoices/${sold.body.data.id}/usage-labels?autoprint=0`)
        .set(authHeaders(token, fixture.storeId))
        .expect(200)
    ).text;
    expect(html.match(/class="label"/g)).toHaveLength(2);
    expect(html).toContain("Amoxicillin 500mg");
    expect(html).toContain("Viên nang · 500 mg");
    expect(html).toContain("Uống 1 viên x 2 lần/ngày, sau ăn, 7 ngày");
    expect(html).toContain("HSD: 30/06/2029");
    // Dòng không ghi cách dùng không in nhãn.
    expect(html.match(/Số lượng: 20/g)).toBeNull();
  });

  it("thoát ký tự HTML trong cách dùng, giới hạn 300 ký tự", async () => {
    await api()
      .post("/api/v1/invoices")
      .set(h())
      .send({
        lines: [
          {
            productId: otc.productId,
            unitId: otc.pillId,
            quantity: 1,
            usageInstruction: "x".repeat(301),
          },
        ],
      })
      .expect(422);
    const sold = await api()
      .post("/api/v1/invoices")
      .set(h())
      .send({
        lines: [
          {
            productId: otc.productId,
            unitId: otc.pillId,
            quantity: 1,
            usageInstruction: "<b>Uống</b> 1 viên",
          },
        ],
      })
      .expect(201);
    const html = (
      await api()
        .get(`/api/v1/invoices/${sold.body.data.id}/usage-labels?autoprint=0`)
        .set(authHeaders(token, fixture.storeId))
        .expect(200)
    ).text;
    expect(html).toContain("&lt;b&gt;Uống&lt;/b&gt; 1 viên");
  });

  it("hóa đơn của cửa hàng khác thì không in được", async () => {
    const sold = await api()
      .post("/api/v1/invoices")
      .set(h())
      .send({
        lines: [
          {
            productId: otc.productId,
            unitId: otc.pillId,
            quantity: 1,
            usageInstruction: "Uống 1 viên",
          },
        ],
      })
      .expect(201);
    const admin = (await login("admin")).token;
    await api()
      .get(`/api/v1/invoices/${sold.body.data.id}/usage-labels`)
      .set(authHeaders(admin, fixture.otherStoreId))
      .expect(404);
  });
});
