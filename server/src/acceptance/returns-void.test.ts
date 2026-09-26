import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db/prisma.js";
import { api, truncateAll } from "../test/helpers.js";
import {
  batchOf,
  confirmReceipt,
  dayKey,
  draftReceipt,
  headers,
  idem,
  line,
  makeBatch,
  makeProduct,
  sell,
  setupStage,
  stockValue,
  type MadeProduct,
  type Stage,
} from "./acceptance-helpers.js";

/** Nghiệm thu nghiệp vụ: trả hàng và hủy hóa đơn. */

let stage: Stage;
let para: MadeProduct;

const h = (token = stage.admin, storeId = stage.fixture.storeId) => headers(token, storeId);

const giveBack = (
  invoiceId: string,
  lines: Array<Record<string, unknown>>,
  options: { disposition?: string; reason?: string } = {},
) =>
  api()
    .post(`/api/v1/invoices/${invoiceId}/returns`)
    .set({ ...h(stage.pharmacist), ...idem() })
    .send({
      disposition: options.disposition ?? "RESTOCK",
      refundMethod: "CASH",
      ...(options.reason ? { reason: options.reason } : {}),
      lines,
    });

const voidInvoice = (invoiceId: string, reason = "Khách đổi ý ngay tại quầy") =>
  api()
    .post(`/api/v1/invoices/${invoiceId}/void`)
    .set({ ...h(stage.pharmacist), ...idem() })
    .send({ reason });

