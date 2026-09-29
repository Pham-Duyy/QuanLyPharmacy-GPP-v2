import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../../test/helpers.js";
import { startStubServer, type StubServer } from "../../test/nds-stub-server.js";

const BASE = "/api/v1/national-sync";

/** Hình dạng payload gửi lên, dùng để khẳng định trong test. */
type SentItem = {
  drug_id: string;
  unit_id: string;
  quantity: number;
  batch_no: string;
  expiry_date: string;
  gtin?: string;
  price?: number;
  system_quantity?: number;
  actual_quantity?: number;
};
type SentPayload = {
  reason?: string;
  reference_number?: string;
  supplier_id?: string;
  transaction_date?: string;
  items: SentItem[];
};
const payloadOf = (entry: { body: unknown }): SentPayload => entry.body as SentPayload;

type MappingItem = {
  code: string;
  link: { matchedBy: string; usable: boolean; confirmedAt: string | null } | null;
};
const USERNAME = "0101234567-001";
const PASSWORD = "MatKhauLienThong@1";

/** Hai thuốc trong danh mục quốc gia: một khớp số đăng ký, một chỉ khớp tên. */
const NATIONAL_DRUGS = [
  {
    id: "D0001",
    name: "Paracetamol 500mg",
    registration_number: "VD-12345-17",
    active_pharmaceutical_ingredient: "Paracetamol",
    strength: "500mg",
    prescription_status: 0,
    special_control_type: 0,
    packagings: [{ unit_id: "U01", unit_name: "Viên", gtin: "8931234567890" }],
    manufacturer: { id: "M01", name: "Công ty Dược Hậu Giang", country: "VN" },
    last_update_time: "2026-09-01T00:00:00Z",
  },
  {
    id: "D0002",
    name: "Amlodipin 5mg",
    registration_number: "VD-99999-21",
    active_pharmaceutical_ingredient: "Amlodipin",
    strength: "5mg",
    prescription_status: 1,
    special_control_type: 0,
    packagings: [{ unit_id: "U01", unit_name: "Viên", gtin: "8939876543210" }],
    manufacturer: { id: "M02", name: "Traphaco", country: "VN" },
    last_update_time: "2026-09-02T00:00:00Z",
  },
];

let fixture: Fixture;
let adminToken: string;
let salesToken: string;
let stub: StubServer;

function h(token = adminToken, storeId: string | undefined = fixture.storeId) {
  return authHeaders(token, storeId);
}

async function configure(overrides: Record<string, unknown> = {}) {
  return api()
    .patch(`${BASE}/config`)
    .set(h())
    .send({ enabled: true, environment: "SANDBOX", username: USERNAME, password: PASSWORD, ...overrides })
    .expect(200);
}

/** Một mặt hàng kèm đơn vị cơ bản và một lô còn hàng. */
async function seedProduct(input: {
  code: string;
  name: string;
  registrationNumber?: string | null;
  batchNumber?: string;
  quantity?: number;
}) {
  const category = await prisma.category.upsert({
    where: { id: "00000000-0000-0000-0000-0000000000c1" },
    create: { id: "00000000-0000-0000-0000-0000000000c1", name: "Thuốc thường" },
    update: {},
  });

  const product = await prisma.product.create({
    data: {
      code: input.code,
      name: input.name,
      productType: "DRUG",
      drugClass: "OTC",
      categoryId: category.id,
      registrationNumber: input.registrationNumber ?? null,
      manufacturer: "Công ty Dược Hậu Giang",
      countryOfOrigin: "VN",
    },
  });

  const unit = await prisma.productUnit.create({
    data: { productId: product.id, name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true },
  });

  const batch = await prisma.batch.create({
    data: {
      storeId: fixture.storeId,
      productId: product.id,
      batchNumber: input.batchNumber ?? "LO-A1",
      expiryDate: new Date("2027-12-31T00:00:00.000Z"),
      quantityOnHand: input.quantity ?? 100,
      unitCost: "1200.0000",
    },
  });

  return { product, unit, batch };
}

