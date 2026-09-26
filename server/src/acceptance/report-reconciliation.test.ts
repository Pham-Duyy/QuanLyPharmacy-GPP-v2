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
  makeProduct,
  sell,
  setupStage,
  stockValue,
  type MadeProduct,
  type Stage,
} from "./acceptance-helpers.js";

/**
 * Nghiệm thu: đối chiếu báo cáo với bảng kỳ vọng tính tay.
 *
 * Toàn bộ số liệu kỳ vọng dưới đây được tính từ kịch bản giao dịch, không
 * lấy từ hàm báo cáo đang kiểm tra:
 *
 *   Nhập    : 100 viên vitamin giá vốn 4.000 và 200 viên para giá vốn 1.000
 *   Bán S1  : 10 vitamin (100.000) + 20 para (40.000)   → giá vốn 60.000
 *   Bán S2  : 5 vitamin (50.000)                        → giá vốn 20.000
 *   Trả R1  : 4 vitamin của S1, nhập lại kho            → hoàn 40.000, giá vốn hoàn 16.000
 *   Bán S3  : 10 para rồi HỦY hóa đơn                   → không tính vào báo cáo
 *
 *   Doanh thu       = 100.000 + 40.000 + 50.000            = 190.000
 *   Tiền hoàn       = 40.000
 *   Doanh thu thuần = 190.000 − 40.000                     = 150.000
 *   Giá vốn bán     = 60.000 + 20.000                      = 80.000
 *   Giá vốn hoàn    = 16.000
 *   Lợi nhuận gộp   = 150.000 − (80.000 − 16.000)          = 86.000
 *   Số hóa đơn      = 2 (hóa đơn đã hủy không tính)
 */

let stage: Stage;
let vitamin: MadeProduct;
let para: MadeProduct;

const h = (token = stage.admin, storeId = stage.fixture.storeId) => headers(token, storeId);

const report = async (from = dayKey(), to = dayKey(1)) =>
  (await api().get(`/api/v1/reports/summary?from=${from}&to=${to}`).set(h()).expect(200)).body.data;

