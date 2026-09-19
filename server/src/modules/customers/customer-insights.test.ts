import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  type Fixture,
} from "../../test/helpers.js";

let fixture: Fixture;
let adminToken: string;
let salesToken: string;
let pharmacistToken: string;
let product: { id: string; unitId: string };

const idem = () => ({ "Idempotency-Key": randomUUID() });

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
  salesToken = (await login("banhang")).token;
  pharmacistToken = (await login("duocsi")).token;

  const category = await prisma.category.create({ data: { name: "Vitamin" } });
  const created = await prisma.product.create({
    data: {
      code: "TP0001",
      name: "Vitamin C",
      productType: "SUPPLEMENT",
      categoryId: category.id,
      units: { create: [{ name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true }] },
    },
    include: { units: true },
  });
  product = { id: created.id, unitId: created.units[0]!.id };
  await prisma.productPrice.create({
    data: {
      productUnitId: product.unitId,
      salePrice: 1000n,
      vatRatePercent: 5,
      effectiveFrom: new Date(Date.now() - 86_400_000),
    },
  });
  await prisma.batch.create({
    data: {
      storeId: fixture.storeId,
      productId: product.id,
      batchNumber: "VC1",
      expiryDate: new Date("2030-01-01"),
      quantityOnHand: 1000,
      status: "AVAILABLE",
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createCustomer(body: Record<string, unknown>): Promise<string> {
  const response = await api()
    .post("/api/v1/customers")
    .set(authHeaders(salesToken))
    .send(body)
    .expect(201);
  return response.body.data.id;
}

async function sell(customerId: string, quantity: number): Promise<string> {
  const response = await api()
    .post("/api/v1/invoices")
    .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
    .send({ customerId, lines: [{ productId: product.id, unitId: product.unitId, quantity }] })
    .expect(201);
  return response.body.data.id;
}

describe("Mã khách hàng, email, địa chỉ", () => {
  it("tự cấp mã KH tăng dần, lưu được email và địa chỉ", async () => {
    const first = await createCustomer({ fullName: "Khách A", phone: "0901000001" });
    const second = await createCustomer({
      fullName: "Khách B",
      email: "b@example.com",
      address: "12 Lê Lợi",
    });

    const a = await api()
      .get(`/api/v1/customers/${first}`)
      .set(authHeaders(salesToken))
      .expect(200);
    const b = await api()
      .get(`/api/v1/customers/${second}`)
      .set(authHeaders(salesToken))
      .expect(200);
    expect(a.body.data.code).toMatch(/^KH\d{5}$/);
    expect(Number(b.body.data.code.slice(2))).toBe(Number(a.body.data.code.slice(2)) + 1);
    expect(b.body.data).toMatchObject({ email: "b@example.com", address: "12 Lê Lợi" });
  });

  it("từ chối email sai định dạng", async () => {
    await api()
      .post("/api/v1/customers")
      .set(authHeaders(salesToken))
      .send({ fullName: "Khách C", email: "khong-phai-email" })
      .expect(422);
  });

  it("ẩn danh xóa cả email và địa chỉ, giữ mã khách", async () => {
    const id = await createCustomer({ fullName: "Khách D", email: "d@example.com", address: "Q1" });
    const code = (await prisma.customer.findUniqueOrThrow({ where: { id } })).code;
    await api()
      .post(`/api/v1/customers/${id}/anonymize`)
      .set(authHeaders(pharmacistToken))
      .send({ reason: "Khách yêu cầu" })
      .expect(200);
    const after = await prisma.customer.findUniqueOrThrow({ where: { id } });
    expect(after).toMatchObject({ email: null, address: null, code });
  });
});

describe("Thống kê mua hàng và nhóm khách", () => {
  it("tổng mua trừ tiền hoàn trả, số đơn, lần mua cuối và nhóm thân thiết", async () => {
    const loyal = await createCustomer({ fullName: "Khách thân thiết", phone: "0902000001" });
    const invoiceIds: string[] = [];
    for (let i = 0; i < 5; i++) invoiceIds.push(await sell(loyal, 10));

    // Trả 2 viên của hóa đơn đầu: tổng mua giảm 2.000.
    const invoice = (
      await api()
        .get(`/api/v1/invoices/${invoiceIds[0]}`)
        .set(authHeaders(adminToken, fixture.storeId))
        .expect(200)
    ).body.data;
    await api()
      .post(`/api/v1/invoices/${invoiceIds[0]}/returns`)
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({
        disposition: "RESTOCK",
        lines: [
          {
            invoiceLineId: invoice.lines[0].id,
            allocationId: invoice.lines[0].allocations[0].id,
            unitId: product.unitId,
            quantity: 2,
          },
        ],
      })
      .expect(201);

    const detail = await api()
      .get(`/api/v1/customers/${loyal}`)
      .set(authHeaders(salesToken))
      .expect(200);
    expect(detail.body.data.stats).toMatchObject({
      totalSpent: 48_000,
      orderCount: 5,
      segment: "LOYAL",
    });
    expect(detail.body.data.stats.lastPurchaseAt).not.toBeNull();

    const list = await api()
      .get("/api/v1/customers")
      .query({ segment: "LOYAL" })
      .set(authHeaders(salesToken))
      .expect(200);
    expect(list.body.data.items.map((item: { id: string }) => item.id)).toEqual([loyal]);
    expect(list.body.data.items[0]).toMatchObject({
      totalSpent: 48_000,
      orderCount: 5,
      segment: "LOYAL",
    });
  });

  it("hóa đơn đã hủy không tính vào tổng mua", async () => {
    const id = await createCustomer({ fullName: "Khách hủy đơn", phone: "0902000002" });
    const invoiceId = await sell(id, 3);
    await api()
      .post(`/api/v1/invoices/${invoiceId}/void`)
      .set({ ...authHeaders(adminToken, fixture.storeId), ...idem() })
      .send({ reason: "Khách đổi ý" })
      .expect(200);
    const detail = await api()
      .get(`/api/v1/customers/${id}`)
      .set(authHeaders(salesToken))
      .expect(200);
    expect(detail.body.data.stats).toMatchObject({
      totalSpent: 0,
      orderCount: 0,
      lastPurchaseAt: null,
    });
  });

  it("nhóm khách mới và lâu chưa quay lại, sắp xếp theo tổng mua", async () => {
    const fresh = await createCustomer({ fullName: "Khách mới", phone: "0903000001" });
    const dormant = await createCustomer({ fullName: "Khách lâu không mua", phone: "0903000002" });
    const invoiceId = await sell(dormant, 50);
    await prisma.customer.update({
      where: { id: dormant },
      data: { createdAt: new Date("2025-01-01") },
    });
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { soldAt: new Date("2025-02-01") },
    });

    const segments = async (segment: string) =>
      (
        await api()
          .get("/api/v1/customers")
          .query({ segment })
          .set(authHeaders(salesToken))
          .expect(200)
      ).body.data.items.map((item: { id: string }) => item.id);
    expect(await segments("NEW")).toEqual([fresh]);
    expect(await segments("DORMANT")).toEqual([dormant]);

    const sorted = await api()
      .get("/api/v1/customers")
      .query({ sortBy: "totalSpent", order: "desc" })
      .set(authHeaders(salesToken))
      .expect(200);
    expect(sorted.body.data.items[0].id).toBe(dormant);

    const summary = await api()
      .get("/api/v1/customers/summary")
      .set(authHeaders(salesToken))
      .expect(200);
    expect(summary.body.data).toMatchObject({
      total: 2,
      newThisMonth: 1,
      purchasedLast30Days: 0,
      segments: { LOYAL: 0, NEW: 1, DORMANT: 1 },
    });
  });

  it("tìm trong danh sách theo mã khách hàng hoặc tên không dấu", async () => {
    const id = await createCustomer({ fullName: "Phạm Quốc Huy", phone: "0904000001" });
    const code = (await prisma.customer.findUniqueOrThrow({ where: { id } })).code;
    for (const q of [code.toLowerCase(), "quoc huy", "0904000"]) {
      const response = await api()
        .get("/api/v1/customers")
        .query({ q })
        .set(authHeaders(salesToken))
        .expect(200);
      expect(response.body.data.items.map((item: { id: string }) => item.id)).toEqual([id]);
    }
  });
});

describe("Xuất danh sách khách hàng", () => {
  it("chỉ quyền customer.sensitive được xuất, có số điện thoại đầy đủ, chặn công thức và ghi audit", async () => {
    await createCustomer({ fullName: '=HYPERLINK("x")', phone: "0905000001", address: 'Q1, "TP"' });

    await api().get("/api/v1/customers/export").set(authHeaders(salesToken)).expect(403);

    const response = await api()
      .get("/api/v1/customers/export")
      .set(authHeaders(pharmacistToken))
      .expect(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.text.charCodeAt(0)).toBe(0xfeff);
    expect(response.text).toContain('"0905000001"');
    expect(response.text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(response.text).toContain('"Q1, ""TP"""');

    const audit = await prisma.auditLog.findFirst({ where: { action: "CUSTOMER_EXPORT" } });
    expect(audit?.after).toMatchObject({ rows: 1 });
  });
});
