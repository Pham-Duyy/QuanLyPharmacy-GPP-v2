import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../../test/helpers.js";

/**
 * Các test ở đây cố tình chạy hai nghiệp vụ **cùng lúc** trên cùng một chứng
 * từ. Trước khi có khóa hàng trong transaction, mỗi test dưới đây đều thất
 * bại: hai luồng cùng đọc được trạng thái cũ rồi cùng ghi.
 */

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let categoryId: string;
let customerId: string;

const h = (token = adminToken) => authHeaders(token, fixture.storeId);
const idem = () => ({ "Idempotency-Key": randomUUID() });

function dayOffset(days: number): Date {
  const vnToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  const date = new Date(`${vnToday}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

type Made = { id: string; unitId: string };

async function makeProduct(options: {
  code: string;
  name: string;
  price: number;
  productType?: string;
  drugClass?: string | null;
  quantity?: number;
  unitCost?: number;
}): Promise<Made> {
  const product = await prisma.product.create({
    data: {
      code: options.code,
      name: options.name,
      productType: options.productType ?? "DRUG",
      drugClass: options.drugClass === undefined ? "OTC" : options.drugClass,
      categoryId,
      units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  const unitId = product.units[0]!.id;
  await prisma.productPrice.create({
    data: { productUnitId: unitId, salePrice: BigInt(options.price), vatRatePercent: 5, effectiveFrom: dayOffset(-1) },
  });
  await prisma.batch.create({
    data: {
      storeId: fixture.storeId,
      productId: product.id,
      batchNumber: `LO-${options.code}`,
      expiryDate: dayOffset(400),
      quantityOnHand: options.quantity ?? 500,
      unitCost: options.unitCost ?? 600,
    },
  });
  return { id: product.id, unitId };
}

const sell = (body: Record<string, unknown>, token = adminToken) =>
  api()
    .post("/api/v1/invoices")
    .set({ ...h(token), ...idem() })
    .send(body);

const line = (product: Made, quantity: number) => ({ productId: product.id, unitId: product.unitId, quantity });

const stockOf = async (product: Made) =>
  (await prisma.batch.findFirstOrThrow({ where: { productId: product.id } })).quantityOnHand;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [adminToken, pharmacistToken] = await Promise.all([
    login("admin").then((item) => item.token),
    login("duocsi").then((item) => item.token),
  ]);
  categoryId = (await prisma.category.create({ data: { name: "Hàng nhà thuốc" } })).id;
  customerId = (await prisma.customer.create({ data: { fullName: "Chị Lan", phone: "0900000009" } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe("Hủy hóa đơn và trả hàng chạy đồng thời", () => {
  it("chỉ một nghiệp vụ hoàn tất, tồn kho không được hoàn hai lần", async () => {
    const para = await makeProduct({ code: "TH0001", name: "Paracetamol 500mg", price: 2000, quantity: 100 });
    const sale = await sell({ lines: [line(para, 10)] }).expect(201);
    expect(await stockOf(para)).toBe(90);

    const invoiceId = sale.body.data.id as string;
    const invoiceLine = sale.body.data.lines[0];

    const [voided, returned] = await Promise.allSettled([
      api()
        .post(`/api/v1/invoices/${invoiceId}/void`)
        .set({ ...h(pharmacistToken), ...idem() })
        .send({ reason: "Khách đổi ý ngay tại quầy" }),
      api()
        .post(`/api/v1/invoices/${invoiceId}/returns`)
        .set({ ...h(pharmacistToken), ...idem() })
        .send({
          disposition: "RESTOCK",
          refundMethod: "CASH",
          lines: [{ invoiceLineId: invoiceLine.id, unitId: para.unitId, quantity: 10 }],
        }),
    ]);

    const statuses = [voided, returned].map((item) =>
      item.status === "fulfilled" ? item.value.status : 0,
    );
    const ok = statuses.filter((status) => status >= 200 && status < 300);
    expect(ok).toHaveLength(1);

    // Dù nghiệp vụ nào thắng, hàng cũng chỉ quay về kho đúng một lần.
    expect(await stockOf(para)).toBe(100);

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const returns = await prisma.return.count({ where: { invoiceId } });
    if (invoice.status === "VOIDED") {
      expect(returns).toBe(0);
    } else {
      expect(returns).toBe(1);
      expect(invoice.returnStatus).toBe("FULL");
    }

    // Thẻ kho chỉ có đúng một bút toán hoàn hàng.
    const back = await prisma.stockMovement.count({
      where: { productId: para.id, type: { in: ["SALE_VOID", "CUSTOMER_RETURN"] } },
    });
    expect(back).toBe(1);
  });

  it("hóa đơn đã trả hàng thì không hủy được, và ngược lại", async () => {
    const para = await makeProduct({ code: "TH0002", name: "Vitamin C", price: 1000, productType: "SUPPLEMENT", drugClass: null });
    const sale = await sell({ lines: [line(para, 4)] }).expect(201);
    const invoiceId = sale.body.data.id as string;

    await api()
      .post(`/api/v1/invoices/${invoiceId}/returns`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({
        disposition: "RESTOCK",
        refundMethod: "CASH",
        lines: [{ invoiceLineId: sale.body.data.lines[0].id, unitId: para.unitId, quantity: 1 }],
      })
      .expect(201);

    const late = await api()
      .post(`/api/v1/invoices/${invoiceId}/void`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({ reason: "Thử hủy sau khi đã nhận trả" })
      .expect(409);
    expect(late.body.error.message).toContain("phiếu trả");

    const sale2 = await sell({ lines: [line(para, 2)] }).expect(201);
    await api()
      .post(`/api/v1/invoices/${sale2.body.data.id}/void`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({ reason: "Khách bỏ đơn" })
      .expect(200);
    await api()
      .post(`/api/v1/invoices/${sale2.body.data.id}/returns`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({
        disposition: "RESTOCK",
        refundMethod: "CASH",
        lines: [{ invoiceLineId: sale2.body.data.lines[0].id, unitId: para.unitId, quantity: 1 }],
      })
      .expect(409);
  });
});

describe("Mã chứng từ khi tạo đồng thời", () => {
  it("năm hóa đơn tạo cùng lúc nhận năm mã khác nhau, không lỗi", async () => {
    const para = await makeProduct({ code: "TH0003", name: "Efferalgan", price: 3000, quantity: 500 });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => sell({ lines: [line(para, 1)] })),
    );
    expect(results.map((item) => item.status)).toEqual([201, 201, 201, 201, 201]);

    const codes = results.map((item) => item.body.data.code as string);
    expect(new Set(codes).size).toBe(5);
    // Số thứ tự liên tục, không nhảy số.
    expect([...codes].sort()).toEqual(
      codes
        .map((code) => code.slice(0, -4))
        .slice(0, 1)
        .flatMap((prefix) => [1, 2, 3, 4, 5].map((index) => `${prefix}${String(index).padStart(4, "0")}`)),
    );
  });

  it("phiếu nhập tạo đồng thời cũng không trùng mã", async () => {
    const para = await makeProduct({ code: "TH0004", name: "Amoxicillin", price: 4000 });
    const supplier = await prisma.supplier.create({ data: { name: "Dược Minh Tâm" } });

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        api()
          .post("/api/v1/goods-receipts")
          .set({ ...h(pharmacistToken), ...idem() })
          .send({
            supplierId: supplier.id,
            lines: [
              {
                productId: para.id,
                unitId: para.unitId,
                quantity: 10,
                unitCost: 1000,
                batchNumber: "NHAP1",
                expiryDate: dayOffset(300).toISOString().slice(0, 10),
              },
            ],
          }),
      ),
    );
    expect(results.every((item) => item.status === 201)).toBe(true);
    expect(new Set(results.map((item) => item.body.data.code)).size).toBe(4);
  });
});

describe("Đổi điểm khi hai hóa đơn chạy đồng thời", () => {
  it("không đổi vượt số điểm còn lại của khách", async () => {
    const vitamin = await makeProduct({
      code: "TP0001",
      name: "Vitamin tổng hợp",
      price: 10_000,
      productType: "SUPPLEMENT",
      drugClass: null,
      quantity: 1000,
    });
    await api()
      .put("/api/v1/loyalty/settings")
      .set(h())
      .send({
        enabled: true,
        earnAmountPerPoint: 10_000,
        pointValue: 500,
        minRedeemPoints: 10,
        maxRedeemPercent: 50,
        expiryMonths: 12,
        earnOnDrugs: false,
      })
      .expect(200);

    // Tích 30 điểm.
    await sell({ customerId, lines: [line(vitamin, 30)] }).expect(201);
    const balanceOf = async () =>
      (await api().get(`/api/v1/customers/${customerId}/loyalty`).set(h()).expect(200)).body.data.balance;
    expect((await balanceOf()).available).toBe(30);

    // Hai hóa đơn cùng đòi đổi 30 điểm: chỉ một hóa đơn được đổi.
    const results = await Promise.allSettled([
      sell({ customerId, lines: [line(vitamin, 10)], loyaltyRedeemPoints: 30 }),
      sell({ customerId, lines: [line(vitamin, 10)], loyaltyRedeemPoints: 30 }),
    ]);
    const redeemed = results.filter(
      (item) => item.status === "fulfilled" && item.value.status === 201 && item.value.body.data.loyaltyPointsRedeemed === 30,
    );
    expect(redeemed).toHaveLength(1);

    const after = await balanceOf();
    // 30 điểm cũ − 30 đã đổi + điểm tích của hai hóa đơn mới (85.000đ → 8 và 100.000đ → 10).
    expect(after.available).toBeGreaterThanOrEqual(0);
    expect(after.deficit).toBe(0);
    const ledger = await prisma.loyaltyTransaction.aggregate({ _sum: { points: true } });
    expect(Number(ledger._sum.points)).toBe(after.available);
  });
});

describe("Dòng đơn thuốc được lưu theo kết quả khớp của máy chủ", () => {
  async function verifiedPrescription(product: Made, quantity: number): Promise<string> {
    const created = await api()
      .post("/api/v1/prescriptions")
      .set(h(pharmacistToken))
      .send({
        customerId,
        prescriberName: "BS. Trần Văn A",
        facilityName: "Bệnh viện Q.1",
        prescribedDate: dayOffset(0).toISOString().slice(0, 10),
        items: [{ productId: product.id, drugNameText: "Amoxicillin 500mg", unitId: product.unitId, quantity }],
      })
      .expect(201);
    await api()
      .post(`/api/v1/prescriptions/${created.body.data.id}/verify`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({})
      .expect(200);
    return created.body.data.id as string;
  }

  it("bán không gửi prescriptionItemId vẫn lưu đúng dòng đơn, hủy thì trả lại số đã cấp", async () => {
    const amox = await makeProduct({ code: "TH0010", name: "Amoxicillin 500mg", price: 5000, drugClass: "RX" });
    const prescriptionId = await verifiedPrescription(amox, 20);

    const sale = await sell({ customerId, prescriptionId, lines: [line(amox, 8)] }, pharmacistToken).expect(201);

    const savedLine = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: sale.body.data.id } });
    expect(savedLine.prescriptionItemId).not.toBeNull();

    const item = await prisma.prescriptionItem.findFirstOrThrow({ where: { prescriptionId } });
    expect(item.dispensedBaseQuantity).toBe(8);

    await api()
      .post(`/api/v1/invoices/${sale.body.data.id}/void`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({ reason: "Khách không lấy thuốc nữa" })
      .expect(200);

    const afterVoid = await prisma.prescriptionItem.findFirstOrThrow({ where: { prescriptionId } });
    expect(afterVoid.dispensedBaseQuantity).toBe(0);
    // Đơn thuốc quay về trạng thái chưa cấp phát để còn bán lại được.
    const prescription = await prisma.prescription.findUniqueOrThrow({ where: { id: prescriptionId } });
    expect(prescription.status).toBe("VERIFIED");
  });

  it("hai lần bán đồng thời trên cùng đơn thuốc không cấp vượt số đã kê", async () => {
    const amox = await makeProduct({ code: "TH0011", name: "Augmentin 625mg", price: 9000, drugClass: "RX" });
    const prescriptionId = await verifiedPrescription(amox, 10);

    const results = await Promise.allSettled([
      sell({ customerId, prescriptionId, lines: [line(amox, 7)] }, pharmacistToken),
      sell({ customerId, prescriptionId, lines: [line(amox, 7)] }, pharmacistToken),
    ]);
    const ok = results.filter((item) => item.status === "fulfilled" && item.value.status === 201);
    expect(ok).toHaveLength(1);

    const item = await prisma.prescriptionItem.findFirstOrThrow({ where: { prescriptionId } });
    expect(item.dispensedBaseQuantity).toBe(7);
  });
});

describe("Tiền hoàn khi trả lẻ nhiều lần", () => {
  it("10.000đ cho 6 đơn vị, trả từng đơn vị thì tổng hoàn đúng 10.000đ", async () => {
    // Giá 1.667đ × 6 = 10.002đ, giảm 2đ để thành tiền dòng đúng 10.000đ.
    const kit = await makeProduct({
      code: "TP0002",
      name: "Gạc y tế",
      price: 1667,
      productType: "MEDICAL_DEVICE",
      drugClass: null,
      quantity: 50,
    });
    const sale = await sell({ lines: [line(kit, 6)], discount: { type: "AMOUNT", value: 2, reason: "Làm tròn" } }).expect(201);
    const invoiceLine = sale.body.data.lines[0];
    expect(Number(invoiceLine.lineTotal)).toBe(10_000);

    let refunded = 0;
    for (let index = 0; index < 6; index++) {
      const result = await api()
        .post(`/api/v1/invoices/${sale.body.data.id}/returns`)
        .set({ ...h(pharmacistToken), ...idem() })
        .send({
          disposition: "RESTOCK",
          refundMethod: "CASH",
          lines: [{ invoiceLineId: invoiceLine.id, unitId: kit.unitId, quantity: 1 }],
        })
        .expect(201);
      refunded += Number(result.body.data.refundAmount);
    }

    // Trả hết thì hoàn đúng số tiền của dòng, không hơn một đồng nào.
    expect(refunded).toBe(10_000);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: sale.body.data.id } });
    expect(invoice.returnStatus).toBe("FULL");
  });
});