async function seedInvoice(
  product: { id: string; name: string },
  unit: { id: string; name: string },
  batch: { id: string },
  code = "HD-NT01-20260929-0001",
) {
  const invoice = await prisma.invoice.create({
    data: {
      storeId: fixture.storeId,
      code,
      sellerId: fixture.salesId,
      soldAt: new Date("2026-09-29T03:00:00.000Z"),
      businessDate: new Date("2026-09-29T00:00:00.000Z"),
      status: "COMPLETED",
      subtotal: 30_000n,
      totalAmount: 30_000n,
    },
  });

  const line = await prisma.invoiceLine.create({
    data: {
      invoiceId: invoice.id,
      lineNo: 1,
      productId: product.id,
      productUnitId: unit.id,
      productName: product.name,
      unitName: unit.name,
      conversionToBase: 1,
      quantity: 10,
      baseQuantity: 10,
      unitPrice: 3_000n,
      vatRatePercent: "5.00",
      lineTotal: 30_000n,
    },
  });

  await prisma.invoiceAllocation.create({
    data: {
      invoiceLineId: line.id,
      storeId: fixture.storeId,
      batchId: batch.id,
      baseQuantity: 10,
      unitCost: "1200.0000",
      unitCostSource: "ACTUAL",
    },
  });

  return invoice;
}

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
  salesToken = (await login("banhang")).token;

  stub = await startStubServer({
    username: USERNAME,
    password: PASSWORD,
    units: [
      { id: "U01", name: "Viên" },
      { id: "U02", name: "Hộp" },
    ],
    drugs: NATIONAL_DRUGS,
  });
  process.env["NDS_BASE_URL"] = stub.baseUrl;
});

afterEach(async () => {
  delete process.env["NDS_BASE_URL"];
  await stub.close();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Liên thông CSDL Dược — cấu hình và xác thực", () => {
  it("không trả mật khẩu ra ngoài, chỉ cho biết đã lưu hay chưa", async () => {
    await configure();
    const response = await api().get(`${BASE}/config`).set(h()).expect(200);

    expect(response.body.data.hasPassword).toBe(true);
    expect(response.body.data.username).toBe(USERNAME);
    expect(JSON.stringify(response.body)).not.toContain(PASSWORD);
  });

  it("lưu mật khẩu dưới dạng mã hóa, không lưu thô trong CSDL", async () => {
    await configure();
    const row = await prisma.nationalSyncConfig.findUniqueOrThrow({ where: { id: true } });

    expect(row.passwordCipher).toBeTruthy();
    expect(row.passwordCipher).not.toContain(PASSWORD);
  });

  it("không cho bật liên thông khi chưa có tài khoản", async () => {
    const response = await api()
      .patch(`${BASE}/config`)
      .set(h())
      .send({ enabled: true })
      .expect(422);

    expect(response.body.error.message).toContain("tài khoản");
  });

  it("đăng nhập đúng đặc tả: form-urlencoded và mật khẩu base64", async () => {
    await configure();
    await api().post(`${BASE}/test-connection`).set(h()).send({}).expect(200);

    const loginRequest = stub.requests.find((entry) => entry.path === "/v2/auth/login");
    expect(loginRequest).toBeDefined();
    const form = new URLSearchParams(String(loginRequest!.body));
    expect(form.get("username")).toBe(USERNAME);
    expect(Buffer.from(form.get("password")!, "base64").toString("utf8")).toBe(PASSWORD);
  });

  it("báo lỗi rõ ràng khi sai mật khẩu", async () => {
    await configure({ password: "SaiMatKhau@9" });
    const response = await api().post(`${BASE}/test-connection`).set(h()).send({}).expect(422);

    expect(response.body.error.code).toBe("NDS_AUTH");
  });

  it("nhân viên bán hàng không được xem hay sửa cấu hình", async () => {
    await api().get(`${BASE}/config`).set(h(salesToken)).expect(403);
    await api().patch(`${BASE}/config`).set(h(salesToken)).send({ enabled: false }).expect(403);
  });
});

