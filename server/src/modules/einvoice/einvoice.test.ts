import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  type Fixture,
} from "../../test/helpers.js";
import { startMisaStub, type MisaStub } from "../../test/misa-stub-server.js";

const BASE = "/api/v1/einvoices";
const ACCOUNT = {
  appId: "APP-TEST",
  taxCode: "0101234567",
  username: "nhathuoc1",
  password: "MisaMatKhau@1",
};
const OTHER = {
  appId: "APP-TEST",
  taxCode: "0109876543",
  username: "nhathuoc2",
  password: "MisaMatKhau@2",
};

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let stub: MisaStub;

const h = (token = adminToken, storeId: string | undefined = fixture.storeId) =>
  authHeaders(token, storeId);
const idem = () => ({ "Idempotency-Key": randomUUID() });

function configure(body: Record<string, unknown> = {}, storeId = fixture.storeId) {
  return api()
    .patch(`${BASE}/config`)
    .set(h(adminToken, storeId))
    .send({
      environment: "SANDBOX",
      appId: ACCOUNT.appId,
      taxCode: ACCOUNT.taxCode,
      username: ACCOUNT.username,
      password: ACCOUNT.password,
      invSeries: "1C26MAB",
      enabled: true,
      ...body,
    });
}

const run = (storeId = fixture.storeId) =>
  api().post(`${BASE}/run`).set(h(adminToken, storeId)).send({}).expect(200);
const list = async (storeId = fixture.storeId) =>
  (await api().get(BASE).set(h(adminToken, storeId)).expect(200)).body.data;

