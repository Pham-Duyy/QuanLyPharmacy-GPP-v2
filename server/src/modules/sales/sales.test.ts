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
let pharmacistToken: string;
let salesToken: string;
let categoryId: string;

/** Mỗi lần bấm bán là một khóa mới, đúng như máy khách thật sinh khóa. */
function idem(): Record<string, string> {
  return { "Idempotency-Key": randomUUID() };
}

function dayOffset(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return new Date(date.toISOString().slice(0, 10));
}

type MadeProduct = { id: string; units: Record<string, string> };

async function makeProduct(options: {
  code: string;
  name: string;
  drugClass?: string | null;
  productType?: string;
  units?: Array<{ name: string; conversionToBase: number }>;
  ingredientIds?: string[];
}): Promise<MadeProduct> {
  const extra = options.units ?? [];
  const product = await prisma.product.create({
    data: {
      code: options.code,
      name: options.name,
      productType: options.productType ?? "DRUG",
      drugClass: options.drugClass === undefined ? "OTC" : options.drugClass,
      categoryId,
      units: {
        create: [
          { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true },
          ...extra.map((unit) => ({ ...unit, isDefaultSaleUnit: false })),
        ],
      },
      ...(options.ingredientIds
        ? {
            ingredients: {
              create: options.ingredientIds.map((ingredientId) => ({ ingredientId })),
            },
          }
        : {}),
    },
    include: { units: true },
  });

  return {
    id: product.id,
    units: Object.fromEntries(product.units.map((unit) => [unit.name, unit.id])),
  };
}

async function setPrice(
  productUnitId: string,
  salePrice: number,
  vatRatePercent = 5,
  storeId: string | null = null,
): Promise<void> {
  await prisma.productPrice.create({
    data: {
      productUnitId,
      storeId,
      salePrice: BigInt(salePrice),
      vatRatePercent,
      effectiveFrom: dayOffset(-1),
    },
  });
}

async function makeBatch(options: {
  productId: string;
  batchNumber: string;
  quantity: number;
  expiryInDays?: number;
  status?: string;
  storeId?: string;
}): Promise<string> {
  const batch = await prisma.batch.create({
    data: {
      storeId: options.storeId ?? fixture.storeId,
      productId: options.productId,
      batchNumber: options.batchNumber,
      expiryDate: dayOffset(options.expiryInDays ?? 365),
      quantityOnHand: options.quantity,
      status: options.status ?? "AVAILABLE",
    },
  });
  return batch.id;
}

/** Paracetamol: có hai đơn vị (Viên và Hộp 100 viên) để kiểm tra quy đổi C2. */
let para: MadeProduct;
/** Amoxicillin: thuốc kê đơn, dùng để kiểm tra luật đơn thuốc. */
let amox: MadeProduct;
/** Decolgen: cùng hoạt chất paracetamol, dùng để kiểm tra cảnh báo trùng. */
let decolgen: MadeProduct;
let paracetamolId: string;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [adminToken, pharmacistToken, salesToken] = await Promise.all([
    login("admin").then((result) => result.token),
    login("duocsi").then((result) => result.token),
    login("banhang").then((result) => result.token),
  ]);

  categoryId = (await prisma.category.create({ data: { name: "Thuốc giảm đau" } })).id;
  paracetamolId = (await prisma.activeIngredient.create({ data: { name: "Paracetamol" } })).id;

  para = await makeProduct({
    code: "TH0001",
    name: "Paracetamol 500mg",
    units: [{ name: "Hộp", conversionToBase: 100 }],
    ingredientIds: [paracetamolId],
  });
  amox = await makeProduct({ code: "TH0002", name: "Amoxicillin 500mg", drugClass: "RX" });
  decolgen = await makeProduct({
    code: "TH0003",
    name: "Decolgen Forte",
    ingredientIds: [paracetamolId],
  });

  await setPrice(para.units["Viên"]!, 1000);
  await setPrice(para.units["Hộp"]!, 95000);
  await setPrice(amox.units["Viên"]!, 3000);
  await setPrice(decolgen.units["Viên"]!, 2000);
});