describe("Liên thông CSDL Dược — danh mục và ghép mã", () => {
  it("kéo danh mục thuốc và đơn vị tính về máy", async () => {
    await configure();
    const response = await api().post(`${BASE}/master-sync`).set(h()).send({ full: true }).expect(200);

    expect(response.body.data.drugs).toBe(2);
    expect(response.body.data.units).toBe(2);
    expect(await prisma.nationalDrug.count()).toBe(2);
    expect(await prisma.nationalUnit.count()).toBe(2);
  });

  it("ghép theo số đăng ký thì dùng được ngay, ghép theo tên thì phải xác nhận", async () => {
    await configure();
    await api().post(`${BASE}/master-sync`).set(h()).send({ full: true }).expect(200);

    // Một mặt hàng có số đăng ký khớp, một chỉ trùng tên.
    await seedProduct({ code: "TH001", name: "Paracetamol 500mg", registrationNumber: "VD-12345-17" });
    await seedProduct({ code: "TH002", name: "Amlodipin 5mg" });

    const matched = await api().post(`${BASE}/auto-match`).set(h()).send({}).expect(200);
    expect(matched.body.data.matchedByRegistration).toBe(1);
    expect(matched.body.data.matchedByName).toBe(1);

    const mapping = await api().get(`${BASE}/mapping`).set(h()).expect(200);
    const byCode = new Map((mapping.body.data.items as MappingItem[]).map((row) => [row.code, row]));

    expect(byCode.get("TH001")!.link!.matchedBy).toBe("REGISTRATION_NUMBER");
    expect(byCode.get("TH001")!.link!.usable).toBe(true);
    expect(byCode.get("TH002")!.link!.matchedBy).toBe("NAME");
    expect(byCode.get("TH002")!.link!.usable).toBe(false);
    expect(mapping.body.data.summary.needsReview).toBe(1);
  });

  it("số đăng ký khác cách viết hoa và dấu gạch vẫn khớp", async () => {
    await configure();
    await api().post(`${BASE}/master-sync`).set(h()).send({ full: true }).expect(200);
    await seedProduct({ code: "TH003", name: "Tên khác hẳn", registrationNumber: "vd 12345 17" });

    const matched = await api().post(`${BASE}/auto-match`).set(h()).send({}).expect(200);
    expect(matched.body.data.matchedByRegistration).toBe(1);
  });

  it("xác nhận xong thì mã ghép theo tên mới dùng được", async () => {
    await configure();
    await api().post(`${BASE}/master-sync`).set(h()).send({ full: true }).expect(200);
    const { product } = await seedProduct({ code: "TH002", name: "Amlodipin 5mg" });
    await api().post(`${BASE}/auto-match`).set(h()).send({}).expect(200);

    await api().post(`${BASE}/mapping/${product.id}/confirm`).set(h()).send({}).expect(200);

    const mapping = await api().get(`${BASE}/mapping`).set(h()).expect(200);
    expect(mapping.body.data.items[0].link.usable).toBe(true);
    expect(mapping.body.data.summary.needsReview).toBe(0);
  });

  it("xác nhận hàng loạt chỉ tác động đúng những mặt hàng được gửi lên", async () => {
    await configure();
    await api().post(`${BASE}/master-sync`).set(h()).send({ full: true }).expect(200);
    const first = await seedProduct({ code: "TH002", name: "Amlodipin 5mg" });
    const second = await seedProduct({ code: "TH001", name: "Paracetamol 500mg" });
    await api().post(`${BASE}/auto-match`).set(h()).send({}).expect(200);

    // Chỉ xác nhận mặt hàng thứ nhất.
    const result = await api()
      .post(`${BASE}/mapping/confirm-many`)
      .set(h())
      .send({ productIds: [first.product.id] })
      .expect(200);
    expect(result.body.data.confirmed).toBe(1);

    const mapping = await api().get(`${BASE}/mapping`).set(h()).expect(200);
    const byCode = new Map((mapping.body.data.items as MappingItem[]).map((row) => [row.code, row]));
    expect(byCode.get("TH002")!.link!.usable).toBe(true);
    // Mặt hàng không được gửi lên vẫn giữ nguyên trạng thái chờ.
    expect(byCode.get("TH001")!.link!.confirmedAt).toBeNull();
    expect(second.product.id).toBeTruthy();

    // Gọi lại không nhân đôi: những dòng đã xác nhận rồi thì bỏ qua.
    const again = await api()
      .post(`${BASE}/mapping/confirm-many`)
      .set(h())
      .send({ productIds: [first.product.id] })
      .expect(200);
    expect(again.body.data.confirmed).toBe(0);
  });

  it("không ghép bừa khi hai thuốc trùng tên", async () => {
    await configure();
    await prisma.nationalDrug.createMany({
      data: [
        { id: "X1", name: "Thuốc trùng tên", packagings: [{ unit_id: "U01", unit_name: "Viên" }] },
        { id: "X2", name: "Thuốc trùng tên", packagings: [{ unit_id: "U01", unit_name: "Viên" }] },
      ],
    });
    await prisma.nationalUnit.create({ data: { id: "U01", name: "Viên" } });
    await seedProduct({ code: "TH004", name: "Thuốc trùng tên" });

    const matched = await api().post(`${BASE}/auto-match`).set(h()).send({}).expect(200);
    expect(matched.body.data.matchedByName).toBe(0);
    expect(matched.body.data.unmatched).toBe(1);
  });
});