beforeEach(async () => {
  await truncateAll();
  stage = await setupStage();
  para = await makeProduct(stage, {
    code: "TH0001",
    name: "Paracetamol 500mg",
    units: [
      ["Viên", 1, 2000],
      ["Vỉ", 10, 19000],
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Trả hàng từng phần", () => {
  it("trả nhiều lần rồi trả hết: tiền hoàn lũy kế không vượt tiền dòng gốc", async () => {
    // Dòng 6 viên giá 2.000 = 12.000, giảm 2.000 → thành tiền 10.000.
    // Chia đều cho 6 đơn vị là 1.666,67đ nên nếu làm tròn từng lần trả sẽ
    // hoàn vượt; tiền hoàn phải tính lũy kế.
    await makeBatch(stage, { product: para, batchNumber: "TRA-1", quantity: 100, unitCost: 900, expiryInDays: 90 });
    const sale = await sell(
      stage,
      {
        lines: [line(para, "Viên", 6)],
        discount: { type: "AMOUNT", value: 2000, reason: "Làm tròn hóa đơn" },
      },
      // Giảm 2.000/12.000 = 16,7% nên cần quyền giảm vượt hạn mức.
      stage.admin,
    ).expect(201);
    expect(sale.body.data.lines[0].lineTotal).toBe(10_000);

    const invoiceLineId = sale.body.data.lines[0].id;
    let refunded = 0;
    for (let index = 0; index < 6; index++) {
      const result = await giveBack(sale.body.data.id, [
        { invoiceLineId, unitId: para.units["Viên"]!, quantity: 1 },
      ]).expect(201);
      refunded += result.body.data.refundAmount;
    }

    expect(refunded).toBe(10_000);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: sale.body.data.id } });
    expect(invoice.returnStatus).toBe("FULL");
    // Hàng về đủ, giá vốn không đổi vì trả đúng giá vốn đã xuất.
    expect((await batchOf("TRA-1")).quantityOnHand).toBe(100);
    expect(await stockValue("TRA-1")).toBeCloseTo(100 * 900, 0);
  });

  it("trả dòng xuất từ nhiều lô: phải chỉ rõ lô, hoàn đúng lô đó", async () => {
    await makeBatch(stage, { product: para, batchNumber: "LO-A", quantity: 5, unitCost: 1000, expiryInDays: 30 });
    await makeBatch(stage, { product: para, batchNumber: "LO-B", quantity: 50, unitCost: 2000, expiryInDays: 90 });

    // 1 vỉ = 10 viên: 5 viên của LO-A rồi 5 viên của LO-B.
    const sale = await sell(stage, { lines: [line(para, "Vỉ", 2)] }).expect(201);
    const invoiceLine = sale.body.data.lines[0];
    expect(invoiceLine.allocations).toHaveLength(2);

    // Không chỉ lô thì bị chặn.
    const vague = await giveBack(sale.body.data.id, [
      { invoiceLineId: invoiceLine.id, unitId: para.units["Vỉ"]!, quantity: 1 },
    ]).expect(422);
    expect(vague.body.error.message).toContain("chọn đúng lô");

    // Trả đúng lô B: hàng và giá trị quay về lô B.
    const allocationB = invoiceLine.allocations.find(
      (item: { batchNumber: string }) => item.batchNumber === "LO-B",
    );
    const beforeA = await batchOf("LO-A");
    await giveBack(sale.body.data.id, [
      {
        invoiceLineId: invoiceLine.id,
        allocationId: allocationB.id,
        unitId: para.units["Vỉ"]!,
        quantity: 1,
      },
    ]).expect(201);

    expect((await batchOf("LO-B")).quantityOnHand).toBe(50 - 15 + 10);
    expect((await batchOf("LO-A")).quantityOnHand).toBe(beforeA.quantityOnHand);
    // Còn 45 viên giá vốn 2.000 (bán 15, nhận lại 10 đúng giá vốn cũ).
    expect(await stockValue("LO-B")).toBeCloseTo(45 * 2000, 0);
  });

  it("hàng trả để tiêu hủy không làm tăng tồn cuối và không đổi giá vốn còn lại", async () => {
    await makeBatch(stage, { product: para, batchNumber: "HUY-1", quantity: 100, unitCost: 1000, expiryInDays: 90 });
    const sale = await sell(stage, { lines: [line(para, "Viên", 10)] }).expect(201);

    const receipt = await draftReceipt(stage, {
      lines: [
        {
          productId: para.id,
          unitId: para.units["Viên"]!,
          quantity: 100,
          unitCost: 3000,
          batchNumber: "HUY-1",
          expiryDate: dayKey(90),
        },
      ],
    }).expect(201);
    await confirmReceipt(stage, receipt.body.data).expect(200);
    const before = await batchOf("HUY-1");

    await giveBack(
      sale.body.data.id,
      [{ invoiceLineId: sale.body.data.lines[0].id, unitId: para.units["Viên"]!, quantity: 4 }],
      { disposition: "DISPOSE", reason: "Vỉ thuốc bị móp, không bán lại" },
    ).expect(201);

    const after = await batchOf("HUY-1");
    expect(after.quantityOnHand).toBe(before.quantityOnHand);
    expect(Number(after.unitCost)).toBeCloseTo(Number(before.unitCost), 4);

    // Thẻ kho ghi đủ đường đi thật: hàng vào rồi bị hủy.
    const ledger = await prisma.stockMovement.findMany({
      where: { sourceType: "RETURN" },
      orderBy: { id: "asc" },
    });
    expect(ledger.map((item) => `${item.type}:${item.baseQuantity}`)).toEqual([
      "CUSTOMER_RETURN:4",
      "DISPOSAL:-4",
    ]);
  });

  it("hủy hóa đơn sau khi nhập thêm cùng lô: hoàn đúng số lượng và giá trị", async () => {
    await makeBatch(stage, { product: para, batchNumber: "HUY-2", quantity: 100, unitCost: 1000, expiryInDays: 90 });
    const sale = await sell(stage, { lines: [line(para, "Viên", 10)] }).expect(201);

    const receipt = await draftReceipt(stage, {
      lines: [
        {
          productId: para.id,
          unitId: para.units["Viên"]!,
          quantity: 100,
          unitCost: 3000,
          batchNumber: "HUY-2",
          expiryDate: dayKey(90),
        },
      ],
    }).expect(201);
    await confirmReceipt(stage, receipt.body.data).expect(200);

    await voidInvoice(sale.body.data.id).expect(200);

    // Tiền đã bỏ ra: 100 × 1.000 + 100 × 3.000 = 400.000 cho 200 viên.
    const batch = await batchOf("HUY-2");
    expect(batch.quantityOnHand).toBe(200);
    expect(await stockValue("HUY-2")).toBeCloseTo(400_000, 0);
    expect(Number(batch.unitCost)).toBeCloseTo(2000, 4);
  });
});

describe("Chặn thao tác sai trạng thái", () => {
  it("hóa đơn đã có phiếu trả thì không hủy được và ngược lại", async () => {
    await makeBatch(stage, { product: para, batchNumber: "TT-1", quantity: 100, unitCost: 1000, expiryInDays: 90 });

    const sale = await sell(stage, { lines: [line(para, "Viên", 5)] }).expect(201);
    await giveBack(sale.body.data.id, [
      { invoiceLineId: sale.body.data.lines[0].id, unitId: para.units["Viên"]!, quantity: 1 },
    ]).expect(201);
    const blocked = await voidInvoice(sale.body.data.id).expect(409);
    expect(blocked.body.error.message).toContain("phiếu trả");

    const second = await sell(stage, { lines: [line(para, "Viên", 5)] }).expect(201);
    await voidInvoice(second.body.data.id).expect(200);
    const late = await giveBack(second.body.data.id, [
      { invoiceLineId: second.body.data.lines[0].id, unitId: para.units["Viên"]!, quantity: 1 },
    ]).expect(409);
    expect(late.body.error.message).toContain("đã hủy");
  });
});