afterAll(async () => {
  await prisma.$disconnect();
});

function sell(token: string, body: Record<string, unknown>) {
  return api()
    .post("/api/v1/invoices")
    .set({ ...authHeaders(token, fixture.storeId), ...idem() })
    .send(body);
}

function line(product: MadeProduct, unitName: string, quantity: number) {
  return { productId: product.id, unitId: product.units[unitName]!, quantity };
}

// ---------------------------------------------------------------------------

describe("Kiểm tra an toàn trước khi bán", () => {
  it("chặn khi tồn bán được không đủ", async () => {
    await makeBatch({ productId: para.id, batchNumber: "L1", quantity: 5 });

    const response = await api()
      .post("/api/v1/sales/safety-check")
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .send({ lines: [line(para, "Viên", 10)] })
      .expect(200);

    expect(response.body.data.blocking).toContainEqual(
      expect.objectContaining({ code: "INSUFFICIENT_STOCK", productId: para.id }),
    );
  });

  it("chặn thuốc kê đơn khi chưa có đơn thuốc", async () => {
    await makeBatch({ productId: amox.id, batchNumber: "L1", quantity: 100 });

    const response = await api()
      .post("/api/v1/sales/safety-check")
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .send({ lines: [line(amox, "Viên", 10)] })
      .expect(200);

    expect(response.body.data.blocking).toContainEqual(
      expect.objectContaining({ code: "PRESCRIPTION_REQUIRED", productId: amox.id }),
    );
  });

  it("cảnh báo hai sản phẩm trùng hoạt chất và bắt buộc ghi nhận", async () => {
    await makeBatch({ productId: para.id, batchNumber: "L1", quantity: 100 });
    await makeBatch({ productId: decolgen.id, batchNumber: "L2", quantity: 100 });

    const response = await api()
      .post("/api/v1/sales/safety-check")
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .send({ lines: [line(para, "Viên", 2), line(decolgen, "Viên", 2)] })
      .expect(200);

    const warning = response.body.data.warnings.find(
      (item: { code: string }) => item.code === "DUPLICATE_INGREDIENT",
    );
    expect(warning).toBeDefined();
    expect(warning.severity).toBe("HIGH");
    expect(warning.requiresAck).toBe(true);
    expect(warning.productIds).toEqual(expect.arrayContaining([para.id, decolgen.id]));
  });

  it("cảnh báo theo hồ sơ dị ứng của khách", async () => {
    await makeBatch({ productId: para.id, batchNumber: "L1", quantity: 100 });
    const customer = await prisma.customer.create({
      data: {
        fullName: "Nguyễn Văn A",
        phone: "0900000001",
        allergies: { create: { ingredientId: paracetamolId } },
      },
    });

    const response = await api()
      .post("/api/v1/sales/safety-check")
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .send({ customerId: customer.id, lines: [line(para, "Viên", 2)] })
      .expect(200);

    expect(response.body.data.warnings).toContainEqual(
      expect.objectContaining({ code: "ALLERGY_MATCH", requiresAck: true }),
    );
  });

  it("nói rõ sản phẩm chưa gắn hoạt chất là không kiểm tra được", async () => {
    await makeBatch({ productId: amox.id, batchNumber: "L1", quantity: 100 });

    const response = await api()
      .post("/api/v1/sales/safety-check")
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .send({ lines: [line(amox, "Viên", 1)] })
      .expect(200);

    expect(response.body.data.notChecked).toContainEqual(
      expect.objectContaining({ productId: amox.id, reason: "NO_INGREDIENT_MAPPING" }),
    );
  });
});

// ---------------------------------------------------------------------------

