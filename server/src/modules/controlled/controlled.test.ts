import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../../test/helpers.js";

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let salesToken: string;
let categoryId: string;
let morphin: { id: string; unitId: string };

const idem = () => ({ "Idempotency-Key": randomUUID() });
const h = (token: string) => authHeaders(token, fixture.storeId);

const BUYER = {
  buyerName: "Nguyễn Văn Bình",
  buyerIdNumber: "079123456789",
  buyerAddress: "12 Lý Thường Kiệt, Quận 10, TP.HCM",
  buyerPhone: "0901234567",
  relationship: "RELATIVE",
  relationshipNote: "Con trai người bệnh",
};

function dayOffset(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return new Date(date.toISOString().slice(0, 10));
}

async function makeBatch(batchNumber: string, quantity: number) {
  const batch = await prisma.batch.create({
    data: { storeId: fixture.storeId, productId: morphin.id, batchNumber, expiryDate: dayOffset(400), quantityOnHand: quantity },
  });
  return batch.id;
}

/** Đơn thuốc đã xác nhận cho thuốc kiểm soát đặc biệt. */
async function makePrescription(quantity = 20, withImage = true) {
  const prescription = await prisma.prescription.create({
    data: {
      storeId: fixture.storeId,
      code: `DT-${randomUUID().slice(0, 8)}`,
      prescriberName: "BS. Trần Văn C",
      facilityName: "Bệnh viện Ung bướu",
      prescribedDate: dayOffset(-1),
      validUntil: dayOffset(4),
      status: "VERIFIED",
      createdBy: fixture.pharmacistId,
      verifiedBy: fixture.pharmacistId,
      verifiedAt: new Date(),
      items: {
        create: { lineNo: 1, productId: morphin.id, drugNameText: "Morphin sulfat 10mg", productUnitId: morphin.unitId, quantity, baseQuantity: quantity },
      },
    },
    include: { items: true },
  });
  if (withImage) {
    await prisma.prescriptionImage.create({
      data: { prescriptionId: prescription.id, storageKey: `${prescription.id}/don.jpg`, contentType: "image/jpeg", sizeBytes: 1024, versionNo: 1, uploadedBy: fixture.pharmacistId },
    });
  }
  return prescription;
}

function sell(body: Record<string, unknown>, token = pharmacistToken) {
  return api()
    .post("/api/v1/invoices")
    .set({ ...h(token), ...idem() })
    .send(body);
}

