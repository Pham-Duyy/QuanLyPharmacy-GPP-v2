import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  useTestRole,
  type Fixture,
} from "../../test/helpers.js";

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let categoryId: string;
let supplierId: string;

type Product = { id: string; unitId: string };

const h = (token = adminToken) => authHeaders(token, fixture.storeId);
const idem = () => ({ "Idempotency-Key": randomUUID() });
const vnToday = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
const thisMonth = () => vnToday().slice(0, 7);
function inDays(days: number): string {
  const date = new Date(`${vnToday()}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
/** Tháng cách tháng này `offset` tháng, dạng YYYY-MM. */
function monthOf(offset: number): string {
  const [year, month] = thisMonth().split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1 + offset, 1)).toISOString().slice(0, 7);
}

async function makeProduct(code: string, name: string, price: number, unit = "Viên") {
  const product = await prisma.product.create({
    data: {
      code,
      name,
      productType: "DRUG",
      drugClass: "OTC",
      categoryId,
      units: { create: { name: unit, conversionToBase: 1, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  const unitId = product.units[0]!.id;
  // VAT 0% để doanh thu khớp thẳng đơn giá × số lượng.
  await prisma.productPrice.create({
    data: {
      productUnitId: unitId,
      salePrice: BigInt(price),
      vatRatePercent: 0,
      effectiveFrom: new Date(Date.now() - 86_400_000),
    },
  });
  return { id: product.id, unitId };
}

async function receive(
  lines: Array<{ product: Product; quantity: number; unitCost: number }>,
  extra: Record<string, unknown> = {},
) {
  const receipt = await api()
    .post("/api/v1/goods-receipts")
    .set({ ...h(pharmacistToken), ...idem() })
    .send({
      supplierId,
      ...extra,
      lines: lines.map((line) => ({
        productId: line.product.id,
        unitId: line.product.unitId,
        quantity: line.quantity,
        unitCost: line.unitCost,
        batchNumber: `L${randomUUID().slice(0, 8)}`,
        expiryDate: inDays(400),
      })),
    })
    .expect(201);
  await api()
    .post(`/api/v1/goods-receipts/${receipt.body.data.id}/confirm`)
    .set({ ...h(pharmacistToken), ...idem() })
    .send({
      lines: receipt.body.data.lines.map((line: { id: string }) => ({
        lineId: line.id,
        passed: true,
      })),
    })
    .expect(200);
  return receipt.body.data as { id: string };
}

async function sell(product: Product, quantity: number) {
  const invoice = await api()
    .post("/api/v1/invoices")
    .set({ ...h(pharmacistToken), ...idem() })
    .send({ lines: [{ productId: product.id, unitId: product.unitId, quantity }] })
    .expect(201);
  return invoice.body.data as { id: string; lines: Array<{ id: string }> };
}

const monthly = (month = thisMonth(), token = adminToken) =>
  api().get("/api/v1/reports/monthly").query({ month }).set(h(token));

const byCode = <T extends { code: string }>(rows: T[], code: string) =>
  rows.find((row) => row.code === code);

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [adminToken, pharmacistToken] = await Promise.all([
    login("admin").then((item) => item.token),
    login("duocsi").then((item) => item.token),
  ]);
  categoryId = (await prisma.category.create({ data: { name: "Thuốc giảm đau" } })).id;
  supplierId = (await prisma.supplier.create({ data: { name: "Công ty Dược Minh Tâm" } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Tổng kết tháng — nhập hàng", () => {
  it("tiền nhập từng thuốc gồm cả chiết khấu, VAT và cộng đúng số phải trả NCC", async () => {
    const para = await makeProduct("TH0001", "Paracetamol 500mg", 2000);
    const siro = await makeProduct("TH0002", "Siro ho Prospan", 50000, "Chai");
    // Tiền hàng 100.000 + 300.000, chiết khấu 20.000, VAT 30.000 → phải trả 410.000.
    await receive(
      [
        { product: para, quantity: 100, unitCost: 1000 },
        { product: siro, quantity: 10, unitCost: 30000 },
      ],
      { discountAmount: 20000, vatAmount: 30000 },
    );
    await receive([{ product: para, quantity: 50, unitCost: 1000 }]);
    // Tồn đầu kỳ không phải hàng mua trong tháng.
    await api()
      .post("/api/v1/inventory/opening-balances")
      .set({ ...h(), ...idem() })
      .send({
        lines: [
          {
            productId: siro.id,
            unitId: siro.unitId,
            quantity: 5,
            batchNumber: "TONDAU",
            expiryDate: inDays(300),
            unitCost: 30000,
          },
        ],
      })
      .expect(201);

    const data = (await monthly().expect(200)).body.data;
    expect(data).toMatchObject({ month: thisMonth(), partial: true, to: vnToday() });
    expect(data.summary.purchases).toEqual({
      receipts: 2,
      products: 2,
      goodsAmount: 450000,
      discountAmount: 20000,
      vatAmount: 30000,
      totalCost: 460000,
      supplierReturnValue: 0,
    });
    // Xếp theo tiền nhập: siro 307.500 (3/4 của 410.000), para 102.500 + 50.000.
    expect(data.purchases.map((row: { code: string }) => row.code)).toEqual(["TH0002", "TH0001"]);
    expect(byCode(data.purchases, "TH0002")).toMatchObject({
      quantity: 10,
      unit: "Chai",
      amount: 307500,
      receipts: 1,
      suppliers: ["Công ty Dược Minh Tâm"],
    });
    expect(byCode(data.purchases, "TH0001")).toMatchObject({
      quantity: 150,
      amount: 152500,
      receipts: 2,
    });

    // Bảng nhập – xuất – tồn tách tồn đầu kỳ vào "nhập khác".
    expect(byCode(data.movements, "TH0002")).toMatchObject({
      opening: 0,
      received: 10,
      otherIn: 5,
      sold: 0,
      otherOut: 0,
      closing: 15,
    });
  });
});

describe("Tổng kết tháng — bán ra và hàng đứng yên", () => {
  it("xếp hạng theo doanh thu, trừ hàng khách trả và khớp Báo cáo kinh doanh", async () => {
    const para = await makeProduct("TH0001", "Paracetamol 500mg", 2000);
    const siro = await makeProduct("TH0002", "Siro ho Prospan", 50000, "Chai");
    const vita = await makeProduct("TH0003", "Vitamin C 500mg", 1000);
    await receive([
      { product: para, quantity: 100, unitCost: 1000 },
      { product: siro, quantity: 10, unitCost: 30000 },
      { product: vita, quantity: 20, unitCost: 500 },
    ]);

    const first = await sell(para, 30);
    await sell(para, 10);
    await sell(siro, 1);
    await api()
      .post(`/api/v1/invoices/${first.id}/returns`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({
        disposition: "RESTOCK",
        lines: [{ invoiceLineId: first.lines[0]!.id, unitId: para.unitId, quantity: 5 }],
      })
      .expect(201);

    const data = (await monthly().expect(200)).body.data;
    expect(data.sales.map((row: { code: string }) => row.code)).toEqual(["TH0001", "TH0002"]);
    expect(data.sales[0]).toMatchObject({
      name: "Paracetamol 500mg",
      unit: "Viên",
      quantity: 35,
      revenue: 70000,
      grossProfit: 35000,
      invoices: 2,
      share: 58.3,
    });
    expect(data.sales[1]).toMatchObject({ quantity: 1, revenue: 50000, grossProfit: 20000 });

    // Cùng kỳ thì cùng số với trang Báo cáo kinh doanh.
    const business = (
      await api()
        .get("/api/v1/reports/summary")
        .query({ from: `${thisMonth()}-01`, to: inDays(1) })
        .set(h())
        .expect(200)
    ).body.data.kpis;
    expect(data.summary.sales).toEqual({
      netRevenue: business.netRevenue,
      invoiceCount: business.invoiceCount,
      products: 2,
      grossProfit: business.grossProfit,
      costExact: true,
    });
    expect(business.netRevenue).toBe(120000);

    // Vitamin C có hàng mà cả tháng chưa bán được cái nào.
    expect(data.idle).toHaveLength(1);
    expect(data.idle[0]).toMatchObject({
      code: "TH0003",
      stock: 20,
      value: 10000,
      lastSoldDate: null,
      lastReceivedDate: vnToday(),
      daysIdle: 0,
      nearestExpiry: inDays(400),
    });
    expect(data.summary.idle).toEqual({ products: 1, value: 10000, withoutCost: 0 });

    // Sổ kho: bán ra 40 − trả về 5; tồn cuối khớp tồn lô hiện tại.
    expect(byCode(data.movements, "TH0001")).toMatchObject({
      opening: 0,
      received: 100,
      sold: 35,
      closing: 65,
    });
    const onHand = await prisma.batch.aggregate({
      where: { productId: para.id },
      _sum: { quantityOnHand: true },
    });
    expect(onHand._sum.quantityOnHand).toBe(65);
  });

  it("tháng trước tính theo sổ kho tới cuối tháng đó", async () => {
    const para = await makeProduct("TH0001", "Paracetamol 500mg", 2000);
    const receipt = await receive([{ product: para, quantity: 100, unitCost: 1000 }]);
    await sell(para, 10);

    // Dời phiếu nhập về ngày 15 tháng trước, 10 giờ sáng giờ Việt Nam.
    const previous = monthOf(-1);
    const receivedAt = new Date(`${previous}-15T03:00:00.000Z`);
    await prisma.goodsReceipt.update({ where: { id: receipt.id }, data: { receivedAt } });
    await prisma.stockMovement.updateMany({
      where: { sourceId: receipt.id },
      data: { occurredAt: receivedAt },
    });

    const last = (await monthly(previous).expect(200)).body.data;
    expect(last.partial).toBe(false);
    expect(last.summary.purchases).toMatchObject({ receipts: 1, totalCost: 100000 });
    expect(byCode(last.movements, "TH0001")).toMatchObject({
      opening: 0,
      received: 100,
      sold: 0,
      closing: 100,
    });
    // Cả tháng trước chưa bán: đứng yên từ ngày có hàng tới cuối tháng.
    const lastDay = new Date(Date.UTC(Number(previous.slice(0, 4)), Number(previous.slice(5)), 0));
    expect(last.idle[0]).toMatchObject({
      stock: 100,
      lastSoldDate: null,
      idleSince: `${previous}-15`,
      daysIdle: lastDay.getUTCDate() - 15,
    });

    const current = (await monthly().expect(200)).body.data;
    expect(current.summary.purchases.receipts).toBe(0);
    expect(byCode(current.movements, "TH0001")).toMatchObject({
      opening: 100,
      received: 0,
      sold: 10,
      closing: 90,
    });
    expect(current.idle).toEqual([]);
  });
});

describe("Tổng kết tháng — quyền và dữ liệu", () => {
  it("không có quyền xem giá vốn thì ẩn tiền nhập, lãi gộp và giá trị tồn", async () => {
    const para = await makeProduct("TH0001", "Paracetamol 500mg", 2000);
    const vita = await makeProduct("TH0003", "Vitamin C 500mg", 1000);
    await receive([
      { product: para, quantity: 10, unitCost: 1000 },
      { product: vita, quantity: 10, unitCost: 500 },
    ]);
    await sell(para, 2);

    await useTestRole(fixture.salesId, "auditor", fixture.storeId, ["stock.cost.read"]);
    const token = (await login("banhang")).token;
    const data = (await monthly(thisMonth(), token).expect(200)).body.data;
    expect(data.showCost).toBe(false);
    expect(data.summary.purchases).toMatchObject({
      receipts: 1,
      totalCost: null,
      goodsAmount: null,
    });
    expect(data.summary.sales).toMatchObject({ netRevenue: 4000, grossProfit: null });
    expect(data.summary.idle).toMatchObject({ products: 1, value: null });
    expect(data.purchases[0].amount).toBeNull();
    expect(data.sales[0].grossProfit).toBeNull();
    expect(data.idle[0].value).toBeNull();
  });

  it("chặn người không có quyền báo cáo và tháng sai", async () => {
    await monthly(thisMonth(), pharmacistToken).expect(403);
    await monthly("2026-13").expect(422);
    await monthly("thang-9").expect(422);
    const future = await monthly(monthOf(1)).expect(422);
    expect(future.body.error.message).toContain("chưa tới");
  });
});

describe("Tổng kết tháng — xuất Excel", () => {
  it("một tệp gồm tổng quan, nhập hàng, xếp hạng bán, hàng đứng yên và nhập – xuất – tồn", async () => {
    const para = await makeProduct("TH0001", "Paracetamol 500mg", 2000);
    await receive([{ product: para, quantity: 10, unitCost: 1000 }]);
    await sell(para, 4);

    const response = await api()
      .get("/api/v1/excel/exports/period-summary")
      .query({ from: `${thisMonth()}-01`, to: vnToday() })
      .set(h())
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as ArrayBuffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Tổng quan",
      "Nhập hàng",
      "Xếp hạng bán",
      "Chưa bán - tồn lâu",
      "Nhập - xuất - tồn",
      "Hướng dẫn",
    ]);
    const overview = workbook.getWorksheet("Tổng quan")!;
    const values = new Map<string, unknown>();
    overview.eachRow((row) => values.set(String(row.getCell(1).value), row.getCell(2).value));
    expect(values.get("Tổng tiền nhập (phải trả NCC)")).toBe(10000);
    expect(values.get("Doanh thu thuần")).toBe(8000);
    const ranking = workbook.getWorksheet("Xếp hạng bán")!;
    expect(ranking.getRow(2).getCell(3).value).toBe("Paracetamol 500mg");
  });
});
