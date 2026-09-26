import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db/prisma.js";
import { api, truncateAll } from "../test/helpers.js";
import {
  batchOf,
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

/** Nghiệm thu nghiệp vụ: kiểm kê và phiếu điều chỉnh tồn. */

let stage: Stage;
let para: MadeProduct;

const h = (token = stage.admin, storeId = stage.fixture.storeId) => headers(token, storeId);

const openCount = () =>
  api().post("/api/v1/stock-counts").set(h(stage.pharmacist)).send({ scopeType: "ALL" });

const saveCounts = (countId: string, entries: Array<Record<string, unknown>>) =>
  api().patch(`/api/v1/stock-counts/${countId}/counts`).set(h(stage.pharmacist)).send({ entries });

const closeCount = (countId: string, note?: string) =>
  api()
    .post(`/api/v1/stock-counts/${countId}/close`)
    .set(h(stage.pharmacist))
    .send(note ? { note } : {});

const approve = (adjustmentId: string, token = stage.admin) =>
  api()
    .post(`/api/v1/stock-adjustments/${adjustmentId}/approve`)
    .set({ ...h(token), ...idem() })
    .send({});

beforeEach(async () => {
  await truncateAll();
  stage = await setupStage();
  para = await makeProduct(stage, {
    code: "TH0001",
    name: "Paracetamol 500mg",
    units: [
      ["Viên", 1, 2000],
      ["Hộp", 100, 180_000],
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Kiểm kê", () => {
  it("đếm bằng hộp, chênh lệch tính theo đơn vị nhỏ nhất và chỉ sinh một phiếu điều chỉnh", async () => {
    await makeBatch(stage, { product: para, batchNumber: "KK-1", quantity: 500, unitCost: 1000, expiryInDays: 120 });

    const opened = await openCount().expect(201);
    const countId = opened.body.data.count.id as string;
    const lineId = opened.body.data.lines[0].id as string;

    // Đếm được 4 hộp = 400 viên, sổ sách 500 → thiếu 100 viên.
    await saveCounts(countId, [{ lineId, unitId: para.units["Hộp"]!, quantity: 4 }]).expect(200);
    const saved = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(saved.countedBaseQuantity).toBe(400);
    expect(saved.systemBaseQuantityAtCount).toBe(500);

    const closed = await closeCount(countId, "Kiểm kê cuối tháng").expect(200);
    expect(closed.body.data.differenceLines).toBe(1);
    expect(await prisma.stockAdjustment.count()).toBe(1);

    const adjustment = await prisma.stockAdjustment.findFirstOrThrow({ include: { lines: true } });
    expect(adjustment.status).toBe("DRAFT");
    expect(adjustment.lines[0]).toMatchObject({
      reasonCode: "COUNT_DIFFERENCE",
      countedQuantity: 4,
      systemBaseQuantityAtCount: 500,
    });
  });

  it("bán hàng xen giữa lúc đếm và lúc duyệt: áp chênh lệch, không ghi đè giao dịch bán", async () => {
    await makeBatch(stage, { product: para, batchNumber: "KK-2", quantity: 500, unitCost: 1000, expiryInDays: 120 });

    const opened = await openCount().expect(201);
    const countId = opened.body.data.count.id as string;
    const lineId = opened.body.data.lines[0].id as string;

    // Đếm được 490 viên trong khi sổ sách 500 → thiếu 10.
    await saveCounts(countId, [{ lineId, unitId: para.units["Viên"]!, quantity: 490 }]).expect(200);
    const closed = await closeCount(countId).expect(200);

    // Sau khi chốt nhưng trước khi duyệt, quầy bán thêm 20 viên.
    await sell(stage, { lines: [line(para, "Viên", 20)] }).expect(201);
    expect((await batchOf("KK-2")).quantityOnHand).toBe(480);

    await approve(closed.body.data.adjustmentId).expect(200);

    // Duyệt áp CHÊNH LỆCH −10, không gán tồn bằng 490: 480 − 10 = 470.
    expect((await batchOf("KK-2")).quantityOnHand).toBe(470);

    const ledger = await prisma.stockMovement.findMany({
      where: { productId: para.id },
      orderBy: { id: "asc" },
    });
    expect(ledger.map((item) => `${item.type}:${item.baseQuantity}`)).toEqual([
      "SALE:-20",
      "ADJUSTMENT:-10",
    ]);
    expect(ledger.at(-1)!.balanceAfter).toBe(470);
  });

  it("dòng chưa đếm không bị coi là đếm được 0", async () => {
    await makeBatch(stage, { product: para, batchNumber: "KK-3", quantity: 100, unitCost: 1000, expiryInDays: 120 });
    const other = await makeProduct(stage, {
      code: "TH0002",
      name: "Vitamin C 1000mg",
      productType: "SUPPLEMENT",
      drugClass: null,
      units: [["Viên", 1, 5000]],
    });
    await makeBatch(stage, { product: other, batchNumber: "KK-4", quantity: 80, unitCost: 2000, expiryInDays: 200 });

    const opened = await openCount().expect(201);
    const countId = opened.body.data.count.id as string;
    const lines = opened.body.data.lines as Array<{ id: string; batchNumber: string }>;
    const target = lines.find((item) => item.batchNumber === "KK-3")!;

    // Chỉ đếm một lô, lô còn lại bỏ trống.
    await saveCounts(countId, [{ lineId: target.id, unitId: para.units["Viên"]!, quantity: 95 }]).expect(200);
    const closed = await closeCount(countId).expect(200);

    const adjustment = await prisma.stockAdjustment.findFirstOrThrow({ include: { lines: true } });
    expect(adjustment.lines).toHaveLength(1);
    await approve(closed.body.data.adjustmentId).expect(200);

    expect((await batchOf("KK-3")).quantityOnHand).toBe(95);
    // Lô chưa đếm giữ nguyên tồn, không bị đưa về 0.
    expect((await batchOf("KK-4")).quantityOnHand).toBe(80);
  });

  it("người lập phiếu không tự duyệt được", async () => {
    await makeBatch(stage, { product: para, batchNumber: "KK-5", quantity: 100, unitCost: 1000, expiryInDays: 120 });
    const opened = await openCount().expect(201);
    const countId = opened.body.data.count.id as string;
    await saveCounts(countId, [
      { lineId: opened.body.data.lines[0].id, unitId: para.units["Viên"]!, quantity: 90 },
    ]).expect(200);
    const closed = await closeCount(countId).expect(200);

    // Dược sĩ vừa chốt kiểm kê cũng là người lập phiếu điều chỉnh.
    const self = await approve(closed.body.data.adjustmentId, stage.pharmacist).expect(422);
    expect(self.body.error.code).toBe("SELF_APPROVAL_NOT_ALLOWED");
    expect((await batchOf("KK-5")).quantityOnHand).toBe(100);

    await approve(closed.body.data.adjustmentId, stage.admin).expect(200);
    expect((await batchOf("KK-5")).quantityOnHand).toBe(90);
  });

  it("đợt đã chốt hoặc đã hủy thì không ghi thêm số đếm", async () => {
    await makeBatch(stage, { product: para, batchNumber: "KK-6", quantity: 100, unitCost: 1000, expiryInDays: 120 });
    const opened = await openCount().expect(201);
    const countId = opened.body.data.count.id as string;
    const lineId = opened.body.data.lines[0].id as string;
    await saveCounts(countId, [{ lineId, unitId: para.units["Viên"]!, quantity: 100 }]).expect(200);
    await closeCount(countId).expect(200);

    const late = await saveCounts(countId, [{ lineId, unitId: para.units["Viên"]!, quantity: 50 }]).expect(409);
    expect(late.body.error.message).toContain("đã chốt");
    expect((await prisma.stockCountLine.findUniqueOrThrow({ where: { id: lineId } })).countedBaseQuantity).toBe(100);

    // Đợt mới: hủy rồi thì cũng không ghi được nữa.
    const second = await openCount().expect(201);
    const secondId = second.body.data.count.id as string;
    await api()
      .post(`/api/v1/stock-counts/${secondId}/cancel`)
      .set(h(stage.pharmacist))
      .send({ reason: "Đếm lại từ đầu" })
      .expect(200);
    const afterCancel = await saveCounts(secondId, [
      { lineId: second.body.data.lines[0].id, unitId: para.units["Viên"]!, quantity: 10 },
    ]).expect(409);
    expect(afterCancel.body.error.message).toContain("hủy");
  });
});
