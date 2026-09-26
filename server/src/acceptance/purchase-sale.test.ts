import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db/prisma.js";
import { api, truncateAll } from "../test/helpers.js";
import {
  COST_TOLERANCE,
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
  vatOf,
  type MadeProduct,
  type Stage,
} from "./acceptance-helpers.js";

/**
 * Nghiệm thu nghiệp vụ: nhập hàng → bán hàng.
 *
 * Mọi số kỳ vọng dưới đây đều tính tay từ dữ liệu của chính ca kiểm thử và
 * ghi rõ phép tính trong chú thích, không lấy từ hàm nghiệp vụ đang kiểm tra.
 */

let stage: Stage;
let para: MadeProduct;

const h = (token = stage.admin, storeId = stage.fixture.storeId) => headers(token, storeId);

beforeEach(async () => {
  await truncateAll();
  stage = await setupStage();
  // Paracetamol: Viên 2.000đ, Vỉ (10 viên) 19.000đ, Hộp (100 viên) 180.000đ.
  para = await makeProduct(stage, {
    code: "TH0001",
    name: "Paracetamol 500mg",
    units: [
      ["Viên", 1, 2000],
      ["Vỉ", 10, 19000],
      ["Hộp", 100, 180000],
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Nhập hàng", () => {
  it("kiểm nhập đạt: tồn, giá vốn, thẻ kho và công nợ đều đúng", async () => {
    // 10 hộp × 120.000 = 1.200.000 tiền hàng, chiết khấu 100.000 → phải trả
    // 1.100.000 cho 1.000 viên ⇒ giá vốn 1.100đ/viên.
    const receipt = await draftReceipt(stage, {
      discountAmount: 100_000,
      supplierInvoiceNumber: "0001234",
      lines: [
        {
          productId: para.id,
          unitId: para.units["Hộp"]!,
          quantity: 10,
          unitCost: 120_000,
          batchNumber: "PN-A",
          expiryDate: dayKey(400),
        },
      ],
    }).expect(201);
    expect(receipt.body.data).toMatchObject({
      goodsAmount: 1_200_000,
      discountAmount: 100_000,
      totalCost: 1_100_000,
      status: "DRAFT",
    });

    await confirmReceipt(stage, receipt.body.data).expect(200);

    const batch = await batchOf("PN-A");
    expect(batch.quantityOnHand).toBe(1000);
    expect(Number(batch.unitCost)).toBeCloseTo(1100, 4);
    expect(batch.status).toBe("AVAILABLE");

    // Thẻ kho: đúng một bút toán nhập, số dư sau bằng tồn.
    const ledger = await prisma.stockMovement.findMany({ where: { batchId: batch.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: "RECEIPT", baseQuantity: 1000, balanceAfter: 1000 });

    // Công nợ nhà cung cấp đúng bằng tiền phải trả, hạn 30 ngày.
    const debts = await api().get("/api/v1/supplier-debts").set(h()).expect(200);
    const supplier = debts.body.data.items.find(
      (item: { supplierId: string }) => item.supplierId === stage.supplierId,
    );
    expect(supplier.outstanding).toBe(1_100_000);
    const saved = await prisma.goodsReceipt.findFirstOrThrow({ where: { code: receipt.body.data.code } });
    expect(saved.paymentDueDate?.toISOString().slice(0, 10)).toBe(dayKey(30));
  });

  it("kiểm nhập không đạt: lô bị biệt trữ và không bán được", async () => {
    const receipt = await draftReceipt(stage, {
      lines: [
        {
          productId: para.id,
          unitId: para.units["Hộp"]!,
          quantity: 2,
          unitCost: 100_000,
          batchNumber: "PN-LOI",
          expiryDate: dayKey(400),
        },
      ],
    }).expect(201);

    await confirmReceipt(stage, receipt.body.data, [
      { lineId: receipt.body.data.lines[0].id, passed: false, rejectReason: "Vỏ hộp rách, nghi ngờ ẩm" },
    ]).expect(200);

    const batch = await batchOf("PN-LOI");
    expect(batch.status).toBe("QUARANTINED");
    expect(batch.quantityOnHand).toBe(200);

    // Hàng biệt trữ vẫn nằm trong kho nhưng không bán được.
    const blocked = await sell(stage, { lines: [line(para, "Viên", 1)] }).expect(409);
    expect(blocked.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(await prisma.invoice.count()).toBe(0);
  });

  it("nhập thêm cùng lô với giá khác: giá vốn bình quân gia quyền", async () => {
    const first = await draftReceipt(stage, {
      lines: [
        {
          productId: para.id,
          unitId: para.units["Hộp"]!,
          quantity: 4,
          unitCost: 100_000,
          batchNumber: "PN-B",
          expiryDate: dayKey(400),
        },
      ],
    }).expect(201);
    await confirmReceipt(stage, first.body.data).expect(200);
    // 400 viên giá 1.000.
    expect(Number((await batchOf("PN-B")).unitCost)).toBeCloseTo(1000, 4);

    const second = await draftReceipt(stage, {
      lines: [
        {
          productId: para.id,
          unitId: para.units["Hộp"]!,
          quantity: 2,
          unitCost: 190_000,
          batchNumber: "PN-B",
          expiryDate: dayKey(400),
        },
      ],
    }).expect(201);
    await confirmReceipt(stage, second.body.data).expect(200);

    // (400 × 1.000 + 200 × 1.900) / 600 = 780.000 / 600 = 1.300
    const batch = await batchOf("PN-B");
    expect(batch.quantityOnHand).toBe(600);
    expect(Number(batch.unitCost)).toBeCloseTo(1300, 4);
    expect(batch.quantityOnHand * Number(batch.unitCost)).toBeCloseTo(780_000, 0);
  });

  it("cùng số lô nhưng khác hạn dùng thì chặn cả phiếu", async () => {
    const first = await draftReceipt(stage, {
      lines: [
        {
          productId: para.id,
          unitId: para.units["Viên"]!,
          quantity: 10,
          unitCost: 1000,
          batchNumber: "PN-C",
          expiryDate: dayKey(300),
        },
      ],
    }).expect(201);
    await confirmReceipt(stage, first.body.data).expect(200);

    const second = await draftReceipt(stage, {
      lines: [
        {
          productId: para.id,
          unitId: para.units["Viên"]!,
          quantity: 10,
          unitCost: 1000,
          batchNumber: "PN-C",
          expiryDate: dayKey(301),
        },
      ],
    }).expect(201);
    const clash = await confirmReceipt(stage, second.body.data).expect(409);
    expect(clash.body.error.code).toBe("BATCH_EXPIRY_MISMATCH");
    // Phiếu thứ hai không được ghi gì vào kho.
    expect((await batchOf("PN-C")).quantityOnHand).toBe(10);
  });
});

describe("Bán hàng", () => {
  it("bán hộp/vỉ/viên: quy đổi, FEFO qua hai lô, giảm giá, VAT và tiền thừa", async () => {
    // LO-A hết hạn sớm hơn nên phải xuất trước.
    await makeBatch(stage, { product: para, batchNumber: "LO-A", quantity: 110, unitCost: 1000, expiryInDays: 30 });
    await makeBatch(stage, { product: para, batchNumber: "LO-B", quantity: 500, unitCost: 1500, expiryInDays: 120 });

    const sale = await sell(stage, {
      lines: [line(para, "Hộp", 1), line(para, "Vỉ", 2), line(para, "Viên", 5)],
      discount: { type: "AMOUNT", value: 8000, reason: "Khách quen" },
      payment: { method: "CASH", amountTendered: 250_000 },
    }).expect(201);

    // Tiền hàng: 180.000 + 38.000 + 10.000 = 228.000.
    // Giảm 8.000 phân bổ theo tỷ trọng, dòng cuối nhận phần dư:
    //   dòng 1: 8.000 × 180/228 = 6.315 (làm tròn xuống)
    //   dòng 2: 8.000 × 38/228  = 1.333
    //   dòng 3: 8.000 − 6.315 − 1.333 = 352
    const data = sale.body.data;
    expect(data.subtotal).toBe(228_000);
    expect(data.discountAmount).toBe(8000);
    expect(data.totalAmount).toBe(220_000);
    expect(data.lines.map((item: { lineTotal: number }) => item.lineTotal)).toEqual([
      173_685, 36_667, 9648,
    ]);
    // VAT tách ngược từng dòng rồi cộng lại.
    expect(data.vatAmount).toBe(vatOf(173_685) + vatOf(36_667) + vatOf(9648));
    expect(data.vatAmount).toBe(10_476);
    expect(data.changeAmount).toBe(30_000);

    // FEFO: dòng 1 lấy 100 của LO-A; dòng 2 lấy nốt 10 của LO-A rồi 10 của
    // LO-B; dòng 3 lấy 5 của LO-B.
    const allocations = data.lines.map((item: { allocations: Array<{ batchNumber: string; baseQuantity: number }> }) =>
      item.allocations.map((a) => `${a.batchNumber}:${a.baseQuantity}`),
    );
    expect(allocations).toEqual([["LO-A:100"], ["LO-A:10", "LO-B:10"], ["LO-B:5"]]);

    expect((await batchOf("LO-A")).quantityOnHand).toBe(0);
    expect((await batchOf("LO-B")).quantityOnHand).toBe(485);

    // Giá vốn chụp lúc xuất: 100 + 10 viên giá 1.000; 10 + 5 viên giá 1.500.
    const saved = await prisma.invoiceAllocation.findMany({
      where: { invoiceLine: { invoiceId: data.id } },
      include: { batch: { select: { batchNumber: true } } },
    });
    const cogs = saved.reduce((sum, item) => sum + item.baseQuantity * Number(item.unitCost), 0);
    expect(cogs).toBe(110 * 1000 + 15 * 1500);
    expect(saved.every((item) => item.unitCostSource === "ACTUAL")).toBe(true);

    // Thẻ kho ghi đủ các lần xuất, số dư sau khớp tồn thực tế.
    const ledger = await prisma.stockMovement.findMany({
      where: { sourceId: data.id },
      orderBy: { id: "asc" },
    });
    expect(ledger).toHaveLength(4);
    expect(ledger.map((item) => item.baseQuantity)).toEqual([-100, -10, -10, -5]);
    expect(ledger.at(-1)!.balanceAfter).toBe(485);
  });

  it("chặn bán lô hết hạn, lô thu hồi và lô biệt trữ", async () => {
    await makeBatch(stage, { product: para, batchNumber: "HET-HAN", quantity: 100, unitCost: 1000, expiryInDays: -1 });
    await makeBatch(stage, { product: para, batchNumber: "THU-HOI", quantity: 100, unitCost: 1000, status: "RECALLED" });
    await makeBatch(stage, { product: para, batchNumber: "BIET-TRU", quantity: 100, unitCost: 1000, status: "QUARANTINED" });

    const blocked = await sell(stage, { lines: [line(para, "Viên", 1)] }).expect(409);
    expect(blocked.body.error.code).toBe("INSUFFICIENT_STOCK");

    // Thêm 20 viên bán được: chỉ bán được tối đa 20.
    await makeBatch(stage, { product: para, batchNumber: "BAN-DUOC", quantity: 20, unitCost: 1000, expiryInDays: 90 });
    const over = await sell(stage, { lines: [line(para, "Viên", 21)] }).expect(409);
    expect(over.body.error.details[0]).toMatchObject({ sellableBaseQuantity: 20, requestedBaseQuantity: 21 });

    const ok = await sell(stage, { lines: [line(para, "Viên", 20)] }).expect(201);
    expect(ok.body.data.lines[0].allocations[0].batchNumber).toBe("BAN-DUOC");
    expect((await batchOf("HET-HAN")).quantityOnHand).toBe(100);
    expect((await batchOf("THU-HOI")).quantityOnHand).toBe(100);
    expect((await batchOf("BIET-TRU")).quantityOnHand).toBe(100);
  });

  it("bán thuốc kê đơn: liên kết đúng dòng đơn và cộng dồn số đã cấp phát", async () => {
    const amox = await makeProduct(stage, {
      code: "TH0002",
      name: "Amoxicillin 500mg",
      drugClass: "RX",
      units: [["Viên", 1, 3000]],
    });
    await makeBatch(stage, { product: amox, batchNumber: "RX-1", quantity: 100, unitCost: 1200, expiryInDays: 180 });

    const customer = await prisma.customer.create({ data: { fullName: "Chị Lan", phone: "0900000001" } });
    const created = await api()
      .post("/api/v1/prescriptions")
      .set(h(stage.pharmacist))
      .send({
        customerId: customer.id,
        prescriberName: "BS. Trần Văn A",
        facilityName: "Bệnh viện Q.1",
        prescribedDate: dayKey(0),
        items: [
          { productId: amox.id, drugNameText: "Amoxicillin 500mg", unitId: amox.units["Viên"]!, quantity: 20 },
        ],
      })
      .expect(201);
    await api()
      .post(`/api/v1/prescriptions/${created.body.data.id}/verify`)
      .set({ ...h(stage.pharmacist), ...idem() })
      .send({})
      .expect(200);

    // Bán hai lần, không gửi prescriptionItemId: máy chủ tự khớp dòng đơn.
    await sell(
      stage,
      { customerId: customer.id, prescriptionId: created.body.data.id, lines: [line(amox, "Viên", 8)] },
      stage.pharmacist,
    ).expect(201);
    await sell(
      stage,
      { customerId: customer.id, prescriptionId: created.body.data.id, lines: [line(amox, "Viên", 7)] },
      stage.pharmacist,
    ).expect(201);

    const item = await prisma.prescriptionItem.findFirstOrThrow({ where: { prescriptionId: created.body.data.id } });
    expect(item.dispensedBaseQuantity).toBe(15);
    const savedLines = await prisma.invoiceLine.findMany({ where: { productId: amox.id } });
    expect(savedLines).toHaveLength(2);
    expect(savedLines.every((row) => row.prescriptionItemId === item.id)).toBe(true);

    // Bán vượt số kê bị chặn.
    const over = await sell(
      stage,
      { customerId: customer.id, prescriptionId: created.body.data.id, lines: [line(amox, "Viên", 6)] },
      stage.pharmacist,
    ).expect(422);
    expect(over.body.error.code).toBe("PRESCRIBED_QUANTITY_EXCEEDED");
    expect((await prisma.prescriptionItem.findFirstOrThrow({ where: { id: item.id } })).dispensedBaseQuantity).toBe(15);
  });

  it("giá vốn trên hóa đơn giữ nguyên khi nhập thêm cùng lô về sau", async () => {
    await makeBatch(stage, { product: para, batchNumber: "GIU-GIA", quantity: 100, unitCost: 1000, expiryInDays: 90 });
    const sale = await sell(stage, { lines: [line(para, "Viên", 10)] }).expect(201);

    const before = await prisma.invoiceAllocation.findFirstOrThrow({
      where: { invoiceLine: { invoiceId: sale.body.data.id } },
    });
    expect(Number(before.unitCost)).toBeCloseTo(1000, 4);

    const receipt = await draftReceipt(stage, {
      lines: [
        {
          productId: para.id,
          unitId: para.units["Viên"]!,
          quantity: 100,
          unitCost: 3000,
          batchNumber: "GIU-GIA",
          expiryDate: dayKey(90),
        },
      ],
    }).expect(201);
    await confirmReceipt(stage, receipt.body.data).expect(200);

    // Lô nay bình quân (90 × 1.000 + 100 × 3.000) / 190 = 2.052,6316
    const batch = await batchOf("GIU-GIA");
    expect(Number(batch.unitCost)).toBeCloseTo((90 * 1000 + 100 * 3000) / 190, 3);

    // Giá vốn đã chụp trên hóa đơn không đổi.
    const after = await prisma.invoiceAllocation.findFirstOrThrow({ where: { id: before.id } });
    expect(Number(after.unitCost)).toBeCloseTo(1000, 4);
    expect(Math.abs(Number(after.unitCost) - 1000)).toBeLessThan(COST_TOLERANCE + 0.0001);
  });
});