describe("Ảnh hưởng tới điểm khách và đơn thuốc", () => {
  it("hủy hóa đơn trả lại điểm đã đổi và thu lại điểm đã tích", async () => {
    const vitamin = await makeProduct(stage, {
      code: "TP0001",
      name: "Vitamin C 1000mg",
      productType: "SUPPLEMENT",
      drugClass: null,
      units: [["Viên", 1, 10_000]],
    });
    await makeBatch(stage, { product: vitamin, batchNumber: "TP-1", quantity: 200, unitCost: 4000, expiryInDays: 200 });
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

    const customer = await prisma.customer.create({ data: { fullName: "Chị Lan", phone: "0900000002" } });
    // Mua 300.000đ → 30 điểm.
    await sell(stage, { customerId: customer.id, lines: [line(vitamin, "Viên", 30)] }).expect(201);
    const balance = async () =>
      (await api().get(`/api/v1/customers/${customer.id}/loyalty`).set(h()).expect(200)).body.data.balance;
    expect((await balance()).available).toBe(30);

    // Đổi 20 điểm = 10.000đ trên hóa đơn 100.000đ, còn phải trả 90.000 → tích 9 điểm.
    const second = await sell(stage, {
      customerId: customer.id,
      lines: [line(vitamin, "Viên", 10)],
      loyaltyRedeemPoints: 20,
    }).expect(201);
    expect(second.body.data.totalAmount).toBe(90_000);
    expect((await balance()).available).toBe(30 - 20 + 9);

    await voidInvoice(second.body.data.id).expect(200);
    expect((await balance()).available).toBe(30);
    expect((await balance()).deficit).toBe(0);
  });

  it("trả hàng thuốc kê đơn giảm đúng số đã cấp phát của đơn", async () => {
    const amox = await makeProduct(stage, {
      code: "TH0002",
      name: "Amoxicillin 500mg",
      drugClass: "RX",
      units: [["Viên", 1, 3000]],
    });
    await makeBatch(stage, { product: amox, batchNumber: "RX-1", quantity: 100, unitCost: 1200, expiryInDays: 180 });
    const customer = await prisma.customer.create({ data: { fullName: "Anh Nam", phone: "0900000003" } });

    const created = await api()
      .post("/api/v1/prescriptions")
      .set(h(stage.pharmacist))
      .send({
        customerId: customer.id,
        prescriberName: "BS. Lê Thị B",
        prescribedDate: dayKey(0),
        items: [{ productId: amox.id, drugNameText: "Amoxicillin 500mg", unitId: amox.units["Viên"]!, quantity: 20 }],
      })
      .expect(201);
    await api()
      .post(`/api/v1/prescriptions/${created.body.data.id}/verify`)
      .set({ ...h(stage.pharmacist), ...idem() })
      .send({})
      .expect(200);

    const sale = await sell(
      stage,
      { customerId: customer.id, prescriptionId: created.body.data.id, lines: [line(amox, "Viên", 10)] },
      stage.pharmacist,
    ).expect(201);
    expect(
      (await prisma.prescriptionItem.findFirstOrThrow({ where: { prescriptionId: created.body.data.id } }))
        .dispensedBaseQuantity,
    ).toBe(10);

    // Thuốc kê đơn chỉ nhận trả khi có lỗi chất lượng và phải hủy hàng.
    await giveBack(
      sale.body.data.id,
      [{ invoiceLineId: sale.body.data.lines[0].id, unitId: amox.units["Viên"]!, quantity: 4 }],
      { disposition: "DISPOSE", reason: "Vỉ thuốc bị ẩm, thu hồi khỏi khách" },
    ).expect(201);

    const item = await prisma.prescriptionItem.findFirstOrThrow({
      where: { prescriptionId: created.body.data.id },
    });
    expect(item.dispensedBaseQuantity).toBe(6);
    const prescription = await prisma.prescription.findUniqueOrThrow({ where: { id: created.body.data.id } });
    expect(prescription.status).toBe("PARTIALLY_DISPENSED");
  });
});
