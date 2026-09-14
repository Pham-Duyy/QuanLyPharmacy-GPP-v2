import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { hashPassword } from "../../lib/password.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  TEST_PASSWORD,
  type Fixture,
} from "../../test/helpers.js";

let fixture: Fixture;
let adminToken: string;
let categoryId: string;
let productId: string;
let unitId: string;

function idem(): Record<string, string> {
  return { "Idempotency-Key": randomUUID() };
}

/** Ngày theo giờ Việt Nam, cùng cách quy đổi với `businessDateNow` ở service. */
function vietnamBusinessDate(days = 0): Date {
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(
    new Date(),
  );
  const date = new Date(`${todayKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function dayOffset(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return new Date(date.toISOString().slice(0, 10));
}

async function makeBatch(batchNumber: string, quantity: number, expiryInDays = 365) {
  return prisma.batch.create({
    data: {
      storeId: fixture.storeId,
      productId,
      batchNumber,
      expiryDate: dayOffset(expiryInDays),
      quantityOnHand: quantity,
      status: "AVAILABLE",
    },
  });
}

function sell(token: string, quantity: number) {
  return api()
    .post("/api/v1/invoices")
    .set({ ...authHeaders(token, fixture.storeId), ...idem() })
    .send({ lines: [{ productId, unitId, quantity }] });
}

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;

  categoryId = (await prisma.category.create({ data: { name: "Thuốc giảm đau" } })).id;
  const product = await prisma.product.create({
    data: {
      code: "TH0001",
      name: "Paracetamol 500mg",
      productType: "DRUG",
      drugClass: "OTC",
      categoryId,
      minStockBaseQuantity: 1000,
      units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  productId = product.id;
  unitId = product.units[0]!.id;
  await prisma.productPrice.create({
    data: {
      productUnitId: unitId,
      salePrice: 2000n,
      vatRatePercent: 5,
      effectiveFrom: dayOffset(-1),
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Dashboard", () => {
  it("tổng hợp đúng doanh thu, số hóa đơn hôm nay và so sánh với hôm qua", async () => {
    await makeBatch("L1", 1000);
    const first = await sell(adminToken, 10).expect(201);
    const second = await sell(adminToken, 5).expect(201);
    const expectedRevenue =
      Number(first.body.data.totalAmount) + Number(second.body.data.totalAmount);

    // Một hóa đơn "hôm qua" để có mốc so sánh — API luôn ghi businessDate là
    // hôm nay, nên dịch lại trực tiếp trong CSDL để mô phỏng dữ liệu cũ.
    const yesterdayInvoice = await sell(adminToken, 20).expect(201);
    await prisma.invoice.update({
      where: { id: yesterdayInvoice.body.data.id },
      data: { businessDate: vietnamBusinessDate(-1), soldAt: vietnamBusinessDate(-1) },
    });

    const response = await api()
      .get("/api/v1/dashboard")
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    expect(response.body.data.sales.today.invoiceCount).toBe(2);
    expect(response.body.data.sales.today.revenue).toBe(expectedRevenue);
    expect(response.body.data.sales.today.revenueChangePercent).not.toBeNull();
    expect(response.body.data.permissions.sales).toBe(true);
  });

  it("liệt kê đúng lô sắp hết hạn, không lấy lô còn xa hạn", async () => {
    await makeBatch("NEAR", 50, 30);
    await makeBatch("FAR", 50, 400);

    const response = await api()
      .get("/api/v1/dashboard")
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    const batchNumbers = response.body.data.inventory.expiringBatches.map(
      (item: { batchNumber: string }) => item.batchNumber,
    );
    expect(batchNumbers).toContain("NEAR");
    expect(batchNumbers).not.toContain("FAR");
    expect(response.body.data.inventory.counts.expiring).toBe(1);
  });

  it("báo đúng sản phẩm dưới mức tồn tối thiểu", async () => {
    await makeBatch("LOW", 10); // dưới mức tối thiểu 1000

    const response = await api()
      .get("/api/v1/dashboard")
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    expect(response.body.data.inventory.counts.lowStock).toBe(1);
    expect(response.body.data.inventory.lowStockProducts[0]).toMatchObject({
      productId,
      stock: 10,
      minimumStock: 1000,
    });
    expect(
      response.body.data.notifications.some((item: { type: string }) => item.type === "LOW_STOCK"),
    ).toBe(true);
  });

  it("ẩn phần bán hàng khi không có quyền invoice.read", async () => {
    const warehouse = await prisma.user.create({
      data: {
        username: "khowh",
        passwordHash: await hashPassword(TEST_PASSWORD),
        fullName: "Nhân viên kho",
        defaultStoreId: fixture.storeId,
        mustChangePassword: false,
      },
    });
    const role = await prisma.role.findFirstOrThrow({ where: { code: "warehouse_staff" } });
    await prisma.userRole.create({
      data: { userId: warehouse.id, roleId: role.id, storeId: fixture.storeId },
    });

    const warehouseToken = (await login("khowh")).token;
    const response = await api()
      .get("/api/v1/dashboard")
      .set(authHeaders(warehouseToken, fixture.storeId))
      .expect(200);

    expect(response.body.data.permissions.sales).toBe(false);
    expect(response.body.data.sales.today.revenue).toBe(0);
    expect(response.body.data.permissions.inventory).toBe(true);
  });

  it("không tính dữ liệu của cửa hàng khác", async () => {
    await prisma.batch.create({
      data: {
        storeId: fixture.otherStoreId,
        productId,
        batchNumber: "OTHER",
        expiryDate: dayOffset(30),
        quantityOnHand: 5,
        status: "AVAILABLE",
      },
    });

    const response = await api()
      .get("/api/v1/dashboard")
      .set(authHeaders(adminToken, fixture.storeId))
      .expect(200);

    expect(response.body.data.inventory.counts.expiring).toBe(0);
  });
});
