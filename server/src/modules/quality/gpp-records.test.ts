import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "../../generated/prisma/client.js";
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
let pharmacist: string;
let admin: string;
let productId: string;
let pillId: string;
let batchId: string;

const h = (token = pharmacist) => ({
  ...authHeaders(token, fixture.storeId),
  "Idempotency-Key": randomUUID(),
});

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [pharmacist, admin] = await Promise.all([
    login("duocsi").then((r) => r.token),
    login("admin").then((r) => r.token),
  ]);
  const category = await prisma.category.create({ data: { name: "Kháng sinh" } });
  const product = await prisma.product.create({
    data: {
      code: "TH0301",
      name: "Amoxicillin 500mg",
      productType: "DRUG",
      drugClass: "OTC",
      categoryId: category.id,
      units: { create: [{ name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true }] },
    },
    include: { units: true },
  });
  productId = product.id;
  pillId = product.units[0]!.id;
  await prisma.productPrice.create({
    data: {
      productUnitId: pillId,
      salePrice: 2000n,
      vatRatePercent: 5,
      effectiveFrom: new Date(Date.now() - 86_400_000),
    },
  });
  batchId = (
    await prisma.batch.create({
      data: {
        storeId: fixture.storeId,
        productId,
        batchNumber: "AMX01",
        expiryDate: new Date("2029-01-31"),
        quantityOnHand: 100,
        unitCost: new Prisma.Decimal(1000),
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Phiếu nhập: cảnh báo hồ sơ GPP", () => {
  it("cảnh báo nhà cung cấp thiếu giấy phép và thuốc chưa có số đăng ký, không chặn", async () => {
    const supplier = await prisma.supplier.create({ data: { name: "Công ty Dược Lạ" } });
    const created = await api()
      .post("/api/v1/goods-receipts")
      .set(h())
      .send({
        supplierId: supplier.id,
        lines: [
          {
            productId,
            unitId: pillId,
            quantity: 10,
            unitCost: 1000,
            batchNumber: "N1",
            expiryDate: "2029-12-31",
          },
        ],
      })
      .expect(201);
    expect(created.body.data.complianceWarnings).toEqual([
      "Nhà cung cấp Công ty Dược Lạ chưa có số giấy chứng nhận đủ điều kiện kinh doanh dược",
      "Thuốc chưa có số đăng ký: Amoxicillin 500mg",
    ]);

    await prisma.supplier.update({
      where: { id: supplier.id },
      data: { licenseNumber: "1234/ĐKKDD-HN" },
    });
    await prisma.product.update({
      where: { id: productId },
      data: { registrationNumber: "VD-12345-19" },
    });
    const again = await api()
      .get(`/api/v1/goods-receipts/${created.body.data.id}`)
      .set(authHeaders(pharmacist, fixture.storeId))
      .expect(200);
    expect(again.body.data.complianceWarnings).toEqual([]);
  });
});

describe("Sổ khiếu nại và phản ứng có hại", () => {
  it("ghi phiếu ADR gắn lô, cập nhật ngày báo cáo, đóng khi có cách xử lý", async () => {
    const created = await api()
      .post("/api/v1/quality-reports")
      .set(h())
      .send({
        kind: "ADR",
        occurredOn: "2026-10-08",
        batchId,
        reporterName: "Chị Hoa",
        description: "Nổi mẩn đỏ sau 2 liều Amoxicillin",
      })
      .expect(201);
    expect(created.body.data).toMatchObject({
      kind: "ADR",
      status: "OPEN",
      product: { id: productId },
      batch: { id: batchId, batchNumber: "AMX01", status: "AVAILABLE" },
    });
    expect(created.body.data.code).toMatch(/^KN-NT01-\d{8}-0001$/);

    await api()
      .post(`/api/v1/quality-reports/${created.body.data.id}/close`)
      .set(h())
      .send({})
      .expect(422);
    const updated = await api()
      .patch(`/api/v1/quality-reports/${created.body.data.id}`)
      .set(h())
      .send({
        version: created.body.data.version,
        actionTaken: "Ngừng thuốc, khuyên khám lại",
        adrReportedOn: "2026-10-09",
      })
      .expect(200);
    expect(updated.body.data.adrReportedOn).toMatch(/^2026-10-09/);
    // Sửa bằng version cũ: báo xung đột.
    await api()
      .patch(`/api/v1/quality-reports/${created.body.data.id}`)
      .set(h())
      .send({ version: created.body.data.version, actionTaken: "x" })
      .expect(409);

    const closed = await api()
      .post(`/api/v1/quality-reports/${created.body.data.id}/close`)
      .set(h())
      .send({})
      .expect(200);
    expect(closed.body.data).toMatchObject({
      status: "CLOSED",
      actionTaken: "Ngừng thuốc, khuyên khám lại",
    });
    await api()
      .patch(`/api/v1/quality-reports/${created.body.data.id}`)
      .set(h())
      .send({ version: closed.body.data.version, actionTaken: "y" })
      .expect(409);
    expect(await prisma.auditLog.count({ where: { resourceType: "quality_report" } })).toBe(3);
  });

  it("khiếu nại không ghi được ngày báo ADR; lô phải thuộc cửa hàng và đúng sản phẩm", async () => {
    const complaint = await api()
      .post("/api/v1/quality-reports")
      .set(h())
      .send({
        kind: "COMPLAINT",
        occurredOn: "2026-10-08",
        productId,
        description: "Vỉ thuốc bị phồng",
      })
      .expect(201);
    await api()
      .patch(`/api/v1/quality-reports/${complaint.body.data.id}`)
      .set(h())
      .send({ version: complaint.body.data.version, adrReportedOn: "2026-10-09" })
      .expect(422);

    const otherBatch = await prisma.batch.create({
      data: {
        storeId: fixture.otherStoreId,
        productId,
        batchNumber: "AMX02",
        expiryDate: new Date("2029-01-31"),
        quantityOnHand: 5,
      },
    });
    await api()
      .post("/api/v1/quality-reports")
      .set(h())
      .send({
        kind: "COMPLAINT",
        occurredOn: "2026-10-08",
        batchId: otherBatch.id,
        description: "Lô cửa hàng khác",
      })
      .expect(404);
  });

  it("nhân viên kho không ghi được; kiểm toán xem được nhưng không ghi được", async () => {
    await useTestRole(fixture.salesId, "warehouse_staff", fixture.storeId);
    const kho = (await login("banhang")).token;
    await api()
      .post("/api/v1/quality-reports")
      .set(h(kho))
      .send({ kind: "COMPLAINT", occurredOn: "2026-10-08", description: "Thử ghi sổ" })
      .expect(403);
    await api().get("/api/v1/quality-reports").set(authHeaders(kho, fixture.storeId)).expect(403);

    await useTestRole(fixture.salesId, "auditor", fixture.storeId);
    const auditor = (await login("banhang")).token;
    await api()
      .get("/api/v1/quality-reports")
      .set(authHeaders(auditor, fixture.storeId))
      .expect(200);
    await api()
      .post("/api/v1/quality-reports")
      .set(h(auditor))
      .send({ kind: "COMPLAINT", occurredOn: "2026-10-08", description: "Thử ghi sổ" })
      .expect(403);
  });
});

describe("Thu hồi: đánh dấu đã liên hệ khách", () => {
  it("đánh dấu, hiện trong danh sách khách đã mua, bỏ đánh dấu; hóa đơn không bán lô thu hồi thì 404", async () => {
    const sold = await api()
      .post("/api/v1/invoices")
      .set(h())
      .send({ lines: [{ productId, unitId: pillId, quantity: 4 }] })
      .expect(201);
    const recall = await api()
      .post("/api/v1/recalls")
      .set(h(admin))
      .send({
        documentNumber: "05/QLD-CL",
        issuedAt: "2026-10-09",
        items: [{ productId, batchNumber: "AMX01" }],
      })
      .expect(201);

    await api()
      .post(`/api/v1/recalls/${recall.body.data.id}/contacts`)
      .set(authHeaders(admin, fixture.storeId))
      .send({ invoiceId: sold.body.data.id, note: "Đã gọi, khách mang trả chiều nay" })
      .expect(200);
    const sales = await api()
      .get(`/api/v1/recalls/${recall.body.data.id}/affected-sales`)
      .set(authHeaders(admin, fixture.storeId))
      .expect(200);
    expect(sales.body.data[0].contact).toMatchObject({
      note: "Đã gọi, khách mang trả chiều nay",
      contactedByName: "Quản trị",
    });

    await api()
      .delete(`/api/v1/recalls/${recall.body.data.id}/contacts/${sold.body.data.id}`)
      .set(authHeaders(admin, fixture.storeId))
      .expect(200);
    const after = await api()
      .get(`/api/v1/recalls/${recall.body.data.id}/affected-sales`)
      .set(authHeaders(admin, fixture.storeId))
      .expect(200);
    expect(after.body.data[0].contact).toBeNull();

    await api()
      .post(`/api/v1/recalls/${recall.body.data.id}/contacts`)
      .set(authHeaders(admin, fixture.storeId))
      .send({ invoiceId: randomUUID() })
      .expect(404);
  });
});

describe("Kiểm kê: kiểm tra cảm quan", () => {
  it("cảm quan không đạt phải ghi lý do; xem lại thấy cờ và trạng thái lô; xóa số đếm thì bỏ cờ", async () => {
    const opened = await api().post("/api/v1/stock-counts").set(h()).send({}).expect(201);
    const countId = opened.body.data.count?.id ?? opened.body.data.id;
    const detail = async () =>
      (
        await api()
          .get(`/api/v1/stock-counts/${countId}`)
          .set(authHeaders(pharmacist, fixture.storeId))
          .expect(200)
      ).body.data;
    const line = (await detail()).lines.find(
      (item: { batchId: string }) => item.batchId === batchId,
    );

    const save = (entry: Record<string, unknown>) =>
      api()
        .patch(`/api/v1/stock-counts/${countId}/counts`)
        .set(authHeaders(pharmacist, fixture.storeId))
        .send({ entries: [{ lineId: line.id, unitId: pillId, quantity: 100, ...entry }] });

    const missing = await save({ sensoryFailed: true }).expect(422);
    expect(missing.body.error.message).toContain("ghi lý do");
    await save({ sensoryFailed: true, note: "Vỉ bị ẩm, viên đổi màu" }).expect(200);
    const failed = (await detail()).lines.find((item: { id: string }) => item.id === line.id);
    expect(failed).toMatchObject({
      sensoryFailed: true,
      note: "Vỉ bị ẩm, viên đổi màu",
      batchStatus: "AVAILABLE",
    });
    expect(typeof failed.batchVersion).toBe("number");

    await api()
      .patch(`/api/v1/stock-counts/${countId}/counts`)
      .set(authHeaders(pharmacist, fixture.storeId))
      .send({ entries: [{ lineId: line.id, clear: true }] })
      .expect(200);
    expect(
      (await detail()).lines.find((item: { id: string }) => item.id === line.id).sensoryFailed,
    ).toBe(false);
  });
});
