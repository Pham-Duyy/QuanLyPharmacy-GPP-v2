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
  type MadeProduct,
  type Stage,
} from "./acceptance-helpers.js";

/**
 * Nghiệm thu: phạm vi cửa hàng và phân quyền được chặn ở **máy chủ**, không
 * chỉ ẩn nút trên giao diện.
 */

let stage: Stage;
let para: MadeProduct;

const h = (token: string, storeId: string) => headers(token, storeId);

beforeEach(async () => {
  await truncateAll();
  stage = await setupStage();
  para = await makeProduct(stage, {
    code: "TH0001",
    name: "Paracetamol 500mg",
    units: [["Viên", 1, 2000]],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Phạm vi cửa hàng", () => {
  it("nhân viên quầy B không thao tác được trên dữ liệu quầy A", async () => {
    await makeBatch(stage, { product: para, batchNumber: "A-1", quantity: 100, unitCost: 1000, expiryInDays: 90 });
    const sale = await sell(stage, { lines: [line(para, "Viên", 5)] }, stage.sellerA).expect(201);

    // Gửi kèm X-Store-Id của cửa hàng A bằng token của người chỉ thuộc B.
    const crossStore = await api()
      .get(`/api/v1/invoices/${sale.body.data.id}`)
      .set(h(stage.sellerB, stage.fixture.storeId))
      .expect(403);
    expect(crossStore.body.error.code).toBe("STORE_FORBIDDEN");

    // Đúng cửa hàng của mình thì không thấy hóa đơn của cửa hàng khác.
    const own = await api()
      .get(`/api/v1/invoices/${sale.body.data.id}`)
      .set(h(stage.sellerB, stage.fixture.otherStoreId))
      .expect(404);
    expect(own.body.error.code).toBe("NOT_FOUND");
  });

  it("tồn kho và báo cáo chỉ tính hàng của cửa hàng đang làm việc", async () => {
    await makeBatch(stage, { product: para, batchNumber: "A-2", quantity: 100, unitCost: 1000, expiryInDays: 90 });
    await makeBatch(stage, {
      product: para,
      batchNumber: "B-2",
      quantity: 70,
      unitCost: 1500,
      expiryInDays: 90,
      storeId: stage.fixture.otherStoreId,
    });

    const atA = await api()
      .get(`/api/v1/inventory/batches?productId=${para.id}`)
      .set(h(stage.admin, stage.fixture.storeId))
      .expect(200);
    expect(atA.body.data.items.map((item: { batchNumber: string }) => item.batchNumber)).toEqual(["A-2"]);

    const atB = await api()
      .get(`/api/v1/inventory/batches?productId=${para.id}`)
      .set(h(stage.admin, stage.fixture.otherStoreId))
      .expect(200);
    expect(atB.body.data.items.map((item: { batchNumber: string }) => item.batchNumber)).toEqual(["B-2"]);

    // Bán ở cửa hàng B chỉ trừ tồn của B.
    await sell(stage, { lines: [line(para, "Viên", 10)] }, stage.sellerB, stage.fixture.otherStoreId).expect(201);
    expect((await batchOf("A-2", stage.fixture.storeId)).quantityOnHand).toBe(100);
    expect((await batchOf("B-2", stage.fixture.otherStoreId)).quantityOnHand).toBe(60);

    // Báo cáo của A không có doanh thu của B.
    const reportA = await api()
      .get(`/api/v1/reports/summary?from=${dayKey()}&to=${dayKey(1)}`)
      .set(h(stage.admin, stage.fixture.storeId))
      .expect(200);
    expect(reportA.body.data.kpis.invoiceCount).toBe(0);
    const reportB = await api()
      .get(`/api/v1/reports/summary?from=${dayKey()}&to=${dayKey(1)}`)
      .set(h(stage.admin, stage.fixture.otherStoreId))
      .expect(200);
    expect(reportB.body.data.kpis.invoiceCount).toBe(1);
  });

  it("thiếu X-Store-Id thì endpoint thuộc phạm vi cửa hàng bị chặn", async () => {
    const missing = await api()
      .get("/api/v1/reports/summary?from=2026-01-01&to=2026-12-31")
      .set({ Authorization: `Bearer ${stage.admin}` })
      .expect(400);
    expect(missing.body.error.code).toBe("STORE_REQUIRED");
  });
});

describe("Phân quyền chặn ở máy chủ", () => {
  it("nhân viên bán hàng không nhập hàng, không duyệt điều chỉnh, không bán thuốc kê đơn", async () => {
    const receipt = await draftReceipt(
      stage,
      {
        lines: [
          {
            productId: para.id,
            unitId: para.units["Viên"]!,
            quantity: 10,
            unitCost: 1000,
            batchNumber: "Q-1",
            expiryDate: dayKey(300),
          },
        ],
      },
      stage.sellerA,
    ).expect(403);
    expect(receipt.body.error.code).toBe("FORBIDDEN");

    // Thuốc kê đơn: nhân viên bán hàng không có sale.prescription_drug.
    const amox = await makeProduct(stage, {
      code: "TH0002",
      name: "Amoxicillin 500mg",
      drugClass: "RX",
      units: [["Viên", 1, 3000]],
    });
    await makeBatch(stage, { product: amox, batchNumber: "RX-Q", quantity: 50, unitCost: 1200, expiryInDays: 180 });
    const rx = await sell(stage, { lines: [line(amox, "Viên", 1)] }, stage.sellerA).expect(403);
    expect(rx.body.error.message).toContain("sale.prescription_drug");
  });

  it("giảm giá vượt hạn mức của vai trò bị chặn ở máy chủ", async () => {
    await makeBatch(stage, { product: para, batchNumber: "GG-1", quantity: 100, unitCost: 1000, expiryInDays: 90 });

    // Nhân viên bán hàng: hạn mức 5%. Giảm 20.000/100.000 = 20%.
    const over = await sell(
      stage,
      {
        lines: [line(para, "Viên", 50)],
        discount: { type: "AMOUNT", value: 20_000, reason: "Khách quen" },
      },
      stage.sellerA,
    ).expect(422);
    expect(over.body.error.code).toBe("DISCOUNT_LIMIT_EXCEEDED");
    expect(await prisma.invoice.count()).toBe(0);

    // Dược sĩ: hạn mức 10%, vẫn bị chặn ở mức 20%.
    await sell(
      stage,
      {
        lines: [line(para, "Viên", 50)],
        discount: { type: "AMOUNT", value: 20_000, reason: "Khách quen" },
      },
      stage.pharmacist,
    ).expect(422);

    // Chủ nhà thuốc có quyền vượt hạn mức.
    await sell(
      stage,
      {
        lines: [line(para, "Viên", 50)],
        discount: { type: "AMOUNT", value: 20_000, reason: "Chủ nhà thuốc duyệt" },
      },
      stage.admin,
    ).expect(201);
  });

  it("trả hàng nhà cung cấp trừ công nợ không vượt phần còn nợ", async () => {
    // Lỗi phát hiện trong đợt nghiệm thu: trả hàng trừ công nợ sau khi đã
    // thanh toán đủ làm khoản được hoàn biến mất khỏi sổ công nợ.
    const receipt = await draftReceipt(stage, {
      lines: [
        {
          productId: para.id,
          unitId: para.units["Viên"]!,
          quantity: 100,
          unitCost: 1000,
          batchNumber: "NO-3",
          expiryDate: dayKey(300),
        },
      ],
    }).expect(201);
    await confirmReceipt(stage, receipt.body.data).expect(200);

    await api()
      .post("/api/v1/supplier-payments")
      .set(h(stage.admin, stage.fixture.storeId))
      .send({
        supplierId: stage.supplierId,
        method: "CASH",
        allocations: [{ goodsReceiptId: receipt.body.data.id, amount: 100_000 }],
      })
      .expect(201);

    const batch = await batchOf("NO-3");
    const supplierReturn = await api()
      .post("/api/v1/supplier-returns")
      .set(h(stage.pharmacist, stage.fixture.storeId))
      .send({
        supplierId: stage.supplierId,
        reason: "Hàng cận hạn, nhà cung cấp nhận lại",
        settlement: "DEDUCT_DEBT",
        lines: [{ batchId: batch.id, unitId: para.units["Viên"]!, quantity: 40 }],
      })
      .expect(201);

    const blocked = await api()
      .post(`/api/v1/supplier-returns/${supplierReturn.body.data.id}/confirm`)
      .set({ ...h(stage.pharmacist, stage.fixture.storeId), ...idem() })
      .send({})
      .expect(422);
    expect(blocked.body.error.code).toBe("DEBT_CREDIT_EXCEEDED");
    expect(blocked.body.error.message).toContain("nhận lại tiền hoặc đổi hàng");

    // Không trừ tồn, không đổi trạng thái phiếu.
    expect((await batchOf("NO-3")).quantityOnHand).toBe(100);
    expect(
      (await prisma.supplierReturn.findFirstOrThrow({ where: { id: supplierReturn.body.data.id } })).status,
    ).toBe("DRAFT");

    // Đổi sang hình thức nhận lại tiền thì xác nhận được.
    await prisma.supplierReturn.update({
      where: { id: supplierReturn.body.data.id },
      data: { settlement: "REFUND" },
    });
    await api()
      .post(`/api/v1/supplier-returns/${supplierReturn.body.data.id}/confirm`)
      .set({ ...h(stage.pharmacist, stage.fixture.storeId), ...idem() })
      .send({})
      .expect(200);
    expect((await batchOf("NO-3")).quantityOnHand).toBe(60);
  });
});