const ledger = async (query = "", token = pharmacistToken) =>
  (await api().get(`/api/v1/controlled-drugs/ledger${query}`).set(h(token)).expect(200)).body.data;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [adminToken, pharmacistToken, salesToken] = await Promise.all([
    login("admin").then((item) => item.token),
    login("duocsi").then((item) => item.token),
    login("banhang").then((item) => item.token),
  ]);
  categoryId = (await prisma.category.create({ data: { name: "Thuốc gây nghiện" } })).id;
  const product = await prisma.product.create({
    data: {
      code: "TH0010",
      name: "Morphin sulfat 10mg",
      strengthText: "10mg",
      productType: "DRUG",
      drugClass: "CONTROLLED",
      categoryId,
      units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  morphin = { id: product.id, unitId: product.units[0]!.id };
  await prisma.productPrice.create({
    data: { productUnitId: morphin.unitId, salePrice: 5000n, vatRatePercent: 5, effectiveFrom: dayOffset(-1) },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Bán thuốc kiểm soát đặc biệt", () => {
  it("bán được khi có đơn đã xác nhận và ghi đủ thông tin người mua", async () => {
    await makeBatch("MOR01", 100);
    const prescription = await makePrescription();

    const response = await sell({
      prescriptionId: prescription.id,
      controlledBuyer: BUYER,
      lines: [{ productId: morphin.id, unitId: morphin.unitId, quantity: 10, prescriptionItemId: prescription.items[0]!.id }],
    }).expect(201);

    const detail = await prisma.controlledSaleDetail.findFirstOrThrow({ where: { invoiceId: response.body.data.id } });
    expect(detail).toMatchObject({
      buyerName: "Nguyễn Văn Bình",
      buyerIdNumber: "079123456789",
      relationship: "RELATIVE",
      recordedBy: fixture.pharmacistId,
    });
    expect((await prisma.batch.findFirstOrThrow({ where: { batchNumber: "MOR01" } })).quantityOnHand).toBe(90);
  });

  it("thiếu thông tin người mua thì không bán được", async () => {
    await makeBatch("MOR01", 100);
    const prescription = await makePrescription();

    const response = await sell({
      prescriptionId: prescription.id,
      lines: [{ productId: morphin.id, unitId: morphin.unitId, quantity: 5, prescriptionItemId: prescription.items[0]!.id }],
    }).expect(422);
    expect(response.body.error.code).toBe("CONTROLLED_BUYER_REQUIRED");
    expect(response.body.error.message).toContain("giấy tờ tùy thân");
    expect(await prisma.invoice.count()).toBe(0);

    // Thông tin người mua sơ sài cũng bị chặn ngay ở bước kiểm tra dữ liệu.
    const invalid = await sell({
      prescriptionId: prescription.id,
      controlledBuyer: { ...BUYER, buyerIdNumber: "123" },
      lines: [{ productId: morphin.id, unitId: morphin.unitId, quantity: 5, prescriptionItemId: prescription.items[0]!.id }],
    }).expect(422);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("không có đơn thuốc thì vẫn chặn dù đã ghi người mua", async () => {
    await makeBatch("MOR01", 100);
    const response = await sell({
      controlledBuyer: BUYER,
      lines: [{ productId: morphin.id, unitId: morphin.unitId, quantity: 1 }],
    }).expect(422);
    expect(response.body.error.code).toBe("PRESCRIPTION_REQUIRED");
  });

  it("đơn chưa có ảnh lưu thì cảnh báo mức cao, phải ghi nhận mới bán", async () => {
    await makeBatch("MOR01", 100);
    const prescription = await makePrescription(20, false);
    const body = {
      prescriptionId: prescription.id,
      controlledBuyer: BUYER,
      lines: [{ productId: morphin.id, unitId: morphin.unitId, quantity: 5, prescriptionItemId: prescription.items[0]!.id }],
    };

    const blocked = await sell(body).expect(422);
    expect(blocked.body.error.code).toBe("SAFETY_ACK_REQUIRED");
    expect(blocked.body.error.details[0].code).toBe("CONTROLLED_PRESCRIPTION_IMAGE_MISSING");

    await sell({
      ...body,
      acknowledgedWarnings: [{ code: "CONTROLLED_PRESCRIPTION_IMAGE_MISSING", productIds: [morphin.id], reason: "Đã giữ bản chính đơn tại nhà thuốc" }],
    }).expect(201);
  });

  it("nhân viên bán hàng không bán được thuốc kiểm soát đặc biệt", async () => {
    await makeBatch("MOR01", 100);
    const prescription = await makePrescription();
    const response = await sell(
      {
        prescriptionId: prescription.id,
        controlledBuyer: BUYER,
        lines: [{ productId: morphin.id, unitId: morphin.unitId, quantity: 1, prescriptionItemId: prescription.items[0]!.id }],
      },
      salesToken,
    ).expect(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});

describe("Sổ theo dõi thuốc kiểm soát đặc biệt", () => {
  it("ghi đủ nhập, xuất, số dư sau mỗi lần và thông tin người mua", async () => {
    // Nhập hàng thật để sổ có dòng nhập kèm nhà cung cấp.
    const supplier = await prisma.supplier.create({ data: { name: "Công ty Dược TW1", taxCode: "0100123456" } });
    const receipt = await api()
      .post("/api/v1/goods-receipts")
      .set({ ...h(pharmacistToken), ...idem() })
      .send({
        supplierId: supplier.id,
        lines: [{ productId: morphin.id, unitId: morphin.unitId, quantity: 50, unitCost: 3000, batchNumber: "MOR01", expiryDate: dayOffset(400).toISOString().slice(0, 10) }],
      })
      .expect(201);
    await api()
      .post(`/api/v1/goods-receipts/${receipt.body.data.id}/confirm`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({ lines: receipt.body.data.lines.map((line: { id: string }) => ({ lineId: line.id, passed: true })) })
      .expect(200);

    const prescription = await makePrescription();
    await sell({
      prescriptionId: prescription.id,
      controlledBuyer: BUYER,
      lines: [{ productId: morphin.id, unitId: morphin.unitId, quantity: 10, prescriptionItemId: prescription.items[0]!.id }],
    }).expect(201);

    const data = await ledger();
    expect(data.products).toHaveLength(1);
    const book = data.products[0];
    expect(book).toMatchObject({ code: "TH0010", baseUnitName: "Viên", openingBalance: 0, totalIn: 50, totalOut: 10, closingBalance: 40, stockOnHand: 40 });
    expect(data.mismatches).toEqual([]);

    const [inflow, outflow] = book.entries;
    expect(inflow).toMatchObject({ description: "Nhập từ nhà cung cấp", inQuantity: 50, outQuantity: 0, balanceAfter: 50, partyName: "Công ty Dược TW1", batchNumber: "MOR01" });
    expect(outflow).toMatchObject({
      description: "Bán theo đơn",
      outQuantity: 10,
      balanceAfter: 40,
      buyerName: "Nguyễn Văn Bình",
      buyerIdNumber: "079123456789",
      relationship: "Người nhà",
      prescriberName: "BS. Trần Văn C",
      facilityName: "Bệnh viện Ung bướu",
      handledBy: "Dược sĩ",
    });
    expect(outflow.prescriptionCode).toBe(prescription.code);
    expect(outflow.documentCode).toMatch(/^HD-NT01-/);
  });

  it("số dư đầu kỳ mang sang đúng khi xem theo kỳ", async () => {
    await makeBatch("MOR01", 0);
    const batchId = (await prisma.batch.findFirstOrThrow({ where: { batchNumber: "MOR01" } })).id;
    // Bút toán cũ 40 ngày trước, nằm ngoài kỳ đang xem.
    await prisma.stockMovement.create({
      data: {
        storeId: fixture.storeId,
        batchId,
        productId: morphin.id,
        type: "OPENING_BALANCE",
        baseQuantity: 30,
        balanceAfter: 30,
        sourceType: "TEST",
        sourceId: randomUUID(),
        sourceLineId: randomUUID(),
        occurredAt: new Date(Date.now() - 40 * 86_400_000),
      },
    });
    await prisma.batch.update({ where: { id: batchId }, data: { quantityOnHand: 30 } });

    const period = await ledger();
    expect(period.products[0]).toMatchObject({ openingBalance: 30, totalIn: 0, totalOut: 0, closingBalance: 30, stockOnHand: 30 });
    expect(period.products[0].entries).toEqual([]);

    const full = await ledger(`?from=${dayOffset(-60).toISOString().slice(0, 10)}`);
    expect(full.products[0]).toMatchObject({ openingBalance: 0, totalIn: 30, closingBalance: 30 });
    expect(full.products[0].entries).toHaveLength(1);
  });

  it("chỉ vai trò được cấp quyền mới xem được sổ", async () => {
    await api().get("/api/v1/controlled-drugs/ledger").set(h(salesToken)).expect(403);
    await api().get("/api/v1/controlled-drugs/ledger").set(h(adminToken)).expect(200);
    await api().get("/api/v1/controlled-drugs").set(h(pharmacistToken)).expect(200);
    await api().get("/api/v1/controlled-drugs/ledger").expect(401);
  });

  it("danh mục thuốc kiểm soát đặc biệt kèm tồn hiện tại và kiểm tra tham số ngày", async () => {
    await makeBatch("MOR01", 25);
    const list = (await api().get("/api/v1/controlled-drugs").set(h(pharmacistToken)).expect(200)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ code: "TH0010", name: "Morphin sulfat 10mg", strengthText: "10mg", stockOnHand: 25 });

    await api().get("/api/v1/controlled-drugs/ledger?from=2026-09-30&to=2026-09-01").set(h(pharmacistToken)).expect(422);
    await api().get("/api/v1/controlled-drugs/ledger?from=23-09-2026").set(h(pharmacistToken)).expect(422);
  });
});