/** Thuốc VAT 5%, giá đã gồm thuế 10.500đ/viên, còn 100 viên. */
async function makeProduct(code = "TH0001") {
  const category = await prisma.category.create({ data: { name: `Nhóm ${code}` } });
  const product = await prisma.product.create({
    data: {
      code,
      name: `Paracetamol ${code}`,
      productType: "DRUG",
      drugClass: "OTC",
      categoryId: category.id,
      units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  const unitId = product.units[0]!.id;
  await prisma.productPrice.create({
    data: {
      productUnitId: unitId,
      salePrice: 10_500n,
      vatRatePercent: 5,
      effectiveFrom: new Date("2026-01-01"),
    },
  });
  await prisma.batch.create({
    data: {
      storeId: fixture.storeId,
      productId: product.id,
      batchNumber: `L-${code}`,
      expiryDate: new Date("2028-12-31"),
      quantityOnHand: 100,
      unitCost: 6000,
    },
  });
  return { id: product.id, unitId };
}

async function sell(
  product: { id: string; unitId: string },
  quantity: number,
  extra: Record<string, unknown> = {},
) {
  const response = await api()
    .post("/api/v1/invoices")
    .set({ ...h(pharmacistToken), ...idem() })
    .send({ lines: [{ productId: product.id, unitId: product.unitId, quantity }], ...extra })
    .expect(201);
  return response.body.data as {
    id: string;
    code: string;
    totalAmount: string | number;
    vatAmount: string | number;
  };
}

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
  pharmacistToken = (await login("duocsi")).token;
  stub = await startMisaStub([ACCOUNT, OTHER]);
  process.env["EINVOICE_BASE_URL"] = stub.baseUrl;
});

afterEach(async () => {
  delete process.env["EINVOICE_BASE_URL"];
  await stub.close();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Hóa đơn điện tử — cấu hình", () => {
  it("không trả mật khẩu ra ngoài, lưu dạng mã hóa", async () => {
    await configure().expect(200);
    const view = await api().get(`${BASE}/config`).set(h()).expect(200);
    expect(view.body.data).toMatchObject({
      enabled: true,
      hasPassword: true,
      invSeries: "1C26MAB",
    });
    expect(JSON.stringify(view.body)).not.toContain(ACCOUNT.password);
    const row = await prisma.eInvoiceStoreConfig.findUniqueOrThrow({
      where: { storeId: fixture.storeId },
    });
    expect(row.passwordCipher).toBeTruthy();
    expect(row.passwordCipher).not.toContain(ACCOUNT.password);
    expect(row.enabledFrom).not.toBeNull();
  });

  it("không bật khi thiếu thông tin; kiểm tra định dạng MST và ký hiệu máy tính tiền", async () => {
    const missing = await api()
      .patch(`${BASE}/config`)
      .set(h())
      .send({ enabled: true })
      .expect(422);
    expect(missing.body.error.message).toContain("ký hiệu");
    await configure({ invSeries: "1C26TAB" }).expect(422); // ký tự thứ 4 phải là M
    await configure({ taxCode: "12345" }).expect(422);
  });

  it("phải chọn cửa hàng; dược sĩ xem được nhưng không sửa được", async () => {
    await api().get(`${BASE}/config`).set(authHeaders(adminToken)).expect(400);
    await api().get(`${BASE}/config`).set(h(pharmacistToken)).expect(200);
    await api()
      .patch(`${BASE}/config`)
      .set(h(pharmacistToken))
      .send({ enabled: false })
      .expect(403);
  });

  it("kiểm tra kết nối: đúng tài khoản thì được, sai mật khẩu thì báo rõ", async () => {
    await configure().expect(200);
    await api().post(`${BASE}/test-connection`).set(h()).send({}).expect(200);
    await configure({ password: "SaiMatKhau@9" }).expect(200);
    const response = await api().post(`${BASE}/test-connection`).set(h()).send({}).expect(422);
    expect(response.body.error.code).toBe("EINVOICE_AUTH");
  });
});

describe("Hóa đơn điện tử — phát hành", () => {
  it("phát hành đúng cấu trúc, tổng dòng khớp tổng hóa đơn, rồi nhận mã cơ quan thuế", async () => {
    await configure().expect(200);
    const product = await makeProduct();
    const invoice = await sell(product, 3);

    await run();
    const sent = stub.submissions.get(invoice.id)!;
    expect(sent).toBeDefined();
    expect(sent.taxCode).toBe(ACCOUNT.taxCode);
    expect(sent.payload).toMatchObject({
      RefID: invoice.id,
      InvSeries: "1C26MAB",
      IsInvoiceCalculatingMachine: true,
      CurrencyCode: "VND",
      PaymentMethodName: "Tiền mặt",
      TotalAmount: 31_500,
      TotalVATAmount: 1_500,
      TotalAmountWithoutVAT: 30_000,
    });
    const [line] = sent.payload["OriginalInvoiceDetail"] as Array<Record<string, unknown>>;
    expect(line).toMatchObject({
      ItemType: 1,
      LineNumber: 1,
      ItemCode: "TH0001",
      Quantity: 3,
      UnitPrice: 10_000,
      Amount: 30_000,
      VATRateName: "5%",
      VATAmount: 1_500,
    });

    let data = await list();
    expect(data.items[0]).toMatchObject({
      status: "PUBLISHED",
      invSeries: "1C26MAB",
      taxAuthorityCode: null,
    });

    const pending = await api()
      .get(`/api/v1/invoices/${invoice.id}/print?autoprint=0`)
      .set(h())
      .expect(200);
    expect(pending.text).toContain("đang chờ mã cơ quan thuế");
    expect(pending.text).not.toContain("Mã CQT");

    stub.setTaxStatus(invoice.id, 2, "M1-26-ABCDE-00000000001");
    await run();

    data = await list();
    expect(data.items[0]).toMatchObject({
      status: "COMPLETED",
      taxAuthorityCode: "M1-26-ABCDE-00000000001",
    });
    const printed = await api()
      .get(`/api/v1/invoices/${invoice.id}/print?autoprint=0`)
      .set(h())
      .expect(200);
    expect(printed.text).toContain("Mã CQT: M1-26-ABCDE-00000000001");
    expect(printed.text).toContain("Ký hiệu 1C26MAB");
  });

  it("giảm giá đã nằm trong thành tiền: không trừ hai lần, tổng vẫn khớp", async () => {
    await configure().expect(200);
    const product = await makeProduct();
    const invoice = await sell(product, 3, {
      discount: { type: "AMOUNT", value: 1_500, reason: "Khách quen" },
    });
    await run();
    const payload = stub.submissions.get(invoice.id)!.payload;
    const lines = payload["OriginalInvoiceDetail"] as Array<{ Amount: number; VATAmount: number }>;
    expect(payload["TotalAmount"]).toBe(30_000);
    expect(lines.reduce((sum, item) => sum + item.Amount + item.VATAmount, 0)).toBe(30_000);
    expect(payload["TotalDiscountAmount"]).toBe(0);
  });

  it("không phát hành hồi tố hóa đơn bán trước khi bật", async () => {
    const product = await makeProduct();
    await sell(product, 1);
    await configure().expect(200);
    await run();
    expect(stub.submissions.size).toBe(0);
    expect((await list()).items).toHaveLength(0);
  });

  it("cơ quan thuế từ chối cấp mã thì ghi nhận bị từ chối", async () => {
    await configure().expect(200);
    const invoice = await sell(await makeProduct(), 1);
    await run();
    stub.setTaxStatus(invoice.id, 3);
    await run();
    expect((await list()).items[0]).toMatchObject({ status: "REJECTED" });
  });

  it("MISA từ chối dữ liệu thì dừng hẳn; sửa xong gửi lại bằng tay", async () => {
    await configure().expect(200);
    const invoice = await sell(await makeProduct(), 1);
    stub.rejectNextPublish("InvalidInvSeries");
    await run();
    const rejected = (await list()).items[0];
    expect(rejected).toMatchObject({ status: "REJECTED" });
    expect(rejected.lastError).toContain("InvalidInvSeries");

    await api().post(`${BASE}/${rejected.id}/retry`).set(h()).send({}).expect(200);
    await run();
    expect((await list()).items[0]).toMatchObject({ status: "PUBLISHED" });
    expect(stub.submissions.has(invoice.id)).toBe(true);
  });

  it("mất phản hồi sau khi MISA đã nhận: lần sau hỏi trạng thái, không phát hành trùng", async () => {
    await configure().expect(200);
    const invoice = await sell(await makeProduct(), 1);
    stub.loseNextPublishResponse();
    await run();
    expect((await list()).items[0]).toMatchObject({ status: "FAILED" });

    await prisma.eInvoice.updateMany({ data: { nextAttemptAt: new Date() } });
    await run();
    const item = (await list()).items[0];
    expect(item).toMatchObject({ status: "PUBLISHED" });
    expect(item.transactionId).toBe(stub.submissions.get(invoice.id)!.transactionId);
    expect(stub.submissions.size).toBe(1);
  });

  it("token hết hạn giữa chừng thì tự lấy token mới", async () => {
    await configure().expect(200);
    await sell(await makeProduct(), 1);
    await api().post(`${BASE}/test-connection`).set(h()).send({}).expect(200);
    stub.expireTokens();
    await run();
    expect((await list()).items[0]).toMatchObject({ status: "PUBLISHED" });
  });
});

describe("Hóa đơn điện tử — hóa đơn bán thay đổi", () => {
  it("hủy trước khi phát hành thì bỏ việc, không phát hành", async () => {
    const product = await makeProduct();
    await configure({ enabled: false, password: ACCOUNT.password }).expect(200);
    const invoice = await sell(product, 1);
    await configure().expect(200);
    // Mốc bật sau khi bán: đưa mốc lùi lại để hóa đơn thuộc diện phát hành.
    await prisma.eInvoiceStoreConfig.update({
      where: { storeId: fixture.storeId },
      data: { enabledFrom: new Date(Date.now() - 3_600_000) },
    });
    await prisma.eInvoice.create({ data: { storeId: fixture.storeId, invoiceId: invoice.id } });
    await api()
      .post(`/api/v1/invoices/${invoice.id}/void`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({ reason: "Bán nhầm" })
      .expect(200);
    await run();
    expect(stub.submissions.size).toBe(0);
    expect((await list()).items[0]).toMatchObject({ status: "CANCELLED" });
  });

  it("hủy sau khi đã phát hành thì đánh dấu cần xử lý, vẫn giữ trạng thái và mã", async () => {
    await configure().expect(200);
    const invoice = await sell(await makeProduct(), 1);
    await run();
    await api()
      .post(`/api/v1/invoices/${invoice.id}/void`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({ reason: "Khách đổi ý" })
      .expect(200);
    await run();
    const item = (await list()).items[0];
    expect(item.status).toBe("PUBLISHED");
    expect(item.reviewReason).toContain("điều chỉnh hoặc thay thế");
    expect((await list()).summary.needsReview).toBe(1);
  });
});

describe("Hóa đơn điện tử — theo từng cửa hàng", () => {
  it("cửa hàng khác không thấy và không thao tác được hóa đơn điện tử của cửa hàng này", async () => {
    await configure().expect(200);
    await sell(await makeProduct(), 1);
    await run();
    const mine = await list();
    expect(mine.items).toHaveLength(1);
    const other = await list(fixture.otherStoreId);
    expect(other.items).toHaveLength(0);
    await api()
      .post(`${BASE}/${mine.items[0].id}/retry`)
      .set(h(adminToken, fixture.otherStoreId))
      .send({})
      .expect(404);
  });

  it("cửa hàng chưa bật thì hóa đơn của cửa hàng đó không được phát hành", async () => {
    await configure().expect(200);
    await configure({ ...OTHER, enabled: false }, fixture.otherStoreId).expect(200);
    await sell(await makeProduct(), 1);
    await run(fixture.otherStoreId);
    expect(stub.submissions.size).toBe(0);
  });
});
