import { Prisma } from "../generated/prisma/client.js";
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
  type Stage,
} from "./acceptance-helpers.js";

/**
 * Nghiệm thu: hai quầy thao tác đồng thời.
 *
 * Các ca quan trọng **không** chỉ bắn hai request rồi hy vọng có tranh chấp.
 * Một transaction thứ ba giữ khóa hàng của bản ghi tranh chấp, hai request
 * cùng dừng tại đó (kiểm tra bằng `pg_stat_activity`), rồi mới thả ra. Nhờ
 * vậy hai giao dịch chắc chắn chồng lấn nhau.
 */

let stage: Stage;

const h = (token = stage.admin, storeId = stage.fixture.storeId) => headers(token, storeId);

/** Đếm số phiên đang chờ khóa hàng với câu lệnh khớp mẫu. */
async function waitersFor(pattern: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'
      AND query ILIKE ${pattern}
  `);
  return rows[0]?.n ?? 0;
}

type Coordinated<T> = { results: Array<PromiseSettledResult<T>>; waiters: number };

/**
 * Giữ khóa một hàng, chạy hai thao tác, chờ cả hai thật sự bị chặn rồi thả.
 * Trả về kết quả hai thao tác và số phiên đã bị chặn (phải là 2).
 */
async function coordinate<T>(
  lock: Prisma.Sql,
  waitPattern: string,
  operations: [() => Promise<T>, () => Promise<T>],
): Promise<Coordinated<T>> {
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });

  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw(lock);
      locked();
      await gate;
    },
    { timeout: 20_000 },
  );
  await ready;

  const pending = Promise.allSettled(operations.map((run) => run()));

  let waiters = 0;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    waiters = await waitersFor(waitPattern);
    if (waiters >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  release();
  await holder;
  return { results: await pending, waiters };
}

const statusesOf = (results: Array<PromiseSettledResult<{ status: number }>>) =>
  results.map((item) => (item.status === "fulfilled" ? item.value.status : 0));

beforeEach(async () => {
  await truncateAll();
  stage = await setupStage();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Hai quầy bán cùng lúc", () => {
  it("cùng tranh phần tồn cuối: không bán vượt, không âm tồn", async () => {
    const para = await makeProduct(stage, {
      code: "TH0001",
      name: "Paracetamol 500mg",
      units: [["Viên", 1, 2000]],
    });
    await makeBatch(stage, { product: para, batchNumber: "CUOI", quantity: 10, unitCost: 1000, expiryInDays: 90 });

    const { results, waiters } = await coordinate(
      Prisma.sql`SELECT id FROM batches WHERE batch_number = 'CUOI' FOR UPDATE`,
      "%batches%",
      [
        () => sell(stage, { lines: [line(para, "Viên", 10)] }, stage.sellerA),
        () => sell(stage, { lines: [line(para, "Viên", 10)] }, stage.pharmacist),
      ],
    );

    expect(waiters).toBe(2);
    const statuses = statusesOf(results);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);
    expect((await batchOf("CUOI")).quantityOnHand).toBe(0);
    expect(await prisma.invoice.count()).toBe(1);
  });

  it("hai giỏ hàng chạm hai lô theo thứ tự ngược nhau: không deadlock", async () => {
    const one = await makeProduct(stage, { code: "TH0001", name: "Thuốc A", units: [["Viên", 1, 2000]] });
    const two = await makeProduct(stage, { code: "TH0002", name: "Thuốc B", units: [["Viên", 1, 3000]] });
    await makeBatch(stage, { product: one, batchNumber: "A1", quantity: 100, unitCost: 1000, expiryInDays: 90 });
    await makeBatch(stage, { product: two, batchNumber: "B1", quantity: 100, unitCost: 1500, expiryInDays: 90 });

    // Hai quầy gõ giỏ hàng theo thứ tự ngược nhau; máy chủ phải khóa lô theo
    // một thứ tự cố định để không khóa chéo.
    const results = await Promise.allSettled([
      sell(stage, { lines: [line(one, "Viên", 5), line(two, "Viên", 5)] }, stage.sellerA),
      sell(stage, { lines: [line(two, "Viên", 5), line(one, "Viên", 5)] }, stage.pharmacist),
    ]);

    expect(statusesOf(results)).toEqual([201, 201]);
    expect((await batchOf("A1")).quantityOnHand).toBe(90);
    expect((await batchOf("B1")).quantityOnHand).toBe(90);
    // Không có lỗi 500 do deadlock.
    expect(statusesOf(results).some((status) => status >= 500)).toBe(false);
  });

  it("hai hóa đơn cùng đổi số điểm còn lại: không đổi vượt số dư", async () => {
    const vitamin = await makeProduct(stage, {
      code: "TP0001",
      name: "Vitamin C",
      productType: "SUPPLEMENT",
      drugClass: null,
      units: [["Viên", 1, 10_000]],
    });
    await makeBatch(stage, { product: vitamin, batchNumber: "TP1", quantity: 500, unitCost: 4000, expiryInDays: 200 });
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

    const customer = await prisma.customer.create({ data: { fullName: "Chị Lan", phone: "0900000005" } });
    await sell(stage, { customerId: customer.id, lines: [line(vitamin, "Viên", 30)] }).expect(201);

    const { results, waiters } = await coordinate(
      Prisma.sql`SELECT id FROM customers WHERE id = ${customer.id}::uuid FOR UPDATE`,
      "%customers%",
      [
        () =>
          sell(stage, {
            customerId: customer.id,
            lines: [line(vitamin, "Viên", 10)],
            loyaltyRedeemPoints: 30,
          }),
        () =>
          sell(
            stage,
            { customerId: customer.id, lines: [line(vitamin, "Viên", 10)], loyaltyRedeemPoints: 30 },
            stage.pharmacist,
          ),
      ],
    );

    expect(waiters).toBe(2);
    const redeemed = results.filter(
      (item) =>
        item.status === "fulfilled" &&
        item.value.status === 201 &&
        item.value.body.data.loyaltyPointsRedeemed === 30,
    );
    expect(redeemed).toHaveLength(1);

    const balance = (
      await api().get(`/api/v1/customers/${customer.id}/loyalty`).set(h()).expect(200)
    ).body.data.balance;
    expect(balance.deficit).toBe(0);
    const ledger = await prisma.loyaltyTransaction.aggregate({ _sum: { points: true } });
    expect(Number(ledger._sum.points)).toBe(balance.available);
  });

  it("hai lần cấp phát cùng đơn thuốc: không vượt số kê", async () => {
    const amox = await makeProduct(stage, {
      code: "TH0003",
      name: "Amoxicillin 500mg",
      drugClass: "RX",
      units: [["Viên", 1, 3000]],
    });
    await makeBatch(stage, { product: amox, batchNumber: "RX1", quantity: 100, unitCost: 1200, expiryInDays: 180 });
    const customer = await prisma.customer.create({ data: { fullName: "Anh Nam", phone: "0900000006" } });

    const created = await api()
      .post("/api/v1/prescriptions")
      .set(h(stage.pharmacist))
      .send({
        customerId: customer.id,
        prescriberName: "BS. Trần Văn A",
        prescribedDate: dayKey(0),
        items: [{ productId: amox.id, drugNameText: "Amoxicillin 500mg", unitId: amox.units["Viên"]!, quantity: 10 }],
      })
      .expect(201);
    await api()
      .post(`/api/v1/prescriptions/${created.body.data.id}/verify`)
      .set({ ...h(stage.pharmacist), ...idem() })
      .send({})
      .expect(200);

    const { results, waiters } = await coordinate(
      Prisma.sql`SELECT id FROM prescription_items WHERE prescription_id = ${created.body.data.id}::uuid FOR UPDATE`,
      "%prescription_items%",
      [
        () =>
          sell(
            stage,
            { customerId: customer.id, prescriptionId: created.body.data.id, lines: [line(amox, "Viên", 7)] },
            stage.pharmacist,
          ),
        () =>
          sell(
            stage,
            { customerId: customer.id, prescriptionId: created.body.data.id, lines: [line(amox, "Viên", 7)] },
            stage.pharmacistB,
          ),
      ],
    );

    expect(waiters).toBe(2);
    expect(statusesOf(results).filter((status) => status === 201)).toHaveLength(1);
    const item = await prisma.prescriptionItem.findFirstOrThrow({
      where: { prescriptionId: created.body.data.id },
    });
    expect(item.dispensedBaseQuantity).toBe(7);
  });

  it("hủy và trả hàng cùng một hóa đơn: chỉ một nghiệp vụ hoàn tất", async () => {
    const para = await makeProduct(stage, { code: "TH0004", name: "Thuốc C", units: [["Viên", 1, 2000]] });
    await makeBatch(stage, { product: para, batchNumber: "HD1", quantity: 100, unitCost: 1000, expiryInDays: 90 });
    const sale = await sell(stage, { lines: [line(para, "Viên", 10)] }).expect(201);

    const { results, waiters } = await coordinate(
      Prisma.sql`SELECT id FROM invoices WHERE id = ${sale.body.data.id}::uuid FOR UPDATE`,
      "%invoices%",
      [
        () =>
          api()
            .post(`/api/v1/invoices/${sale.body.data.id}/void`)
            .set({ ...h(stage.pharmacist), ...idem() })
            .send({ reason: "Khách đổi ý ngay tại quầy" }),
        () =>
          api()
            .post(`/api/v1/invoices/${sale.body.data.id}/returns`)
            .set({ ...h(stage.pharmacist), ...idem() })
            .send({
              disposition: "RESTOCK",
              refundMethod: "CASH",
              lines: [{ invoiceLineId: sale.body.data.lines[0].id, unitId: para.units["Viên"]!, quantity: 10 }],
            }),
      ],
    );

    expect(waiters).toBe(2);
    expect(statusesOf(results).filter((status) => status >= 200 && status < 300)).toHaveLength(1);
    // Hàng chỉ quay về kho đúng một lần.
    expect((await batchOf("HD1")).quantityOnHand).toBe(100);
    expect(await stockValue("HD1")).toBeCloseTo(100 * 1000, 0);
    const back = await prisma.stockMovement.count({
      where: { type: { in: ["SALE_VOID", "CUSTOMER_RETURN"] } },
    });
    expect(back).toBe(1);
  });
});

describe("Nhập hàng đồng thời", () => {
  it("hai phiếu nhập vào cùng một lô đã có: giá vốn bình quân đúng", async () => {
    const para = await makeProduct(stage, { code: "TH0005", name: "Thuốc D", units: [["Viên", 1, 2000]] });
    await makeBatch(stage, { product: para, batchNumber: "GOP", quantity: 100, unitCost: 1000, expiryInDays: 400 });

    const drafts = await Promise.all([
      draftReceipt(stage, {
        lines: [
          {
            productId: para.id,
            unitId: para.units["Viên"]!,
            quantity: 100,
            unitCost: 2000,
            batchNumber: "GOP",
            expiryDate: dayKey(400),
          },
        ],
      }).expect(201),
      draftReceipt(stage, {
        lines: [
          {
            productId: para.id,
            unitId: para.units["Viên"]!,
            quantity: 100,
            unitCost: 4000,
            batchNumber: "GOP",
            expiryDate: dayKey(400),
          },
        ],
      }).expect(201),
    ]);

    const { results, waiters } = await coordinate(
      Prisma.sql`SELECT id FROM batches WHERE batch_number = 'GOP' FOR UPDATE`,
      "%update%batches%",
      [
        () => confirmReceipt(stage, drafts[0]!.body.data),
        () => confirmReceipt(stage, drafts[1]!.body.data),
      ],
    );

    expect(waiters).toBe(2);
    expect(statusesOf(results)).toEqual([200, 200]);
    // (100×1.000 + 100×2.000 + 100×4.000) / 300 = 2.333,3333
    const batch = await batchOf("GOP");
    expect(batch.quantityOnHand).toBe(300);
    expect(Number(batch.unitCost)).toBeCloseTo(700_000 / 300, 3);
    expect(await stockValue("GOP")).toBeCloseTo(700_000, 0);
  });

  it("hai phiếu nhập cùng tạo một lô chưa tồn tại: chỉ một lô, giá vốn đúng", async () => {
    const para = await makeProduct(stage, { code: "TH0006", name: "Thuốc E", units: [["Viên", 1, 2000]] });
    const drafts = await Promise.all([
      draftReceipt(stage, {
        lines: [
          {
            productId: para.id,
            unitId: para.units["Viên"]!,
            quantity: 100,
            unitCost: 1000,
            batchNumber: "MOI",
            expiryDate: dayKey(400),
          },
        ],
      }).expect(201),
      draftReceipt(stage, {
        lines: [
          {
            productId: para.id,
            unitId: para.units["Viên"]!,
            quantity: 100,
            unitCost: 3000,
            batchNumber: "MOI",
            expiryDate: dayKey(400),
          },
        ],
      }).expect(201),
    ]);

    const results = await Promise.allSettled([
      confirmReceipt(stage, drafts[0]!.body.data),
      confirmReceipt(stage, drafts[1]!.body.data),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);

    expect(await prisma.batch.count({ where: { batchNumber: "MOI" } })).toBe(1);
    const batch = await batchOf("MOI");
    expect(batch.quantityOnHand).toBe(200);
    expect(Number(batch.unitCost)).toBeCloseTo(2000, 3);
    expect(await stockValue("MOI")).toBeCloseTo(400_000, 0);
  });

  it("nhập hàng đồng thời với bán hàng: tồn và giá trị tồn vẫn khớp", async () => {
    const para = await makeProduct(stage, { code: "TH0007", name: "Thuốc F", units: [["Viên", 1, 2000]] });
    await makeBatch(stage, { product: para, batchNumber: "VUA", quantity: 100, unitCost: 1000, expiryInDays: 400 });
    const pending = await draftReceipt(stage, {
      lines: [
        {
          productId: para.id,
          unitId: para.units["Viên"]!,
          quantity: 100,
          unitCost: 3000,
          batchNumber: "VUA",
          expiryDate: dayKey(400),
        },
      ],
    }).expect(201);

    const { results, waiters } = await coordinate(
      Prisma.sql`SELECT id FROM batches WHERE batch_number = 'VUA' FOR UPDATE`,
      "%batches%",
      [
        () => confirmReceipt(stage, pending.body.data),
        () => sell(stage, { lines: [line(para, "Viên", 10)] }),
      ],
    );

    expect(waiters).toBe(2);
    expect(statusesOf(results).filter((status) => status === 200 || status === 201)).toHaveLength(2);

    const batch = await batchOf("VUA");
    expect(batch.quantityOnHand).toBe(190);
    const allocation = await prisma.invoiceAllocation.findFirstOrThrow();
    const soldValue = allocation.baseQuantity * Number(allocation.unitCost);
    // Tiền mua hàng = giá trị còn tồn + giá vốn đã bán.
    expect((await stockValue("VUA")) + soldValue).toBeCloseTo(100 * 1000 + 100 * 3000, 0);
  });
});

describe("Kiểm kê và công nợ khi hai người cùng thao tác", () => {
  it("hai người cùng chốt một đợt kiểm kê: chỉ một phiếu điều chỉnh", async () => {
    const para = await makeProduct(stage, { code: "TH0008", name: "Thuốc G", units: [["Viên", 1, 2000]] });
    await makeBatch(stage, { product: para, batchNumber: "KK", quantity: 100, unitCost: 1000, expiryInDays: 120 });

    const opened = await api()
      .post("/api/v1/stock-counts")
      .set(h(stage.pharmacist))
      .send({ scopeType: "ALL" })
      .expect(201);
    const countId = opened.body.data.count.id as string;
    await api()
      .patch(`/api/v1/stock-counts/${countId}/counts`)
      .set(h(stage.pharmacist))
      .send({ entries: [{ lineId: opened.body.data.lines[0].id, unitId: para.units["Viên"]!, quantity: 95 }] })
      .expect(200);

    const { results, waiters } = await coordinate(
      Prisma.sql`SELECT id FROM stock_counts WHERE id = ${countId}::uuid FOR UPDATE`,
      "%stock_counts%",
      [
        () => api().post(`/api/v1/stock-counts/${countId}/close`).set(h(stage.pharmacist)).send({}),
        () => api().post(`/api/v1/stock-counts/${countId}/close`).set(h(stage.admin)).send({}),
      ],
    );

    expect(waiters).toBe(2);
    expect(statusesOf(results).filter((status) => status === 200)).toHaveLength(1);
    expect(await prisma.stockAdjustment.count()).toBe(1);
  });

  it("lưu số đếm đồng thời với chốt đợt: số đếm không lọt vào sau khi đã chốt", async () => {
    const para = await makeProduct(stage, { code: "TH0009", name: "Thuốc H", units: [["Viên", 1, 2000]] });
    await makeBatch(stage, { product: para, batchNumber: "KK2", quantity: 100, unitCost: 1000, expiryInDays: 120 });

    const opened = await api()
      .post("/api/v1/stock-counts")
      .set(h(stage.pharmacist))
      .send({ scopeType: "ALL" })
      .expect(201);
    const countId = opened.body.data.count.id as string;
    const lineId = opened.body.data.lines[0].id as string;
    await api()
      .patch(`/api/v1/stock-counts/${countId}/counts`)
      .set(h(stage.pharmacist))
      .send({ entries: [{ lineId, unitId: para.units["Viên"]!, quantity: 95 }] })
      .expect(200);

    const { results, waiters } = await coordinate(
      Prisma.sql`SELECT id FROM stock_counts WHERE id = ${countId}::uuid FOR UPDATE`,
      "%stock_counts%",
      [
        () => api().post(`/api/v1/stock-counts/${countId}/close`).set(h(stage.pharmacist)).send({}),
        () =>
          api()
            .patch(`/api/v1/stock-counts/${countId}/counts`)
            .set(h(stage.admin))
            .send({ entries: [{ lineId, unitId: para.units["Viên"]!, quantity: 50 }] }),
      ],
    );

    expect(waiters).toBe(2);
    const count = await prisma.stockCount.findUniqueOrThrow({ where: { id: countId } });
    const savedLine = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    if (count.status === "CLOSED") {
      // Chốt thắng: số đếm sau đó bị từ chối, phiếu điều chỉnh theo số 95.
      expect(savedLine.countedBaseQuantity).toBe(95);
      expect(statusesOf(results)[1]).toBe(409);
    } else {
      expect(savedLine.countedBaseQuantity).toBe(50);
    }
  });

  it("hai lần thanh toán cùng một khoản công nợ: không trả vượt", async () => {
    const para = await makeProduct(stage, { code: "TH0010", name: "Thuốc I", units: [["Viên", 1, 2000]] });
    const receipt = await draftReceipt(stage, {
      lines: [
        {
          productId: para.id,
          unitId: para.units["Viên"]!,
          quantity: 100,
          unitCost: 1000,
          batchNumber: "NO1",
          expiryDate: dayKey(300),
        },
      ],
    }).expect(201);
    await confirmReceipt(stage, receipt.body.data).expect(200);
    const receiptId = receipt.body.data.id as string;

    const pay = () =>
      api()
        .post("/api/v1/supplier-payments")
        .set(h())
        .send({
          supplierId: stage.supplierId,
          method: "CASH",
          allocations: [{ goodsReceiptId: receiptId, amount: 100_000 }],
        });

    const { results, waiters } = await coordinate(
      Prisma.sql`SELECT id FROM goods_receipts WHERE id = ${receiptId}::uuid FOR UPDATE`,
      "%goods_receipts%",
      [pay, pay],
    );

    expect(waiters).toBe(2);
    expect(statusesOf(results).filter((status) => status === 201)).toHaveLength(1);
    const paid = await prisma.supplierPaymentAllocation.aggregate({ _sum: { amount: true } });
    expect(Number(paid._sum.amount ?? 0n)).toBe(100_000);
  });

  it("thanh toán đồng thời với trả hàng trừ công nợ: tổng giảm nợ không vượt số nợ", async () => {
    const para = await makeProduct(stage, { code: "TH0011", name: "Thuốc K", units: [["Viên", 1, 2000]] });
    const receipt = await draftReceipt(stage, {
      lines: [
        {
          productId: para.id,
          unitId: para.units["Viên"]!,
          quantity: 100,
          unitCost: 1000,
          batchNumber: "NO2",
          expiryDate: dayKey(300),
        },
      ],
    }).expect(201);
    await confirmReceipt(stage, receipt.body.data).expect(200);
    const receiptId = receipt.body.data.id as string;
    const batch = await batchOf("NO2");

    const supplierReturn = await api()
      .post("/api/v1/supplier-returns")
      .set(h(stage.pharmacist))
      .send({
        supplierId: stage.supplierId,
        reason: "Hàng cận hạn, nhà cung cấp nhận lại",
        settlement: "DEDUCT_DEBT",
        lines: [{ batchId: batch.id, unitId: para.units["Viên"]!, quantity: 40 }],
      })
      .expect(201);

    const { results, waiters } = await coordinate(
      Prisma.sql`SELECT id FROM goods_receipts WHERE id = ${receiptId}::uuid FOR UPDATE`,
      "%goods_receipts%",
      [
        () =>
          api()
            .post("/api/v1/supplier-payments")
            .set(h())
            .send({
              supplierId: stage.supplierId,
              method: "CASH",
              allocations: [{ goodsReceiptId: receiptId, amount: 100_000 }],
            }),
        () =>
          api()
            .post(`/api/v1/supplier-returns/${supplierReturn.body.data.id}/confirm`)
            .set({ ...h(stage.pharmacist), ...idem() })
            .send({}),
      ],
    );

    expect(waiters).toBe(2);
    // Nợ gốc 100.000. Trả tiền 100.000 và trừ nợ 40.000 không thể cùng ghi
    // nhận: tổng khoản giảm nợ không bao giờ vượt số đã nợ.
    const paid = Number(
      (await prisma.supplierPaymentAllocation.aggregate({ _sum: { amount: true } }))._sum.amount ?? 0n,
    );
    const credited = await prisma.supplierReturn.findFirstOrThrow({
      where: { id: supplierReturn.body.data.id },
    });
    const creditValue = credited.status === "CONFIRMED" ? 40 * 1000 : 0;
    expect(paid + creditValue).toBeLessThanOrEqual(100_000);
    expect(statusesOf(results).filter((status) => status >= 200 && status < 300)).toHaveLength(1);
    expect(statusesOf(results).some((status) => status >= 500)).toBe(false);

    // Hàng chỉ rời kho khi phiếu trả thật sự được xác nhận.
    expect((await batchOf("NO2")).quantityOnHand).toBe(credited.status === "CONFIRMED" ? 60 : 100);
  });
});