describe("Liên thông CSDL Dược — gửi chứng từ", () => {
  async function readyToSend() {
    await configure({ startDate: "2026-09-01" });
    await api().post(`${BASE}/master-sync`).set(h()).send({ full: true }).expect(200);
    const seeded = await seedProduct({
      code: "TH001",
      name: "Paracetamol 500mg",
      registrationNumber: "VD-12345-17",
    });
    await api().post(`${BASE}/auto-match`).set(h()).send({}).expect(200);
    return seeded;
  }

  it("quét ra hóa đơn đã hoàn tất và gửi lên đúng cấu trúc đặc tả", async () => {
    const { product, unit, batch } = await readyToSend();
    await seedInvoice(product, unit, batch);

    const scan = await api().post(`${BASE}/scan`).set(h()).send({}).expect(200);
    expect(scan.body.data.created).toBe(1);

    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);

    const sent = stub.requests.find((entry) => entry.path === "/v2/transactions/stock-out");
    expect(sent).toBeDefined();
    const payload = payloadOf(sent!);

    expect(payload.reason).toBe("sale-retail");
    expect(payload.reference_number).toBe("HD-NT01-20260929-0001");
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({
      drug_id: "D0001",
      unit_id: "U01",
      quantity: 10,
      batch_no: "LO-A1",
      expiry_date: "2027-12-31",
      gtin: "8931234567890",
    });
    // Giá quy về đơn vị cơ bản.
    expect(payload.items[0]!.price).toBe(3000);
    // Ngày giờ gửi kèm múi giờ Việt Nam, không phụ thuộc múi giờ máy chủ.
    expect(payload.transaction_date).toMatch(/\+07:00$/);
  });

  it("gửi số lượng theo đơn vị cơ bản khi bán theo hộp", async () => {
    await readyToSend();
    const product = await prisma.product.findFirstOrThrow({ where: { code: "TH001" } });
    const box = await prisma.productUnit.create({
      data: { productId: product.id, name: "Hộp", conversionToBase: 100 },
    });
    const batch = await prisma.batch.findFirstOrThrow({ where: { productId: product.id } });

    const invoice = await prisma.invoice.create({
      data: {
        storeId: fixture.storeId,
        code: "HD-NT01-20260929-0002",
        sellerId: fixture.salesId,
        soldAt: new Date("2026-09-29T04:00:00.000Z"),
        businessDate: new Date("2026-09-29T00:00:00.000Z"),
        status: "COMPLETED",
        subtotal: 250_000n,
        totalAmount: 250_000n,
      },
    });
    const line = await prisma.invoiceLine.create({
      data: {
        invoiceId: invoice.id,
        lineNo: 1,
        productId: product.id,
        productUnitId: box.id,
        productName: product.name,
        unitName: "Hộp",
        conversionToBase: 100,
        quantity: 2,
        baseQuantity: 200,
        unitPrice: 250_000n,
        vatRatePercent: "5.00",
        lineTotal: 500_000n,
      },
    });
    await prisma.invoiceAllocation.create({
      data: {
        invoiceLineId: line.id,
        storeId: fixture.storeId,
        batchId: batch.id,
        baseQuantity: 200,
        unitCost: "1200.0000",
        unitCostSource: "ACTUAL",
      },
    });

    await api().post(`${BASE}/scan`).set(h()).send({}).expect(200);
    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);

    const sent = stub.requests.filter((entry) => entry.path === "/v2/transactions/stock-out").at(-1);
    const item = payloadOf(sent!).items[0]!;
    // 2 hộp x 100 viên = 200 viên, đơn vị gửi lên là viên.
    expect(item.quantity).toBe(200);
    expect(item.unit_id).toBe("U01");
    // 250.000đ một hộp = 2.500đ một viên.
    expect(item.price).toBe(2500);
  });

  it("trừ phần khách đã trả lại khỏi số thực xuất", async () => {
    const { product, unit, batch } = await readyToSend();
    await seedInvoice(product, unit, batch);
    await prisma.invoiceAllocation.updateMany({ data: { returnedBaseQuantity: 4 } });

    await api().post(`${BASE}/scan`).set(h()).send({}).expect(200);
    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);

    const sent = stub.requests.find((entry) => entry.path === "/v2/transactions/stock-out");
    expect(payloadOf(sent!).items[0]!.quantity).toBe(6);
  });

  it("gửi phiếu nhập với lý do đúng theo loại phiếu", async () => {
    const { product, unit } = await readyToSend();
    const supplier = await prisma.supplier.create({
      data: { name: "Công ty Dược phẩm Trung ương", taxCode: "0100109106" },
    });
    const receipt = await prisma.goodsReceipt.create({
      data: {
        storeId: fixture.storeId,
        code: "PN-NT01-20260929-0001",
        type: "PURCHASE",
        supplierId: supplier.id,
        receivedAt: new Date("2026-09-29T02:00:00.000Z"),
        status: "CONFIRMED",
        createdBy: fixture.adminId,
      },
    });
    await prisma.goodsReceiptLine.create({
      data: {
        goodsReceiptId: receipt.id,
        lineNo: 1,
        productId: product.id,
        productUnitId: unit.id,
        quantity: 50,
        baseQuantity: 50,
        unitCost: 1_200n,
        lineCost: 60_000n,
        batchNumber: "LO-B2",
        expiryDate: new Date("2028-06-30T00:00:00.000Z"),
      },
    });

    await api().post(`${BASE}/scan`).set(h()).send({}).expect(200);
    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);

    const sent = stub.requests.find((entry) => entry.path === "/v2/transactions/stock-in");
    expect(payloadOf(sent!).reason).toBe("supplier");
    // Nhà cung cấp gửi lên bằng mã số thuế — định danh dùng chung với cơ quan quản lý.
    expect(payloadOf(sent!).supplier_id).toBe("0100109106");
    expect(payloadOf(sent!).items[0]).toMatchObject({ batch_no: "LO-B2", quantity: 50 });
  });

  it("giữ lại chứng từ có mặt hàng chưa ghép mã, không gửi lên", async () => {
    await configure({ startDate: "2026-09-01" });
    const { product, unit, batch } = await seedProduct({ code: "TH009", name: "Thuốc chưa ghép mã" });
    await seedInvoice(product, unit, batch);

    await api().post(`${BASE}/scan`).set(h()).send({}).expect(200);
    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);

    const jobs = await api().get(`${BASE}/jobs`).set(h()).expect(200);
    expect(jobs.body.data.items[0].status).toBe("BLOCKED");
    expect(jobs.body.data.items[0].lastError).toContain("TH009");
    // Không có gì được gửi lên hệ thống quốc gia.
    expect(stub.requests.some((entry) => entry.path.startsWith("/v2/transactions"))).toBe(false);
  });

  it("theo dõi trạng thái cho tới khi hệ thống quốc gia xử lý xong", async () => {
    const { product, unit, batch } = await readyToSend();
    await seedInvoice(product, unit, batch);
    await api().post(`${BASE}/scan`).set(h()).send({}).expect(200);
    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);

    let jobs = await api().get(`${BASE}/jobs`).set(h()).expect(200);
    expect(jobs.body.data.items[0].status).toBe("ACCEPTED");
    const transactionId = jobs.body.data.items[0].remoteTransactionId as string;

    // Hệ thống quốc gia xử lý xong; hỏi lại phải cập nhật trạng thái.
    stub.setStatus(transactionId, "completed");
    await prisma.nationalSyncJob.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);

    jobs = await api().get(`${BASE}/jobs`).set(h()).expect(200);
    expect(jobs.body.data.items[0].status).toBe("COMPLETED");
    expect(jobs.body.data.items[0].settledAt).not.toBeNull();
  });

  it("ghi lại lời từ chối của hệ thống quốc gia kèm nội dung", async () => {
    const { product, unit, batch } = await readyToSend();
    await seedInvoice(product, unit, batch);
    await api().post(`${BASE}/scan`).set(h()).send({}).expect(200);
    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);

    const job = await prisma.nationalSyncJob.findFirstOrThrow();
    stub.setStatus(job.remoteTransactionId!, "rejected", ["Số lô không đúng định dạng"]);
    await prisma.nationalSyncJob.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);

    const jobs = await api().get(`${BASE}/jobs`).set(h()).expect(200);
    expect(jobs.body.data.items[0].status).toBe("REJECTED");
    expect(jobs.body.data.items[0].lastError).toContain("Số lô không đúng định dạng");
  });

  it("lỗi tạm thời thì hẹn thử lại, lỗi do dữ liệu thì dừng hẳn", async () => {
    const { product, unit, batch } = await readyToSend();
    await seedInvoice(product, unit, batch);
    await api().post(`${BASE}/scan`).set(h()).send({}).expect(200);

    // 500: lỗi phía họ, phải thử lại.
    stub.failNext(1, 500);
    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);
    let job = await prisma.nationalSyncJob.findFirstOrThrow();
    expect(job.status).toBe("FAILED");
    expect(job.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // 400: dữ liệu không hợp lệ, thử lại cũng vô ích.
    await prisma.nationalSyncJob.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    stub.failNext(1, 400);
    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);
    job = await prisma.nationalSyncJob.findFirstOrThrow();
    expect(job.status).toBe("REJECTED");
    expect(job.settledAt).not.toBeNull();
  });

  it("bị chặn tần suất thì dừng cả lượt, không gửi dồn tiếp", async () => {
    const { product, unit, batch } = await readyToSend();
    await seedInvoice(product, unit, batch, "HD-NT01-20260929-0001");
    await seedInvoice(product, unit, batch, "HD-NT01-20260929-0002");
    await api().post(`${BASE}/scan`).set(h()).send({}).expect(200);
    expect(await prisma.nationalSyncJob.count()).toBe(2);

    // 429 ở chứng từ đầu tiên: phải dừng ngay, chứng từ sau giữ nguyên hàng chờ.
    stub.failNext(1, 429);
    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);

    const failed = await prisma.nationalSyncJob.count({ where: { status: "FAILED" } });
    const stillPending = await prisma.nationalSyncJob.count({ where: { status: "PENDING" } });
    expect(failed).toBe(1);
    expect(stillPending).toBe(1);
    // Không có chứng từ nào được hệ thống quốc gia nhận trong lượt này.
    expect(stub.submissions.size).toBe(0);
  });

  it("token hết hạn giữa chừng thì tự đăng nhập lại đúng một lần", async () => {
    const { product, unit, batch } = await readyToSend();
    await seedInvoice(product, unit, batch);
    await api().post(`${BASE}/scan`).set(h()).send({}).expect(200);

    const before = stub.loginCount();
    stub.expireTokens();
    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);

    expect(stub.loginCount()).toBe(before + 1);
    const job = await prisma.nationalSyncJob.findFirstOrThrow();
    expect(job.status).toBe("ACCEPTED");
  });

  it("không gửi trùng một chứng từ dù quét nhiều lần", async () => {
    const { product, unit, batch } = await readyToSend();
    await seedInvoice(product, unit, batch);

    await api().post(`${BASE}/scan`).set(h()).send({}).expect(200);
    await api().post(`${BASE}/scan`).set(h()).send({}).expect(200);
    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);
    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);

    expect(await prisma.nationalSyncJob.count()).toBe(1);
    const submits = stub.requests.filter((entry) => entry.path === "/v2/transactions/stock-out");
    expect(submits).toHaveLength(1);
  });

  it("hóa đơn bị hủy sau khi đã gửi thì đánh dấu cần xử lý tay, không tự suy diễn", async () => {
    const { product, unit, batch } = await readyToSend();
    const invoice = await seedInvoice(product, unit, batch);
    await api().post(`${BASE}/scan`).set(h()).send({}).expect(200);
    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);
    expect((await prisma.nationalSyncJob.findFirstOrThrow()).status).toBe("ACCEPTED");

    // Dược sĩ hủy hóa đơn sau khi dữ liệu đã lên hệ thống quốc gia.
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "VOIDED" } });
    const scan = await api().post(`${BASE}/scan`).set(h()).send({}).expect(200);
    expect(scan.body.data.needsReview).toBe(1);

    const job = await prisma.nationalSyncJob.findFirstOrThrow();
    expect(job.status).toBe("NEEDS_REVIEW");
    expect(job.lastError).toContain("csdlduoc.com.vn");
    // Không bịa ra chứng từ ngược để "gỡ" hóa đơn đã gửi.
    expect(stub.submissions.size).toBe(1);
  });

  it("bỏ qua chứng từ phát sinh trước ngày bắt đầu liên thông", async () => {
    const { product, unit, batch } = await readyToSend();
    await api()
      .patch(`${BASE}/config`)
      .set(h())
      .send({ startDate: "2026-09-30" })
      .expect(200);
    await seedInvoice(product, unit, batch);

    const scan = await api().post(`${BASE}/scan`).set(h()).send({}).expect(200);
    expect(scan.body.data.created).toBe(0);
  });

  it("gửi lại bằng tay đưa chứng từ về hàng chờ", async () => {
    const { product, unit, batch } = await readyToSend();
    await seedInvoice(product, unit, batch);
    await api().post(`${BASE}/scan`).set(h()).send({}).expect(200);
    stub.failNext(1, 400);
    await api().post(`${BASE}/drain`).set(h()).send({}).expect(200);

    const job = await prisma.nationalSyncJob.findFirstOrThrow();
    expect(job.status).toBe("REJECTED");

    await api().post(`${BASE}/jobs/${job.id}/retry`).set(h()).send({}).expect(200);
    const after = await prisma.nationalSyncJob.findFirstOrThrow();
    expect(after.status).toBe("PENDING");
  });
});