describe("Tạo hóa đơn", () => {
  it("trừ tồn theo FEFO, lô hạn gần nhất đi trước", async () => {
    const soon = await makeBatch({
      productId: para.id,
      batchNumber: "GAN",
      quantity: 50,
      expiryInDays: 60,
    });
    const later = await makeBatch({
      productId: para.id,
      batchNumber: "XA",
      quantity: 100,
      expiryInDays: 400,
    });

    const response = await sell(pharmacistToken, { lines: [line(para, "Viên", 80)] }).expect(201);

    const allocations = response.body.data.lines[0].allocations;
    expect(allocations).toHaveLength(2);
    expect(allocations[0]).toMatchObject({ batchId: soon, baseQuantity: 50 });
    expect(allocations[1]).toMatchObject({ batchId: later, baseQuantity: 30 });

    const batches = await prisma.batch.findMany({ where: { productId: para.id } });
    expect(batches.find((batch) => batch.id === soon)?.quantityOnHand).toBe(0);
    expect(batches.find((batch) => batch.id === later)?.quantityOnHand).toBe(70);
  });

  it("quy đổi đúng khi bán theo đơn vị lớn", async () => {
    const batchId = await makeBatch({ productId: para.id, batchNumber: "L1", quantity: 500 });

    const response = await sell(pharmacistToken, { lines: [line(para, "Hộp", 2)] }).expect(201);

    expect(response.body.data.lines[0]).toMatchObject({
      quantity: 2,
      baseQuantity: 200,
      conversionToBase: 100,
      unitName: "Hộp",
    });
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.quantityOnHand).toBe(300);
  });

  it("chặn đơn vị không thuộc sản phẩm", async () => {
    await makeBatch({ productId: para.id, batchNumber: "L1", quantity: 100 });

    const response = await sell(pharmacistToken, {
      lines: [{ productId: para.id, unitId: amox.units["Viên"]!, quantity: 1 }],
    }).expect(422);

    expect(response.body.error.code).toBe("UNIT_NOT_IN_PRODUCT");
  });

  it("bỏ qua lô biệt trữ, lô thu hồi và lô đã hết hạn", async () => {
    await makeBatch({
      productId: para.id,
      batchNumber: "BIET_TRU",
      quantity: 100,
      expiryInDays: 30,
      status: "QUARANTINED",
    });
    await makeBatch({
      productId: para.id,
      batchNumber: "THU_HOI",
      quantity: 100,
      expiryInDays: 40,
      status: "RECALLED",
    });
    await makeBatch({
      productId: para.id,
      batchNumber: "HET_HAN",
      quantity: 100,
      expiryInDays: -1,
    });
    const good = await makeBatch({
      productId: para.id,
      batchNumber: "TOT",
      quantity: 100,
      expiryInDays: 300,
    });

    const response = await sell(pharmacistToken, { lines: [line(para, "Viên", 10)] }).expect(201);

    expect(response.body.data.lines[0].allocations).toEqual([
      expect.objectContaining({ batchId: good, baseQuantity: 10 }),
    ]);
  });

  it("báo thiếu tồn kèm số lượng bán được", async () => {
    await makeBatch({ productId: para.id, batchNumber: "L1", quantity: 30 });
    await makeBatch({
      productId: para.id,
      batchNumber: "L2",
      quantity: 100,
      status: "QUARANTINED",
    });

    const response = await sell(pharmacistToken, { lines: [line(para, "Viên", 40)] }).expect(409);

    expect(response.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(response.body.error.details[0]).toMatchObject({
      productId: para.id,
      requestedBaseQuantity: 40,
      sellableBaseQuantity: 30,
    });
  });

  it("chặn bán khi đơn vị chưa có giá", async () => {
    const khac = await makeProduct({ code: "TH0009", name: "Vitamin C" });
    await makeBatch({ productId: khac.id, batchNumber: "L1", quantity: 100 });

    const response = await sell(pharmacistToken, { lines: [line(khac, "Viên", 1)] }).expect(422);

    expect(response.body.error.code).toBe("PRICE_NOT_SET");
  });

  it("tách VAT ngược từ giá đã gồm VAT", async () => {
    await makeBatch({ productId: para.id, batchNumber: "L1", quantity: 500 });

    const response = await sell(pharmacistToken, { lines: [line(para, "Hộp", 2)] }).expect(201);

    // 2 hộp x 95.000 = 190.000 đã gồm VAT 5% -> VAT = 190000 x 5 / 105 = 9048
    expect(response.body.data).toMatchObject({
      subtotal: 190000,
      discountAmount: 0,
      vatAmount: 9048,
      totalAmount: 190000,
    });
  });

  it("lấy giá riêng của cửa hàng trước giá chung toàn chuỗi", async () => {
    await makeBatch({ productId: para.id, batchNumber: "L1", quantity: 100 });
    await setPrice(para.units["Viên"]!, 1200, 5, fixture.storeId);

    const response = await sell(pharmacistToken, { lines: [line(para, "Viên", 10)] }).expect(201);

    expect(response.body.data.lines[0].unitPrice).toBe(1200);
    expect(response.body.data.totalAmount).toBe(12000);
  });

  it("chặn giảm giá vượt hạn mức của vai trò", async () => {
    await makeBatch({ productId: para.id, batchNumber: "L1", quantity: 100 });

    const response = await sell(pharmacistToken, {
      lines: [line(para, "Viên", 10)],
      discount: { type: "PERCENT", value: 15, reason: "Khách quen" },
    }).expect(422);

    expect(response.body.error.code).toBe("DISCOUNT_LIMIT_EXCEEDED");
  });

  it("tính số tiền giảm trong hạn mức và phân bổ về từng dòng", async () => {
    await makeBatch({ productId: para.id, batchNumber: "L1", quantity: 100 });
    await makeBatch({ productId: decolgen.id, batchNumber: "L2", quantity: 100 });

    const response = await sell(pharmacistToken, {
      lines: [line(para, "Viên", 10), line(decolgen, "Viên", 10)],
      discount: { type: "PERCENT", value: 10, reason: "Khách quen" },
      acknowledgedWarnings: [
        { code: "DUPLICATE_INGREDIENT", productIds: [para.id, decolgen.id], reason: "Đã tư vấn" },
      ],
    }).expect(201);

    // 10.000 + 20.000 = 30.000, giảm 10% = 3.000, phân bổ 1.000 và 2.000.
    expect(response.body.data).toMatchObject({
      subtotal: 30000,
      discountAmount: 3000,
      totalAmount: 27000,
    });
    const discounts = response.body.data.lines.map(
      (item: { discountAmount: number }) => item.discountAmount,
    );
    expect(discounts).toEqual([1000, 2000]);
  });

  it("chặn chỉ định lô khi người bán không có quyền", async () => {
    const batchId = await makeBatch({ productId: para.id, batchNumber: "L1", quantity: 100 });

    const response = await sell(salesToken, {
      lines: [
        {
          ...line(para, "Viên", 1),
          batchId,
          batchOverrideReason: "Khách cần hạn dùng dài",
        },
      ],
    }).expect(403);

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("cho phép chỉ định lô khác thứ tự FEFO khi có quyền và ghi lý do", async () => {
    await makeBatch({ productId: para.id, batchNumber: "GAN", quantity: 100, expiryInDays: 30 });
    const later = await makeBatch({
      productId: para.id,
      batchNumber: "XA",
      quantity: 100,
      expiryInDays: 400,
    });

    const response = await sell(pharmacistToken, {
      lines: [
        {
          ...line(para, "Viên", 5),
          batchId: later,
          batchOverrideReason: "Khách đi công tác dài ngày",
        },
      ],
    }).expect(201);

    expect(response.body.data.lines[0].allocations).toEqual([
      expect.objectContaining({ batchId: later, baseQuantity: 5 }),
    ]);
    expect(response.body.data.lines[0].batchOverrideReason).toBe("Khách đi công tác dài ngày");
  });

  it("chặn bán thuốc kiểm soát đặc biệt trong phạm vi MVP", async () => {
    const morphin = await makeProduct({
      code: "TH0010",
      name: "Morphin 10mg",
      drugClass: "CONTROLLED",
    });
    await setPrice(morphin.units["Viên"]!, 5000);
    await makeBatch({ productId: morphin.id, batchNumber: "L1", quantity: 100 });

    const response = await sell(pharmacistToken, { lines: [line(morphin, "Viên", 1)] }).expect(422);

    expect(response.body.error.code).toBe("CONTROLLED_DRUG_NOT_SUPPORTED");
  });

  it("chặn nhân viên bán hàng bán thuốc kê đơn", async () => {
    await makeBatch({ productId: amox.id, batchNumber: "L1", quantity: 100 });

    const response = await sell(salesToken, { lines: [line(amox, "Viên", 1)] }).expect(403);

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("bán thuốc kê đơn theo đơn đã duyệt và cộng dồn số lượng đã bán", async () => {
    await makeBatch({ productId: amox.id, batchNumber: "L1", quantity: 100 });
    const prescription = await prisma.prescription.create({
      data: {
        storeId: fixture.storeId,
        code: "DT-001",
        prescribedDate: dayOffset(-1),
        validUntil: dayOffset(4),
        status: "VERIFIED",
        createdBy: fixture.pharmacistId,
        verifiedBy: fixture.pharmacistId,
        verifiedAt: new Date(),
        items: {
          create: {
            lineNo: 1,
            productId: amox.id,
            drugNameText: "Amoxicillin 500mg",
            productUnitId: amox.units["Viên"]!,
            quantity: 20,
            baseQuantity: 20,
          },
        },
      },
      include: { items: true },
    });

    await sell(pharmacistToken, {
      prescriptionId: prescription.id,
      lines: [{ ...line(amox, "Viên", 12), prescriptionItemId: prescription.items[0]!.id }],
    }).expect(201);

    const item = await prisma.prescriptionItem.findUniqueOrThrow({
      where: { id: prescription.items[0]!.id },
    });
    expect(item.dispensedBaseQuantity).toBe(12);
    const updated = await prisma.prescription.findUniqueOrThrow({ where: { id: prescription.id } });
    expect(updated.status).toBe("PARTIALLY_DISPENSED");
  });

  it("chặn bán vượt số lượng đã kê", async () => {
    await makeBatch({ productId: amox.id, batchNumber: "L1", quantity: 100 });
    const prescription = await prisma.prescription.create({
      data: {
        storeId: fixture.storeId,
        code: "DT-002",
        prescribedDate: dayOffset(-1),
        validUntil: dayOffset(4),
        status: "VERIFIED",
        createdBy: fixture.pharmacistId,
        verifiedBy: fixture.pharmacistId,
        verifiedAt: new Date(),
        items: {
          create: {
            lineNo: 1,
            productId: amox.id,
            drugNameText: "Amoxicillin 500mg",
            productUnitId: amox.units["Viên"]!,
            quantity: 10,
            baseQuantity: 10,
          },
        },
      },
      include: { items: true },
    });

    const response = await sell(pharmacistToken, {
      prescriptionId: prescription.id,
      lines: [{ ...line(amox, "Viên", 11), prescriptionItemId: prescription.items[0]!.id }],
    }).expect(422);

    expect(response.body.error.code).toBe("PRESCRIBED_QUANTITY_EXCEEDED");
  });

  it("bắt buộc ghi nhận cảnh báo mức cao trước khi bán", async () => {
    await makeBatch({ productId: para.id, batchNumber: "L1", quantity: 100 });
    await makeBatch({ productId: decolgen.id, batchNumber: "L2", quantity: 100 });

    const response = await sell(pharmacistToken, {
      lines: [line(para, "Viên", 2), line(decolgen, "Viên", 2)],
    }).expect(422);

    expect(response.body.error.code).toBe("SAFETY_ACK_REQUIRED");
  });

  it("yêu cầu Idempotency-Key", async () => {
    await makeBatch({ productId: para.id, batchNumber: "L1", quantity: 100 });

    const response = await api()
      .post("/api/v1/invoices")
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .send({ lines: [line(para, "Viên", 1)] })
      .expect(400);

    expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("cùng khóa idempotency chỉ trừ tồn một lần", async () => {
    const batchId = await makeBatch({ productId: para.id, batchNumber: "L1", quantity: 100 });
    const key = idem();
    const body = { lines: [line(para, "Viên", 10)] };

    const first = await api()
      .post("/api/v1/invoices")
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...key })
      .send(body)
      .expect(201);
    const second = await api()
      .post("/api/v1/invoices")
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...key })
      .send(body)
      .expect(201);

    expect(second.body.data.id).toBe(first.body.data.id);
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.quantityOnHand).toBe(90);
    expect(await prisma.invoice.count()).toBe(1);
  });

  it("hai quầy bán lô cuối cùng cùng lúc thì chỉ một hóa đơn thành công", async () => {
    const batchId = await makeBatch({ productId: para.id, batchNumber: "L1", quantity: 10 });
    const body = { lines: [line(para, "Viên", 10)] };

    const results = await Promise.all([sell(pharmacistToken, body), sell(pharmacistToken, body)]);

    const statuses = results.map((result) => result.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)!.body.error.code).toBe(
      "INSUFFICIENT_STOCK",
    );

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.quantityOnHand).toBe(0);
    expect(await prisma.invoice.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("Xem và hủy hóa đơn", () => {
  async function sellOne(): Promise<{ invoiceId: string; batchId: string }> {
    const batchId = await makeBatch({ productId: para.id, batchNumber: "L1", quantity: 100 });
    const response = await sell(pharmacistToken, { lines: [line(para, "Viên", 10)] }).expect(201);
    return { invoiceId: response.body.data.id, batchId };
  }

  it("trả về phân bổ lô và thẻ kho khi xem chi tiết", async () => {
    const { invoiceId, batchId } = await sellOne();

    const response = await api()
      .get(`/api/v1/invoices/${invoiceId}`)
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .expect(200);

    expect(response.body.data.lines[0].allocations).toEqual([
      expect.objectContaining({ batchId, baseQuantity: 10 }),
    ]);

    const movements = await prisma.stockMovement.findMany({ where: { sourceId: invoiceId } });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ type: "SALE", baseQuantity: -10, balanceAfter: 90 });
  });

  it("không thấy hóa đơn của cửa hàng khác", async () => {
    const { invoiceId } = await sellOne();

    await api()
      .get(`/api/v1/invoices/${invoiceId}`)
      .set(authHeaders(adminToken, fixture.otherStoreId))
      .expect(404);
  });

  it("hủy hóa đơn thì hoàn tồn về đúng lô đã xuất", async () => {
    const { invoiceId, batchId } = await sellOne();

    const response = await api()
      .post(`/api/v1/invoices/${invoiceId}/void`)
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send({ reason: "Khách đổi ý ngay tại quầy" })
      .expect(200);

    expect(response.body.data.status).toBe("VOIDED");
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.quantityOnHand).toBe(100);

    const movements = await prisma.stockMovement.findMany({
      where: { sourceId: invoiceId },
      orderBy: { id: "asc" },
    });
    expect(movements.map((movement) => movement.type)).toEqual(["SALE", "SALE_VOID"]);
    expect(movements[1]).toMatchObject({ baseQuantity: 10, balanceAfter: 100 });
  });

  it("không hủy được hóa đơn đã hủy", async () => {
    const { invoiceId } = await sellOne();
    const body = { reason: "Khách đổi ý ngay tại quầy" };

    await api()
      .post(`/api/v1/invoices/${invoiceId}/void`)
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send(body)
      .expect(200);

    const response = await api()
      .post(`/api/v1/invoices/${invoiceId}/void`)
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send(body)
      .expect(409);

    expect(response.body.error.code).toBe("INVALID_STATE");
  });

  it("lọc danh sách hóa đơn theo cửa hàng đang đứng", async () => {
    await sellOne();

    const mine = await api()
      .get("/api/v1/invoices")
      .set(authHeaders(pharmacistToken, fixture.storeId))
      .expect(200);
    expect(mine.body.data.items).toHaveLength(1);

    const other = await api()
      .get("/api/v1/invoices")
      .set(authHeaders(adminToken, fixture.otherStoreId))
      .expect(200);
    expect(other.body.data.items).toHaveLength(0);
  });
});
