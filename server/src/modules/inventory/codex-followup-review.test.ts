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

describe("Independent follow-up review", () => {
  it("lost idempotency owner must roll back business writes", async () => {
    const { idempotencyStore, markIdempotentResource } = await import("../../lib/idempotency-context.js");
    const key = randomUUID();
    await prisma.idempotencyKey.create({ data: {
      key, userId: fixture.adminId, ownerToken: randomUUID(), method: "POST",
      path: "/review", requestHash: "review", status: "IN_PROGRESS", expiresAt: new Date(Date.now() + 60000),
    }});
    const transaction = idempotencyStore.run({ key, userId: fixture.adminId, ownerToken: randomUUID() }, () =>
      prisma.$transaction(async (tx) => {
        const saved = await tx.customer.create({ data: { fullName: "STALE_OWNER_WRITE" } });
        await markIdempotentResource(tx, "customer", saved.id);
      })
    );
    await expect(transaction).rejects.toThrow();
    expect(await prisma.customer.count({ where: { fullName: "STALE_OWNER_WRITE" } })).toBe(0);
  });

  it("unknown original cost on a prior-period sale must flag current-period return report", async () => {
    await receive({ quantity: 100, unitCost: 1000, batchNumber: "PREVIOUS" });
    const sale = (await sell(10).expect(201)).body.data;
    await prisma.invoice.update({ where: { id: sale.id }, data: { businessDate: new Date(`${dayKey(-2)}T00:00:00.000Z`) } });
    await prisma.invoiceAllocation.updateMany({ data: { unitCost: null, unitCostSource: "UNKNOWN" } });
    await returnLines(sale, 2).expect(201);
    const response = await api().get(`/api/v1/reports/summary?from=${dayKey()}&to=${dayKey(1)}`).set(h()).expect(200);
    expect(response.body.data.costQuality.exact).toBe(false);
  });
});