describe("Liên thông CSDL Dược — tồn đầu kỳ", () => {
  it("gửi tồn đầu kỳ rồi chốt mốc liên thông, không cho gửi lần hai", async () => {
    await configure();
    await api().post(`${BASE}/master-sync`).set(h()).send({ full: true }).expect(200);
    await seedProduct({
      code: "TH001",
      name: "Paracetamol 500mg",
      registrationNumber: "VD-12345-17",
      quantity: 250,
    });
    await api().post(`${BASE}/auto-match`).set(h()).send({}).expect(200);

    const created = await api()
      .post(`${BASE}/opening-stock-taking`)
      .set(h())
      .send({})
      .expect(201);
    expect(created.body.data.items).toBe(1);

    const sent = stub.requests.find((entry) => entry.path === "/v2/transactions/stock-taking");
    expect(payloadOf(sent!).items[0]).toMatchObject({
      drug_id: "D0001",
      quantity: 250,
      system_quantity: 250,
      actual_quantity: 250,
    });

    // Mốc liên thông được chốt để lượt quét biết bắt đầu từ đâu.
    const config = await api().get(`${BASE}/config`).set(h()).expect(200);
    expect(config.body.data.startDate).not.toBeNull();

    const second = await api().post(`${BASE}/opening-stock-taking`).set(h()).send({}).expect(409);
    expect(second.body.error.message).toContain("đã gửi");
  });

  it("chặn gửi tồn đầu kỳ khi còn mặt hàng chưa ghép mã", async () => {
    await configure();
    await seedProduct({ code: "TH009", name: "Thuốc chưa ghép mã" });

    const response = await api().post(`${BASE}/opening-stock-taking`).set(h()).send({}).expect(409);
    expect(response.body.error.message).toContain("TH009");
  });
});