beforeEach(async () => {
  await truncateAll();
  stage = await setupStage();
  vitamin = await makeProduct(stage, {
    code: "TP0001",
    name: "Vitamin C 1000mg",
    productType: "SUPPLEMENT",
    drugClass: null,
    units: [["Viên", 1, 10_000]],
  });
  para = await makeProduct(stage, {
    code: "TH0001",
    name: "Paracetamol 500mg",
    units: [["Viên", 1, 2000]],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Đối chiếu báo cáo với số liệu tính tay", () => {
  it("doanh thu, tiền hoàn, giá vốn, lợi nhuận gộp, tồn kho và thẻ kho đều khớp", async () => {
    // --- Nhập hàng: giá vốn vào kho đúng bằng tiền bỏ ra ---
    const receipt = await draftReceipt(stage, {
      lines: [
        {
          productId: vitamin.id,
          unitId: vitamin.units["Viên"]!,
          quantity: 100,
          unitCost: 4000,
          batchNumber: "VIT-1",
          expiryDate: dayKey(300),
        },
        {
          productId: para.id,
          unitId: para.units["Viên"]!,
          quantity: 200,
          unitCost: 1000,
          batchNumber: "PARA-1",
          expiryDate: dayKey(300),
        },
      ],
    }).expect(201);
    expect(receipt.body.data.totalCost).toBe(100 * 4000 + 200 * 1000);
    await confirmReceipt(stage, receipt.body.data).expect(200);

    const customer = await prisma.customer.create({ data: { fullName: "Chị Lan", phone: "0900000004" } });
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

    // --- Bán hàng ---
    const s1 = await sell(stage, {
      customerId: customer.id,
      lines: [line(vitamin, "Viên", 10), line(para, "Viên", 20)],
    }).expect(201);
    expect(s1.body.data.totalAmount).toBe(140_000);

    const s2 = await sell(stage, { lines: [line(vitamin, "Viên", 5)] }).expect(201);
    expect(s2.body.data.totalAmount).toBe(50_000);

    // --- Trả hàng 4 viên vitamin của S1 ---
    const vitaminLine = s1.body.data.lines.find(
      (item: { productId: string }) => item.productId === vitamin.id,
    );
    const r1 = await api()
      .post(`/api/v1/invoices/${s1.body.data.id}/returns`)
      .set({ ...h(stage.pharmacist), ...idem() })
      .send({
        disposition: "RESTOCK",
        refundMethod: "CASH",
        lines: [{ invoiceLineId: vitaminLine.id, unitId: vitamin.units["Viên"]!, quantity: 4 }],
      })
      .expect(201);
    expect(r1.body.data.refundAmount).toBe(40_000);

    // --- Bán rồi hủy: không được vào báo cáo ---
    const s3 = await sell(stage, { lines: [line(para, "Viên", 10)] }).expect(201);
    await api()
      .post(`/api/v1/invoices/${s3.body.data.id}/void`)
      .set({ ...h(stage.pharmacist), ...idem() })
      .send({ reason: "Khách bỏ đơn" })
      .expect(200);

    // --- Đối chiếu báo cáo ---
    const data = await report();
    expect(data.kpis.netRevenue).toBe(150_000);
    expect(data.kpis.invoiceCount).toBe(2);
    expect(Math.round(data.kpis.grossProfit)).toBe(86_000);
    expect(data.costQuality).toMatchObject({
      saleLines: 3,
      returnLines: 1,
      totalLines: 4,
      actualLines: 4,
      estimatedLines: 0,
      unknownLines: 0,
      exact: true,
    });

    // --- Tồn kho và giá trị tồn ---
    // Vitamin: 100 − 10 − 5 + 4 = 89 viên, giá vốn giữ 4.000.
    expect((await batchOf("VIT-1")).quantityOnHand).toBe(89);
    expect(await stockValue("VIT-1")).toBeCloseTo(89 * 4000, 0);
    // Para: 200 − 20 − 10 (bán rồi hủy, hoàn lại) = 180 viên.
    expect((await batchOf("PARA-1")).quantityOnHand).toBe(180);
    expect(await stockValue("PARA-1")).toBeCloseTo(180 * 1000, 0);

    // --- Thẻ kho của lô vitamin: nhập, hai lần bán, một lần nhận trả ---
    const vitBatch = await batchOf("VIT-1");
    const ledger = await prisma.stockMovement.findMany({
      where: { batchId: vitBatch.id },
      orderBy: { id: "asc" },
    });
    expect(ledger.map((item) => `${item.type}:${item.baseQuantity}:${item.balanceAfter}`)).toEqual([
      "RECEIPT:100:100",
      "SALE:-10:90",
      "SALE:-5:85",
      "CUSTOMER_RETURN:4:89",
    ]);

    // --- Điểm khách: tích 10 (chỉ hàng không phải thuốc), thu lại 4 khi trả ---
    const loyalty = (
      await api().get(`/api/v1/customers/${customer.id}/loyalty`).set(h()).expect(200)
    ).body.data;
    expect(loyalty.balance).toMatchObject({ totalEarned: 10, available: 6, deficit: 0 });
  });

  it("công nợ nhà cung cấp: nhập, trả tiền một phần và trả hàng trừ nợ", async () => {
    const receipt = await draftReceipt(stage, {
      lines: [
        {
          productId: para.id,
          unitId: para.units["Viên"]!,
          quantity: 100,
          unitCost: 1200,
          batchNumber: "NCC-1",
          expiryDate: dayKey(300),
        },
      ],
    }).expect(201);
    await confirmReceipt(stage, receipt.body.data).expect(200);
    const receiptId = receipt.body.data.id as string;

    const outstanding = async () => {
      const debts = await api().get("/api/v1/supplier-debts").set(h()).expect(200);
      return debts.body.data.items.find(
        (item: { supplierId: string }) => item.supplierId === stage.supplierId,
      ).outstanding;
    };
    // Nợ 100 × 1.200 = 120.000.
    expect(await outstanding()).toBe(120_000);

    await api()
      .post("/api/v1/supplier-payments")
      .set(h())
      .send({
        supplierId: stage.supplierId,
        method: "BANK_TRANSFER",
        allocations: [{ goodsReceiptId: receiptId, amount: 50_000 }],
      })
      .expect(201);
    expect(await outstanding()).toBe(70_000);

    // Trả lại nhà cung cấp 10 viên, trừ thẳng vào công nợ: 10 × 1.200 = 12.000.
    const batch = await batchOf("NCC-1");
    const supplierReturn = await api()
      .post("/api/v1/supplier-returns")
      .set(h(stage.pharmacist))
      .send({
        supplierId: stage.supplierId,
        reason: "Hàng cận hạn, nhà cung cấp nhận lại",
        settlement: "DEDUCT_DEBT",
        lines: [{ batchId: batch.id, unitId: para.units["Viên"]!, quantity: 10 }],
      })
      .expect(201);
    await api()
      .post(`/api/v1/supplier-returns/${supplierReturn.body.data.id}/confirm`)
      .set({ ...h(stage.pharmacist), ...idem() })
      .send({})
      .expect(200);

    expect(await outstanding()).toBe(58_000);
    expect((await batchOf("NCC-1")).quantityOnHand).toBe(90);
    expect(await stockValue("NCC-1")).toBeCloseTo(90 * 1200, 0);
  });

  it("báo cáo kỳ đã qua không đổi khi nhập thêm cùng lô", async () => {
    const receipt = await draftReceipt(stage, {
      lines: [
        {
          productId: para.id,
          unitId: para.units["Viên"]!,
          quantity: 100,
          unitCost: 1000,
          batchNumber: "KY-1",
          expiryDate: dayKey(300),
        },
      ],
    }).expect(201);
    await confirmReceipt(stage, receipt.body.data).expect(200);
    await sell(stage, { lines: [line(para, "Viên", 10)] }).expect(201);

    // Doanh thu 20.000, giá vốn 10.000 → lãi gộp 10.000.
    const before = await report();
    expect(Math.round(before.kpis.grossProfit)).toBe(10_000);

    const second = await draftReceipt(stage, {
      lines: [
        {
          productId: para.id,
          unitId: para.units["Viên"]!,
          quantity: 100,
          unitCost: 5000,
          batchNumber: "KY-1",
          expiryDate: dayKey(300),
        },
      ],
    }).expect(201);
    await confirmReceipt(stage, second.body.data).expect(200);

    const after = await report();
    expect(Math.round(after.kpis.grossProfit)).toBe(10_000);
    // Giá vốn lô đã đổi nhưng báo cáo giữ nguyên.
    expect(Number((await batchOf("KY-1")).unitCost)).toBeCloseTo((90 * 1000 + 100 * 5000) / 190, 3);
  });
});
