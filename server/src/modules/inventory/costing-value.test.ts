import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../../test/helpers.js";

/**
 * Bảo toàn **số lượng và giá trị** tồn kho: mỗi lần hàng vào hay ra kho, giá
 * trị tồn (tồn × giá vốn bình quân) phải khớp với dòng tiền đã bỏ ra và giá
 * vốn đã ghi nhận khi bán.
 */

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let productId: string;
let unitId: string;
let supplierId: string;

const h = (token = adminToken) => authHeaders(token, fixture.storeId);
const idem = () => ({ "Idempotency-Key": randomUUID() });

function dayKey(days = 0): string {
  const vnToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  const date = new Date(`${vnToday}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Lập phiếu nhập nháp, trả về phiếu để xác nhận sau. */
async function draft(options: { quantity: number; unitCost: number; batchNumber: string }) {
  const created = await api()
    .post("/api/v1/goods-receipts")
    .set({ ...h(pharmacistToken), ...idem() })
    .send({
      supplierId,
      lines: [
        {
          productId,
          unitId,
          quantity: options.quantity,
          unitCost: options.unitCost,
          batchNumber: options.batchNumber,
          expiryDate: dayKey(400),
        },
      ],
    })
    .expect(201);
  return created.body.data as { id: string; lines: Array<{ id: string }> };
}

const confirm = (receipt: { id: string; lines: Array<{ id: string }> }) =>
  api()
    .post(`/api/v1/goods-receipts/${receipt.id}/confirm`)
    .set({ ...h(pharmacistToken), ...idem() })
    .send({ lines: receipt.lines.map((line) => ({ lineId: line.id, passed: true })) });

async function receive(options: { quantity: number; unitCost: number; batchNumber: string }) {
  await confirm(await draft(options)).expect(200);
}

const sell = (quantity: number) =>
  api()
    .post("/api/v1/invoices")
    .set({ ...h(), ...idem() })
    .send({ lines: [{ productId, unitId, quantity }] });

const batchOf = (batchNumber: string) =>
  prisma.batch.findFirstOrThrow({ where: { batchNumber } });

/** Giá trị tồn của một lô = tồn × giá vốn bình quân. */
async function stockValue(batchNumber: string): Promise<number> {
  const batch = await batchOf(batchNumber);
  return batch.quantityOnHand * Number(batch.unitCost ?? 0);
}

const returnLines = (invoice: { id: string; lines: Array<{ id: string }> }, quantity: number, disposition = "RESTOCK") =>
  api()
    .post(`/api/v1/invoices/${invoice.id}/returns`)
    .set({ ...h(pharmacistToken), ...idem() })
    .send({
      disposition,
      refundMethod: "CASH",
      ...(disposition === "DISPOSE" ? { reason: "Hàng hỏng, không bán lại" } : {}),
      lines: [{ invoiceLineId: invoice.lines[0]!.id, unitId, quantity }],
    });

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [adminToken, pharmacistToken] = await Promise.all([
    login("admin").then((item) => item.token),
    login("duocsi").then((item) => item.token),
  ]);
  const categoryId = (await prisma.category.create({ data: { name: "Hàng nhà thuốc" } })).id;
  const product = await prisma.product.create({
    data: {
      code: "TH0001",
      name: "Paracetamol 500mg",
      productType: "DRUG",
      drugClass: "OTC",
      categoryId,
      units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  productId = product.id;
  unitId = product.units[0]!.id;
  await prisma.productPrice.create({
    data: {
      productUnitId: unitId,
      salePrice: 3000n,
      vatRatePercent: 5,
      effectiveFrom: new Date(`${dayKey(-2)}T00:00:00.000Z`),
    },
  });
  supplierId = (await prisma.supplier.create({ data: { name: "Dược Minh Tâm" } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Nhập hàng đồng thời", () => {
  it("hai phiếu cùng tạo một lô chưa tồn tại: một lô duy nhất, giá vốn bình quân đúng", async () => {
    const first = await draft({ quantity: 100, unitCost: 1000, batchNumber: "NEW" });
    const second = await draft({ quantity: 100, unitCost: 3000, batchNumber: "NEW" });

    const results = await Promise.all([confirm(first), confirm(second)]);
    expect(results.map((item) => item.status)).toEqual([200, 200]);

    expect(await prisma.batch.count({ where: { batchNumber: "NEW" } })).toBe(1);
    const batch = await batchOf("NEW");
    expect(batch.quantityOnHand).toBe(200);
    expect(Number(batch.unitCost)).toBeCloseTo((100 * 1000 + 100 * 3000) / 200, 3);
    expect(await stockValue("NEW")).toBeCloseTo(400_000, 0);
  });

  it("nhập thêm trong lúc đang bán: tồn và giá trị tồn vẫn khớp", async () => {
    await receive({ quantity: 100, unitCost: 1000, batchNumber: "MIX" });
    const pending = await draft({ quantity: 100, unitCost: 3000, batchNumber: "MIX" });

    // Bán và kiểm nhập chạy song song trên cùng một lô.
    const [saleResult, confirmResult] = await Promise.all([sell(10), confirm(pending)]);
    expect(saleResult.status).toBe(201);
    expect(confirmResult.status).toBe(200);

    const batch = await batchOf("MIX");
    expect(batch.quantityOnHand).toBe(190);

    // Giá vốn đã ghi nhận cho 10 viên đã bán.
    const allocation = await prisma.invoiceAllocation.findFirstOrThrow();
    const soldValue = allocation.baseQuantity * Number(allocation.unitCost);
    // Tổng tiền đã bỏ ra mua hàng = giá trị còn tồn + giá vốn đã bán.
    expect((await stockValue("MIX")) + soldValue).toBeCloseTo(100 * 1000 + 100 * 3000, 0);
  });
});

describe("Hoàn hàng về kho", () => {
  it("trả từng phần nhiều lần: giá trị tồn luôn khớp tiền đã bỏ ra", async () => {
    await receive({ quantity: 100, unitCost: 1000, batchNumber: "PART" });
    const sale = (await sell(10).expect(201)).body.data;
    await receive({ quantity: 100, unitCost: 3000, batchNumber: "PART" });

    await returnLines(sale, 2).expect(201);
    await returnLines(sale, 3).expect(201);

    const batch = await batchOf("PART");
    expect(batch.quantityOnHand).toBe(195);

    // 5 viên còn nằm ngoài kho, giá vốn 1.000 mỗi viên.
    expect(await stockValue("PART")).toBeCloseTo(100 * 1000 + 100 * 3000 - 5 * 1000, 0);
    expect(Number(batch.unitCost)).toBeCloseTo((90 * 1000 + 100 * 3000 + 5 * 1000) / 195, 3);
  });

  it("hủy hóa đơn sau khi đã nhập thêm: hoàn đúng giá vốn lúc bán", async () => {
    await receive({ quantity: 100, unitCost: 1000, batchNumber: "VOID" });
    const sale = (await sell(10).expect(201)).body.data;
    await receive({ quantity: 100, unitCost: 3000, batchNumber: "VOID" });

    await api()
      .post(`/api/v1/invoices/${sale.id}/void`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({ reason: "Khách đổi ý ngay tại quầy" })
      .expect(200);

    const batch = await batchOf("VOID");
    expect(batch.quantityOnHand).toBe(200);
    // Hàng về đủ thì giá trị tồn bằng đúng tổng tiền đã bỏ ra mua.
    expect(await stockValue("VOID")).toBeCloseTo(100 * 1000 + 100 * 3000, 0);
    expect(Number(batch.unitCost)).toBeCloseTo(400_000 / 200, 3);
  });

  it("tồn trước khi hoàn bằng 0: lô nhận lại đúng giá vốn của lần bán", async () => {
    await receive({ quantity: 10, unitCost: 1200, batchNumber: "ZERO" });
    const sale = (await sell(10).expect(201)).body.data;
    expect((await batchOf("ZERO")).quantityOnHand).toBe(0);

    await returnLines(sale, 4).expect(201);

    const batch = await batchOf("ZERO");
    expect(batch.quantityOnHand).toBe(4);
    expect(Number(batch.unitCost)).toBeCloseTo(1200, 4);
    expect(await stockValue("ZERO")).toBeCloseTo(4 * 1200, 0);
  });

  it("hàng trả để tiêu hủy không làm đổi giá trị hàng còn tồn", async () => {
    await receive({ quantity: 100, unitCost: 1000, batchNumber: "DISP" });
    const sale = (await sell(10).expect(201)).body.data;
    await receive({ quantity: 100, unitCost: 3000, batchNumber: "DISP" });

    const before = await batchOf("DISP");
    await returnLines(sale, 4, "DISPOSE").expect(201);

    const after = await batchOf("DISP");
    // Vào rồi ra ngay: tồn và giá vốn bình quân của hàng còn lại không đổi.
    expect(after.quantityOnHand).toBe(before.quantityOnHand);
    expect(Number(after.unitCost)).toBeCloseTo(Number(before.unitCost), 4);
  });

  it("giá vốn không xác định thì hoàn hàng giữ nguyên giá vốn bình quân của lô", async () => {
    await receive({ quantity: 100, unitCost: 1000, batchNumber: "UNK" });
    const sale = (await sell(10).expect(201)).body.data;
    // Dữ liệu cũ: dòng phân bổ không có giá vốn chụp sẵn.
    await prisma.invoiceAllocation.updateMany({ data: { unitCost: null, unitCostSource: "UNKNOWN" } });
    await receive({ quantity: 100, unitCost: 3000, batchNumber: "UNK" });

    const before = await batchOf("UNK");
    await returnLines(sale, 4).expect(201);

    const after = await batchOf("UNK");
    expect(after.quantityOnHand).toBe(before.quantityOnHand + 4);
    // Không suy diễn giá vốn: giữ nguyên bình quân đang có.
    expect(Number(after.unitCost)).toBeCloseTo(Number(before.unitCost), 4);
  });
});

describe("Báo cáo với giá vốn cũ và giá vốn không xác định", () => {
  const report = async () =>
    (
      await api()
        .get(`/api/v1/reports/summary?from=${dayKey(-1)}&to=${dayKey(1)}`)
        .set(h())
        .expect(200)
    ).body.data;

  it("dòng phân bổ ước tính được đánh dấu và lãi gộp không đổi khi nhập thêm", async () => {
    await receive({ quantity: 100, unitCost: 1000, batchNumber: "EST" });
    await sell(10).expect(201);
    // Giả lập dữ liệu đã qua bước chuyển đổi của migration 20260926140000.
    await prisma.invoiceAllocation.updateMany({ data: { unitCostSource: "ESTIMATED" } });

    const before = await report();
    expect(before.costQuality).toMatchObject({ totalLines: 1, estimatedLines: 1, unknownLines: 0, exact: false });
    expect(Math.round(before.kpis.grossProfit)).toBe(20_000);

    await receive({ quantity: 100, unitCost: 3000, batchNumber: "EST" });

    const after = await report();
    // Giá vốn đã đóng băng: nhập thêm không làm đổi lãi gộp kỳ cũ.
    expect(after.kpis.grossProfit).toBeCloseTo(before.kpis.grossProfit, 3);
    expect(after.costQuality.exact).toBe(false);
  });

  it("hóa đơn không xác định được giá vốn thì báo cáo nói rõ, không mượn giá vốn lô", async () => {
    await receive({ quantity: 100, unitCost: 1000, batchNumber: "NUL" });
    await sell(10).expect(201);
    await prisma.invoiceAllocation.updateMany({ data: { unitCost: null, unitCostSource: "UNKNOWN" } });

    const data = await report();
    expect(data.costQuality).toMatchObject({ totalLines: 1, unknownLines: 1, exact: false });
    // Không có giá vốn thì tính 0, và phải nói rõ qua costQuality thay vì lấy
    // giá vốn hiện tại của lô.
    expect(Math.round(data.kpis.grossProfit)).toBe(30_000);

    await receive({ quantity: 100, unitCost: 3000, batchNumber: "NUL" });
    expect(Math.round((await report()).kpis.grossProfit)).toBe(30_000);
  });

  it("giá vốn chụp đúng lúc xuất thì báo cáo là số chính xác", async () => {
    await receive({ quantity: 100, unitCost: 1000, batchNumber: "OK" });
    await sell(10).expect(201);

    const data = await report();
    expect(data.costQuality).toMatchObject({ totalLines: 1, actualLines: 1, exact: true });
    expect(Math.round(data.kpis.grossProfit)).toBe(20_000);
  });
});
