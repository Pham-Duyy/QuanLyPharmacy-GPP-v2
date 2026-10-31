import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { setMailTransportForTests } from "../../lib/mailer.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  type Fixture,
} from "../../test/helpers.js";

/** Đơn đặt hàng gửi nhà cung cấp (Phase 7, D32). */

let f: Fixture;
let admin: string;
let pharmacist: string;
let supplierId: string;
let otherSupplierId: string;
let paracetamol: { productId: string; boxId: string; tabletId: string };
let vitamin: { productId: string; unitId: string };

beforeEach(async () => {
  await truncateAll();
  f = await seedFixture();
  admin = (await login("admin")).token;
  pharmacist = (await login("duocsi")).token;
  const category = await prisma.category.create({ data: { name: "Thuốc" } });
  supplierId = (
    await prisma.supplier.create({
      data: { name: "Công ty Dược A", email: "donhang@duoca.vn", licenseNumber: "GP-01" },
    })
  ).id;
  otherSupplierId = (await prisma.supplier.create({ data: { name: "Công ty Dược B" } })).id;
  const para = await prisma.product.create({
    data: {
      code: "TH0001",
      name: "Paracetamol 500mg",
      productType: "SUPPLEMENT",
      categoryId: category.id,
      units: {
        create: [
          { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true },
          { name: "Hộp", conversionToBase: 100 },
        ],
      },
    },
    include: { units: true },
  });
  paracetamol = {
    productId: para.id,
    tabletId: para.units.find((u) => u.conversionToBase === 1)!.id,
    boxId: para.units.find((u) => u.conversionToBase === 100)!.id,
  };
  const vit = await prisma.product.create({
    data: {
      code: "TH0002",
      name: "Vitamin C",
      productType: "SUPPLEMENT",
      categoryId: category.id,
      units: { create: { name: "Tuýp", conversionToBase: 1, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  vitamin = { productId: vit.id, unitId: vit.units[0]!.id };
});

afterEach(() => setMailTransportForTests(null));
afterAll(() => prisma.$disconnect());

const call = (method: "get" | "post" | "patch", path: string, token: string, body?: object) => {
  const agent = api();
  const request = agent[method](`/api/v1${path}`).set({
    ...authHeaders(token, f.storeId),
    "Idempotency-Key": randomUUID(),
  });
  return body ? request.send(body) : request;
};

async function draft(token = pharmacist) {
  const response = await call("post", "/purchase-orders", token, {
    supplierId,
    note: "Giao giờ hành chính",
    lines: [
      {
        productId: paracetamol.productId,
        unitId: paracetamol.boxId,
        quantity: 2,
        unitPrice: 80_000,
      },
      { productId: vitamin.productId, unitId: vitamin.unitId, quantity: 10 },
    ],
  }).expect(201);
  return response.body.data;
}

/** Lập phiếu nhập từ đơn rồi kiểm nhập (dòng đạt tùy chọn). */
async function receive(
  orderId: string,
  lines: Array<{ productId: string; unitId: string; quantity: number }>,
  pass = true,
) {
  const created = await call("post", "/goods-receipts", admin, {
    supplierId,
    purchaseOrderId: orderId,
    lines: lines.map((line, index) => ({
      ...line,
      unitCost: 800,
      batchNumber: `LO${index}${randomUUID().slice(0, 4)}`,
      expiryDate: "2028-01-01",
    })),
  }).expect(201);
  const receipt = created.body.data;
  await call("post", `/goods-receipts/${receipt.id}/confirm`, admin, {
    lines: receipt.lines.map((line: { id: string }) => ({
      lineId: line.id,
      passed: pass,
      ...(pass ? {} : { rejectReason: "Móp hộp" }),
    })),
  }).expect(200);
  return receipt;
}

describe("Lập và sửa đơn", () => {
  it("dược sĩ lập đơn nháp: mã DH-, quy đổi đơn vị, tổng tạm tính", async () => {
    const order = await draft();
    expect(order.code).toMatch(/^DH-NT01-\d{8}-0001$/);
    expect(order.status).toBe("DRAFT");
    expect(order.estimatedAmount).toBe(160_000);
    expect(order.lines[0]).toMatchObject({ baseQuantity: 200, remainingQuantity: 2 });
  });

  it("một sản phẩm một dòng; nhà cung cấp ngừng giao dịch bị chặn", async () => {
    await call("post", "/purchase-orders", pharmacist, {
      supplierId,
      lines: [
        { productId: vitamin.productId, unitId: vitamin.unitId, quantity: 1 },
        { productId: vitamin.productId, unitId: vitamin.unitId, quantity: 2 },
      ],
    }).expect(422);
    await prisma.supplier.update({ where: { id: otherSupplierId }, data: { isActive: false } });
    await call("post", "/purchase-orders", pharmacist, {
      supplierId: otherSupplierId,
      lines: [{ productId: vitamin.productId, unitId: vitamin.unitId, quantity: 1 }],
    }).expect(422);
  });

  it("sửa được khi nháp, đúng version; gửi rồi thì không sửa được", async () => {
    const order = await draft();
    const edited = await call("patch", `/purchase-orders/${order.id}`, pharmacist, {
      version: order.version,
      lines: [
        { productId: vitamin.productId, unitId: vitamin.unitId, quantity: 5, unitPrice: 30_000 },
      ],
    }).expect(200);
    expect(edited.body.data.lines).toHaveLength(1);
    expect(edited.body.data.estimatedAmount).toBe(150_000);
    await call("patch", `/purchase-orders/${order.id}`, pharmacist, {
      version: order.version,
    }).expect(409);

    await call("post", `/purchase-orders/${order.id}/send`, admin, { channel: "MANUAL" }).expect(
      200,
    );
    await call("patch", `/purchase-orders/${order.id}`, pharmacist, {
      version: edited.body.data.version + 1,
      note: "x",
    }).expect(409);
  });

  it("tạo từ đề xuất: mỗi nhà cung cấp một đơn", async () => {
    const response = await call("post", "/purchase-orders/from-suggestions", pharmacist, {
      items: [
        { supplierId, productId: paracetamol.productId, unitId: paracetamol.boxId, quantity: 3 },
        {
          supplierId: otherSupplierId,
          productId: vitamin.productId,
          unitId: vitamin.unitId,
          quantity: 4,
        },
      ],
    }).expect(201);
    expect(response.body.data.ids).toHaveLength(2);
    expect(await prisma.purchaseOrder.count({ where: { status: "DRAFT" } })).toBe(2);
  });
});

describe("Gửi đơn", () => {
  it("dược sĩ không gửi được; quản lý ghi nhận đã gửi (tự gửi Zalo), có nhật ký", async () => {
    const order = await draft();
    // "banhang" là dược sĩ không có quyền bổ sung xác nhận phiếu nhập.
    const plain = (await login("banhang")).token;
    await call("post", `/purchase-orders/${order.id}/send`, plain, {
      channel: "MANUAL",
    }).expect(403);
    const sent = await call("post", `/purchase-orders/${order.id}/send`, admin, {
      channel: "MANUAL",
    }).expect(200);
    expect(sent.body.data).toMatchObject({ status: "SENT", sentVia: "MANUAL" });
    expect(await prisma.auditLog.count({ where: { action: "PURCHASE_ORDER_SEND" } })).toBe(1);
  });

  it("chưa cấu hình SMTP: báo rõ, đơn vẫn là nháp", async () => {
    const order = await draft();
    const response = await call("post", `/purchase-orders/${order.id}/send`, admin, {
      channel: "EMAIL",
      to: "donhang@duoca.vn",
    }).expect(409);
    expect(response.body.error.code).toBe("MAIL_NOT_CONFIGURED");
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "DRAFT",
    );
  });

  it("gửi email kèm tệp Excel rồi mới chuyển sang Đã gửi", async () => {
    const sentMail: Array<{ to: string; subject: string; attachments: number; html: string }> = [];
    const fake = nodemailer.createTransport({ jsonTransport: true });
    const original = fake.sendMail.bind(fake);
    fake.sendMail = (async (message: Parameters<typeof fake.sendMail>[0]) => {
      sentMail.push({
        to: String(message.to),
        subject: String(message.subject),
        attachments: message.attachments?.length ?? 0,
        html: String(message.html),
      });
      return original(message);
    }) as typeof fake.sendMail;
    setMailTransportForTests(fake);

    const order = await draft();
    const sent = await call("post", `/purchase-orders/${order.id}/send`, admin, {
      channel: "EMAIL",
      to: "donhang@duoca.vn",
      message: "Nhờ anh giao trước thứ Sáu.",
    }).expect(200);
    expect(sent.body.data).toMatchObject({
      status: "SENT",
      sentVia: "EMAIL",
      sentTo: "donhang@duoca.vn",
    });
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]!.subject).toContain(order.code);
    expect(sentMail[0]!.attachments).toBe(1);
    expect(sentMail[0]!.html).toContain("Nhờ anh giao trước thứ Sáu.");
    expect(sentMail[0]!.html).toContain("Paracetamol 500mg");
  });

  it("in đơn và tải Excel", async () => {
    const order = await draft();
    const print = await call(
      "get",
      `/purchase-orders/${order.id}/print?autoprint=0`,
      pharmacist,
    ).expect(200);
    expect(print.text).toContain("ĐƠN ĐẶT HÀNG");
    expect(print.text).toContain("Bản nháp");
    const excel = await call("get", `/purchase-orders/${order.id}/excel`, pharmacist)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((excel.body as Buffer).subarray(0, 2).toString()).toBe("PK");
  });
});

describe("Nhận hàng từ đơn", () => {
  it("nhận thiếu là Nhận một phần, nhận đủ là Đã nhận đủ; dòng không đạt không tính", async () => {
    const order = await draft();
    await call("post", `/purchase-orders/${order.id}/send`, admin, { channel: "MANUAL" }).expect(
      200,
    );

    // Không đạt kiểm nhập: chưa tính là đã nhận.
    await receive(
      order.id,
      [{ productId: vitamin.productId, unitId: vitamin.unitId, quantity: 10 }],
      false,
    );
    let detail = (await call("get", `/purchase-orders/${order.id}`, pharmacist).expect(200)).body
      .data;
    expect(detail.status).toBe("SENT");

    // Một hộp + 50 viên = 150/200 viên; vitamin đủ.
    await receive(order.id, [
      { productId: paracetamol.productId, unitId: paracetamol.boxId, quantity: 1 },
      { productId: vitamin.productId, unitId: vitamin.unitId, quantity: 10 },
    ]);
    await receive(order.id, [
      { productId: paracetamol.productId, unitId: paracetamol.tabletId, quantity: 50 },
    ]);
    detail = (await call("get", `/purchase-orders/${order.id}`, pharmacist).expect(200)).body.data;
    expect(detail.status).toBe("PARTIAL");
    expect(detail.lines[0]).toMatchObject({
      receivedBaseQuantity: 150,
      remainingBaseQuantity: 50,
      remainingQuantity: 1,
    });
    expect(detail.goodsReceipts).toHaveLength(3);

    await receive(order.id, [
      { productId: paracetamol.productId, unitId: paracetamol.tabletId, quantity: 50 },
    ]);
    detail = (await call("get", `/purchase-orders/${order.id}`, pharmacist).expect(200)).body.data;
    expect(detail.status).toBe("RECEIVED");
    await call("post", `/purchase-orders/${order.id}/cancel`, admin, { reason: "x" }).expect(409);
  });

  it("không lập phiếu nhập từ đơn nháp, đơn của nhà cung cấp khác", async () => {
    const order = await draft();
    const line = {
      productId: vitamin.productId,
      unitId: vitamin.unitId,
      quantity: 1,
      unitCost: 1,
      batchNumber: "L1",
      expiryDate: "2028-01-01",
    };
    await call("post", "/goods-receipts", admin, {
      supplierId,
      purchaseOrderId: order.id,
      lines: [line],
    }).expect(409);
    await call("post", `/purchase-orders/${order.id}/send`, admin, { channel: "MANUAL" }).expect(
      200,
    );
    await call("post", "/goods-receipts", admin, {
      supplierId: otherSupplierId,
      purchaseOrderId: order.id,
      lines: [line],
    }).expect(422);
  });

  it("đơn của cửa hàng khác không thấy được", async () => {
    const order = await draft();
    await api()
      .get(`/api/v1/purchase-orders/${order.id}`)
      .set(authHeaders(admin, f.otherStoreId))
      .expect(404);
  });
});
