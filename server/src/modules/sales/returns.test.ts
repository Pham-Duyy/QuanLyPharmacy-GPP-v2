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
let categoryId: string;
let para: { id: string; unitId: string };
let amox: { id: string; unitId: string };

function idem(): Record<string, string> {
  return { "Idempotency-Key": randomUUID() };
}

function dayOffset(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return new Date(date.toISOString().slice(0, 10));
}

async function makeProduct(code: string, name: string, drugClass: string, price: number) {
  const product = await prisma.product.create({
    data: {
      code,
      name,
      productType: "DRUG",
      drugClass,
      categoryId,
      units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  const unitId = product.units[0]!.id;
  await prisma.productPrice.create({
    data: {
      productUnitId: unitId,
      salePrice: BigInt(price),
      vatRatePercent: 5,
      effectiveFrom: dayOffset(-1),
    },
  });
  return { id: product.id, unitId };
}

async function makeBatch(productId: string, batchNumber: string, quantity: number, days = 365) {
  const batch = await prisma.batch.create({
    data: {
      storeId: fixture.storeId,
      productId,
      batchNumber,
      expiryDate: dayOffset(days),
      quantityOnHand: quantity,
    },
  });
  return batch.id;
}

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  token = (await login("duocsi")).token;
  categoryId = (await prisma.category.create({ data: { name: "Thuốc" } })).id;
  para = await makeProduct("TH0001", "Paracetamol 500mg", "OTC", 1000);
  amox = await makeProduct("TH0002", "Amoxicillin 500mg", "RX", 3000);
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Bán trước rồi mới có cái để trả. */
async function sell(product: { id: string; unitId: string }, quantity: number, extra = {}) {
  const response = await api()
    .post("/api/v1/invoices")
    .set({ ...authHeaders(token, fixture.storeId), ...idem() })
    .send({
      lines: [{ productId: product.id, unitId: product.unitId, quantity }],
      ...extra,
    })
    .expect(201);
  return response.body.data;
}

function receiveReturn(invoiceId: string, body: Record<string, unknown>) {
  return api()
    .post(`/api/v1/invoices/${invoiceId}/returns`)
    .set({ ...authHeaders(token, fixture.storeId), ...idem() })
    .send(body);
}

describe("Nhận hàng khách trả", () => {
  it("hoàn tồn về đúng lô đã xuất và hoàn tiền theo giá trên hóa đơn gốc", async () => {
    const batchId = await makeBatch(para.id, "L1", 100);
    const invoice = await sell(para, 10);
    const line = invoice.lines[0];

    // Đổi giá sau khi bán: tiền hoàn vẫn phải theo giá cũ.
    await prisma.productPrice.create({
      data: {
        productUnitId: para.unitId,
        salePrice: 5000n,
        vatRatePercent: 5,
        effectiveFrom: new Date(),
      },
    });

    const response = await receiveReturn(invoice.id, {
      reason: "Khách mua nhầm hàm lượng",
      disposition: "RESTOCK",
      lines: [
        {
          invoiceLineId: line.id,
          allocationId: line.allocations[0].id,
          unitId: para.unitId,
          quantity: 4,
        },
      ],
    }).expect(201);

    expect(response.body.data.refundAmount).toBe(4000);
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.quantityOnHand).toBe(94);
  });

  it("ghi thẻ kho CUSTOMER_RETURN vào đúng lô", async () => {
    await makeBatch(para.id, "L1", 100);
    const invoice = await sell(para, 10);
    const line = invoice.lines[0];

    const response = await receiveReturn(invoice.id, {
      disposition: "RESTOCK",
      lines: [{ invoiceLineId: line.id, unitId: para.unitId, quantity: 3 }],
    }).expect(201);

    const movements = await prisma.stockMovement.findMany({
      where: { sourceId: response.body.data.id },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: "CUSTOMER_RETURN",
      baseQuantity: 3,
      balanceAfter: 93,
      batchId: line.allocations[0].batchId,
    });
  });

  it("chọn hủy hàng thì tồn không tăng nhưng thẻ kho ghi cả hai chiều", async () => {
    const batchId = await makeBatch(para.id, "L1", 100);
    const invoice = await sell(para, 10);
    const line = invoice.lines[0];

    const response = await receiveReturn(invoice.id, {
      reason: "Hàng bị ẩm, không bán lại được",
      disposition: "DISPOSE",
      lines: [{ invoiceLineId: line.id, unitId: para.unitId, quantity: 5 }],
    }).expect(201);

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.quantityOnHand).toBe(90);

    const movements = await prisma.stockMovement.findMany({
      where: { sourceId: response.body.data.id },
      orderBy: { id: "asc" },
    });
    expect(movements.map((item) => item.type)).toEqual(["CUSTOMER_RETURN", "DISPOSAL"]);
    expect(movements[1]).toMatchObject({ baseQuantity: -5, balanceAfter: 90 });
  });

  it("chặn trả nhiều hơn số đã mua", async () => {
    await makeBatch(para.id, "L1", 100);
    const invoice = await sell(para, 10);
    const line = invoice.lines[0];

    const response = await receiveReturn(invoice.id, {
      disposition: "RESTOCK",
      lines: [{ invoiceLineId: line.id, unitId: para.unitId, quantity: 11 }],
    }).expect(422);

    expect(response.body.error.code).toBe("RETURN_QUANTITY_EXCEEDED");
  });

  it("cộng dồn nhiều lần trả, vượt số đã mua thì chặn", async () => {
    await makeBatch(para.id, "L1", 100);
    const invoice = await sell(para, 10);
    const line = invoice.lines[0];
    const body = (quantity: number) => ({
      disposition: "RESTOCK",
      lines: [{ invoiceLineId: line.id, unitId: para.unitId, quantity }],
    });

    await receiveReturn(invoice.id, body(6)).expect(201);
    const second = await receiveReturn(invoice.id, body(5)).expect(422);

    expect(second.body.error.code).toBe("RETURN_QUANTITY_EXCEEDED");
    await receiveReturn(invoice.id, body(4)).expect(201);
  });

  it("cập nhật returnStatus từ PARTIAL sang FULL", async () => {
    await makeBatch(para.id, "L1", 100);
    const invoice = await sell(para, 10);
    const line = invoice.lines[0];
    const body = (quantity: number) => ({
      disposition: "RESTOCK",
      lines: [{ invoiceLineId: line.id, unitId: para.unitId, quantity }],
    });

    await receiveReturn(invoice.id, body(4)).expect(201);
    let saved = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(saved.returnStatus).toBe("PARTIAL");

    await receiveReturn(invoice.id, body(6)).expect(201);
    saved = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(saved.returnStatus).toBe("FULL");
  });

  it("quá hạn nhận trả thì từ chối", async () => {
    await makeBatch(para.id, "L1", 100);
    const invoice = await sell(para, 10);
    const line = invoice.lines[0];

    // Lùi ngày bán ra ngoài hạn 7 ngày mặc định.
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { businessDate: dayOffset(-30) },
    });

    const response = await receiveReturn(invoice.id, {
      disposition: "RESTOCK",
      lines: [{ invoiceLineId: line.id, unitId: para.unitId, quantity: 1 }],
    }).expect(422);

    expect(response.body.error.code).toBe("RETURN_WINDOW_EXPIRED");
  });

  it("không nhận lại thuốc kê đơn để bán tiếp", async () => {
    await makeBatch(amox.id, "L1", 100);
    const prescription = await prisma.prescription.create({
      data: {
        storeId: fixture.storeId,
        code: "DT-001",
        prescribedDate: dayOffset(-1),
        validUntil: dayOffset(4),
        status: "VERIFIED",
        createdBy: fixture.pharmacistId,
        verifiedBy: fixture.pharmacistId,
        verifiedAt: new Date(),
        items: {
          create: {
            lineNo: 1,
            productId: amox.id,
            drugNameText: "Amoxicillin 500mg",
            productUnitId: amox.unitId,
            quantity: 20,
            baseQuantity: 20,
          },
        },
      },
      include: { items: true },
    });

    const invoice = await sell(amox, 10, {
      prescriptionId: prescription.id,
      lines: [
        {
          productId: amox.id,
          unitId: amox.unitId,
          quantity: 10,
          prescriptionItemId: prescription.items[0]!.id,
        },
      ],
    });
    const line = invoice.lines[0];

    const refused = await receiveReturn(invoice.id, {
      reason: "Khách đổi ý",
      disposition: "RESTOCK",
      lines: [{ invoiceLineId: line.id, unitId: amox.unitId, quantity: 2 }],
    }).expect(422);
    expect(refused.body.error.code).toBe("RETURN_NOT_ALLOWED_FOR_RX");

    // Có lỗi chất lượng thì nhận, nhưng phải hủy hàng và ghi rõ lý do.
    await receiveReturn(invoice.id, {
      reason: "Vỉ thuốc rách, nghi ngờ chất lượng",
      disposition: "DISPOSE",
      lines: [{ invoiceLineId: line.id, unitId: amox.unitId, quantity: 2 }],
    }).expect(201);

    const item = await prisma.prescriptionItem.findUniqueOrThrow({
      where: { id: prescription.items[0]!.id },
    });
    expect(item.dispensedBaseQuantity).toBe(8);
  });

  it("hóa đơn đã có phiếu trả thì không hủy được nữa", async () => {
    await makeBatch(para.id, "L1", 100);
    const invoice = await sell(para, 10);
    const line = invoice.lines[0];

    await receiveReturn(invoice.id, {
      disposition: "RESTOCK",
      lines: [{ invoiceLineId: line.id, unitId: para.unitId, quantity: 1 }],
    }).expect(201);

    const response = await api()
      .post(`/api/v1/invoices/${invoice.id}/void`)
      .set({ ...authHeaders(token, fixture.storeId), ...idem() })
      .send({ reason: "Thử hủy sau khi đã nhận trả" })
      .expect(409);

    expect(response.body.error.code).toBe("INVALID_STATE");
  });

  it("yêu cầu Idempotency-Key", async () => {
    await makeBatch(para.id, "L1", 100);
    const invoice = await sell(para, 10);

    const response = await api()
      .post(`/api/v1/invoices/${invoice.id}/returns`)
      .set(authHeaders(token, fixture.storeId))
      .send({
        disposition: "RESTOCK",
        lines: [{ invoiceLineId: invoice.lines[0].id, unitId: para.unitId, quantity: 1 }],
      })
      .expect(400);

    expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("không thấy phiếu trả của cửa hàng khác", async () => {
    await makeBatch(para.id, "L1", 100);
    const invoice = await sell(para, 10);
    const created = await receiveReturn(invoice.id, {
      disposition: "RESTOCK",
      lines: [{ invoiceLineId: invoice.lines[0].id, unitId: para.unitId, quantity: 1 }],
    }).expect(201);

    const adminToken = (await login("admin")).token;
    await api()
      .get(`/api/v1/returns/${created.body.data.id}`)
      .set(authHeaders(adminToken, fixture.otherStoreId))
      .expect(404);
  });
});
