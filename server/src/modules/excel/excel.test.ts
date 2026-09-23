import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import type { Response as SuperResponse } from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../../test/helpers.js";

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let salesToken: string;
let categoryId: string;

const h = (token = adminToken) => authHeaders(token, fixture.storeId);

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [adminToken, pharmacistToken, salesToken] = await Promise.all([
    login("admin").then((item) => item.token),
    login("duocsi").then((item) => item.token),
    login("banhang").then((item) => item.token),
  ]);
  categoryId = (await prisma.category.create({ data: { name: "Giảm đau hạ sốt" } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Dựng tệp .xlsx từ tiêu đề và các dòng, như người dùng tự gõ trên Excel. */
async function xlsx(headers: string[], rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("Dữ liệu");
  ws.addRow(headers);
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function binary(res: unknown, callback: (error: Error | null, body: Buffer) => void) {
  const stream = res as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("end", () => callback(null, Buffer.concat(chunks)));
}

async function download(path: string, token = adminToken, status = 200): Promise<SuperResponse> {
  return api().get(path).set(h(token)).buffer(true).parse(binary).expect(status);
}

/** Đọc sheet thành mảng dòng (dòng 1 là tiêu đề). */
async function sheetRows(buffer: Buffer, sheet = 0): Promise<unknown[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = workbook.worksheets[sheet]!;
  const rows: unknown[][] = [];
  ws.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
  return rows;
}

function importFile(type: string, file: Buffer, mode: "preview" | "commit", token = adminToken) {
  return api().post(`/api/v1/excel/imports/${type}?mode=${mode}`).set(h(token)).attach("file", file, "du-lieu.xlsx");
}

const PRODUCT_HEADERS = ["Mã sản phẩm", "Tên sản phẩm", "Loại hàng", "Phân loại thuốc", "Nhóm hàng", "Hoạt chất", "Đơn vị cơ bản", "Giá bán đơn vị cơ bản", "Đơn vị lớn", "Quy đổi đơn vị lớn", "Giá bán đơn vị lớn", "Mã vạch đơn vị lớn", "VAT (%)"];

async function makeProduct(code: string, drugClass: string | null = "OTC") {
  return prisma.product.create({
    data: {
      code,
      name: `Thuốc ${code}`,
      productType: "DRUG",
      drugClass,
      categoryId,
      units: { create: [{ name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true }, { name: "Hộp", conversionToBase: 100 }] },
    },
    include: { units: true },
  });
}

const futureDate = (days: number) => {
  const date = new Date(Date.now() + days * 86_400_000);
  return `${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${date.getUTCFullYear()}`;
};

describe("Danh mục nhập/xuất Excel", () => {
  it("chỉ liệt kê loại mà tài khoản có quyền", async () => {
    const admin = (await api().get("/api/v1/excel/catalog").set(h()).expect(200)).body.data;
    expect(admin.imports.map((item: { type: string }) => item.type)).toEqual(["products", "suppliers", "customers", "opening-balance", "stock-count"]);
    expect(admin.exports.map((item: { type: string }) => item.type)).not.toContain("customers");
    expect(admin.exports.map((item: { type: string }) => item.type)).not.toContain("rx-sales");

    const sales = (await api().get("/api/v1/excel/catalog").set(h(salesToken)).expect(200)).body.data;
    expect(sales.imports.map((item: { type: string }) => item.type)).toEqual(["customers"]);
  });

  it("tệp mẫu có tiêu đề đánh dấu cột bắt buộc, dòng ví dụ và sheet hướng dẫn", async () => {
    const res = await download("/api/v1/excel/templates/products");
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    const rows = await sheetRows(res.body as Buffer);
    expect(rows[0]).toContain("Mã sản phẩm *");
    expect(rows.length).toBeGreaterThan(1);
    const guide = await sheetRows(res.body as Buffer, 1);
    expect(String(guide[0]?.[0])).toContain("Mẫu nhập");
  });

  it("tệp mẫu nhập lại được ngay (dòng ví dụ hợp lệ)", async () => {
    const template = (await download("/api/v1/excel/templates/products")).body as Buffer;
    const preview = (await importFile("products", template, "preview").expect(200)).body.data;
    expect(preview.issues).toEqual([]);
    expect(preview.validRows).toBe(preview.totalRows);
  });

  it("không có quyền thì không tải được mẫu", async () => {
    await api().get("/api/v1/excel/templates/opening-balance").set(h(salesToken)).expect(403);
    await api().get("/api/v1/excel/templates/khong-co").set(h()).expect(404);
  });
});

describe("Nhập danh mục sản phẩm", () => {
  it("xem trước báo lỗi từng ô, commit khi còn lỗi thì không ghi dòng nào", async () => {
    const file = await xlsx(PRODUCT_HEADERS, [
      ["TH0001", "Paracetamol 500mg", "Thuốc", "Không kê đơn", "Giảm đau hạ sốt", "Paracetamol", "Viên", 1000, "Hộp", 100, 90000, "8930000000017", 5],
      ["TH0002", "", "Thuốc", "", "Giảm đau hạ sốt", "", "Viên", "abc", "", "", "", "", ""],
      ["TH0001", "Trùng mã", "Thuốc", "Kê đơn", "Kháng sinh", "", "Viên", "", "", "", "", "", ""],
    ]);
    const preview = (await importFile("products", file, "preview").expect(200)).body.data;
    expect(preview.totalRows).toBe(3);
    expect(preview.validRows).toBe(1);
    const messages = preview.issues.map((issue: { row: number; column?: string; message: string }) => `${issue.row}|${issue.column}|${issue.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        "3|Tên sản phẩm|Bắt buộc nhập",
        expect.stringContaining("3|Phân loại thuốc|"),
        expect.stringContaining("3|Giá bán đơn vị cơ bản|"),
        expect.stringContaining("4|Mã sản phẩm|Mã sản phẩm trùng với dòng 2"),
      ]),
    );

    const commit = await importFile("products", file, "commit").expect(422);
    expect(commit.body.error.message).toContain("chưa có dòng nào được ghi");
    expect(await prisma.product.count()).toBe(0);
  });

  it("tạo mới đủ đơn vị, mã vạch, hoạt chất, nhóm hàng và giá; nhập lại thì cập nhật", async () => {
    const file = await xlsx(PRODUCT_HEADERS, [
      ["TH0001", "Paracetamol 500mg", "Thuốc", "Không kê đơn", "Giảm đau hạ sốt", "Paracetamol", "Viên", 1000, "Hộp", 100, 90000, "8930000000017", 5],
      ["TP0001", "Vitamin C 500mg", "Thực phẩm chức năng", "", "Vitamin & khoáng chất", "Acid ascorbic; Kẽm", "Viên", 1500, "", "", "", "", 8],
    ]);
    const preview = (await importFile("products", file, "preview").expect(200)).body.data;
    expect(preview).toMatchObject({ creates: 2, updates: 0, issueCount: 0 });
    expect(preview.notes.join(" ")).toContain("Vitamin & khoáng chất");

    const result = (await importFile("products", file, "commit").expect(200)).body.data;
    expect(result).toMatchObject({ created: 2, updated: 0 });

    const paracetamol = await prisma.product.findUniqueOrThrow({
      where: { code: "TH0001" },
      include: { units: { include: { barcodes: true, prices: true } }, ingredients: true },
    });
    expect(paracetamol.drugClass).toBe("OTC");
    expect(paracetamol.ingredients).toHaveLength(1);
    const box = paracetamol.units.find((unit) => unit.name === "Hộp")!;
    expect(box.conversionToBase).toBe(100);
    expect(box.barcodes[0]?.barcode).toBe("8930000000017");
    expect(Number(box.prices[0]?.salePrice)).toBe(90000);
    expect(await prisma.activeIngredient.count()).toBe(3);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "EXCEL_IMPORT" } });
    expect(audit.resourceType).toBe("products");

    // Nhập lại cùng tệp: cập nhật, không tạo thêm phiên bản giá khi giá không đổi.
    const again = (await importFile("products", file, "commit").expect(200)).body.data;
    expect(again).toMatchObject({ created: 0, updated: 2 });
    expect(await prisma.productPrice.count()).toBe(3);
  });

  it("không đổi được phân loại thuốc hay quy đổi đơn vị qua Excel", async () => {
    await makeProduct("TH0009", "RX");
    const file = await xlsx(PRODUCT_HEADERS, [["TH0009", "Đổi phân loại", "Thuốc", "Không kê đơn", "Giảm đau hạ sốt", "", "Viên", "", "Hộp", 50, "", "", ""]]);
    const preview = (await importFile("products", file, "preview").expect(200)).body.data;
    const columns = preview.issues.map((issue: { column: string }) => issue.column);
    expect(columns).toEqual(expect.arrayContaining(["Phân loại thuốc", "Quy đổi đơn vị lớn"]));
  });

  it("xuất danh mục rồi nhập lại bằng tài khoản không có quyền giá vẫn hợp lệ; đổi giá thì bị chặn", async () => {
    const file = await xlsx(PRODUCT_HEADERS, [["TH0001", "Paracetamol 500mg", "Thuốc", "Không kê đơn", "Giảm đau hạ sốt", "Paracetamol", "Viên", 1000, "Hộp", 100, 90000, "", 5]]);
    await importFile("products", file, "commit").expect(200);

    const exported = (await download("/api/v1/excel/exports/products")).body as Buffer;
    const rows = await sheetRows(exported);
    expect(rows[0]).toContain("Tồn bán được (cửa hàng đang chọn)");
    expect(rows[1]).toContain("Paracetamol 500mg");

    const roundTrip = (await importFile("products", exported, "preview", pharmacistToken).expect(200)).body.data;
    expect(roundTrip).toMatchObject({ issueCount: 0, updates: 1 });

    const changed = await xlsx(PRODUCT_HEADERS, [["TH0001", "Paracetamol 500mg", "Thuốc", "Không kê đơn", "Giảm đau hạ sốt", "", "Viên", 1200, "", "", "", "", ""]]);
    const blocked = (await importFile("products", changed, "preview", pharmacistToken).expect(200)).body.data;
    expect(blocked.issues[0].message).toContain("không có quyền đổi giá");
  });

  it("từ chối tệp không phải .xlsx và tệp thiếu cột bắt buộc", async () => {
    const csv = Buffer.from("Mã sản phẩm,Tên\nTH1,A", "utf8");
    const bad = await importFile("products", csv, "preview").expect(422);
    expect(bad.body.error.code).toBe("INVALID_FILE");

    const missing = await xlsx(["Mã sản phẩm", "Tên sản phẩm"], [["TH1", "A"]]);
    const preview = (await importFile("products", missing, "preview").expect(200)).body.data;
    expect(preview.missingColumns).toEqual(expect.arrayContaining(["Loại hàng", "Nhóm hàng", "Đơn vị cơ bản"]));
    await importFile("products", missing, "commit").expect(422);
  });

  it("nhân viên bán hàng không nhập được danh mục", async () => {
    const file = await xlsx(PRODUCT_HEADERS, []);
    await importFile("products", file, "preview", salesToken).expect(403);
  });
});

describe("Nhập nhà cung cấp và khách hàng", () => {
  it("nhà cung cấp: cập nhật theo mã số thuế, tạo mới khi chưa có", async () => {
    await prisma.supplier.create({ data: { name: "Công ty cũ", taxCode: "0301234567" } });
    const file = await xlsx(
      ["Tên nhà cung cấp", "Mã số thuế", "Điện thoại", "Trạng thái"],
      [
        ["Công ty CP Dược Minh Tâm", "0301234567", "02838123456", "Đang giao dịch"],
        ["Công ty TNHH Dược Hòa Bình", "", "", "Ngừng giao dịch"],
      ],
    );
    const result = (await importFile("suppliers", file, "commit").expect(200)).body.data;
    expect(result).toMatchObject({ created: 1, updated: 1 });
    const updated = await prisma.supplier.findFirstOrThrow({ where: { taxCode: "0301234567" } });
    expect(updated.name).toBe("Công ty CP Dược Minh Tâm");
    const created = await prisma.supplier.findFirstOrThrow({ where: { name: "Công ty TNHH Dược Hòa Bình" } });
    expect(created.isActive).toBe(false);
  });

  it("khách hàng: khớp theo số điện thoại, cấp mã mới, báo lỗi mã KH không tồn tại", async () => {
    const existing = await prisma.customer.create({ data: { fullName: "Trần Văn A", phone: "0901111222" } });
    const file = await xlsx(
      ["Mã KH", "Họ tên", "Số điện thoại", "Năm sinh", "Giới tính", "Email"],
      [
        ["", "Trần Văn An", "0901111222", 1980, "Nam", ""],
        ["", "Nguyễn Thị Mai", "0902222333", 1990, "Nữ", "mai@example.com"],
      ],
    );
    const result = (await importFile("customers", file, "commit", salesToken).expect(200)).body.data;
    expect(result).toMatchObject({ created: 1, updated: 1 });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: existing.id } })).fullName).toBe("Trần Văn An");
    const mai = await prisma.customer.findFirstOrThrow({ where: { phone: "0902222333" } });
    expect(mai.code).toMatch(/^KH\d{5}$/);

    const bad = await xlsx(["Mã KH", "Họ tên", "Email"], [["KH99999", "Ai đó", "sai-email"]]);
    const preview = (await importFile("customers", bad, "preview", salesToken).expect(200)).body.data;
    expect(preview.issues.map((issue: { column: string }) => issue.column)).toEqual(expect.arrayContaining(["Mã KH", "Email"]));
  });

  it("xuất khách hàng cần quyền dữ liệu nhạy cảm và được ghi audit", async () => {
    await prisma.customer.create({ data: { fullName: "Lê Thị B", phone: "0903333444" } });
    await download("/api/v1/excel/exports/customers", adminToken, 403);
    const res = await download("/api/v1/excel/exports/customers", pharmacistToken);
    const rows = await sheetRows(res.body as Buffer);
    expect(rows[1]).toContain("0903333444");
    expect(await prisma.auditLog.count({ where: { action: "EXCEL_EXPORT", resourceType: "customers" } })).toBe(1);
  });
});

describe("Nhập tồn đầu kỳ và dòng phiếu nhập", () => {
  const STOCK_HEADERS = ["Mã sản phẩm", "Đơn vị", "Số lượng", "Giá vốn", "Số lô", "Hạn dùng"];

  it("tạo phiếu tồn đầu kỳ và lô cho cửa hàng đang chọn", async () => {
    await makeProduct("TH0001");
    const file = await xlsx(STOCK_HEADERS, [
      ["TH0001", "Hộp", 3, 80000, "L001", futureDate(400)],
      ["TH0001", "viên", 50, 900, "L002", futureDate(200)],
    ]);
    const result = (await importFile("opening-balance", file, "commit").expect(200)).body.data;
    expect(result.created).toBe(2);
    expect(result.documentId).toBeTruthy();
    const batches = await prisma.batch.findMany({ where: { storeId: fixture.storeId }, orderBy: { batchNumber: "asc" } });
    expect(batches.map((batch) => [batch.batchNumber, batch.quantityOnHand])).toEqual([
      ["L001", 300],
      ["L002", 50],
    ]);
    expect(await prisma.batch.count({ where: { storeId: fixture.otherStoreId } })).toBe(0);

    // Lô đã có trong kho thì không nhập trùng.
    const again = (await importFile("opening-balance", file, "preview").expect(200)).body.data;
    expect(again.issues[0].message).toContain("đã có trong kho");
  });

  it("báo lỗi hạn dùng đã qua, đơn vị sai và sản phẩm không có", async () => {
    await makeProduct("TH0001");
    const file = await xlsx(STOCK_HEADERS, [
      ["TH0001", "Hộp", 3, 80000, "L001", "01/01/2020"],
      ["TH0001", "Chai", 3, 80000, "L002", futureDate(300)],
      ["XX0001", "Hộp", 3, 80000, "L003", futureDate(300)],
    ]);
    const preview = (await importFile("opening-balance", file, "preview").expect(200)).body.data;
    expect(preview.validRows).toBe(0);
    expect(preview.issues.map((issue: { message: string }) => issue.message).join(" | ")).toMatch(/Hạn dùng phải sau hôm nay.*không có đơn vị "Chai".*Không có sản phẩm mã XX0001/);
  });

  it("dòng phiếu nhập chỉ xem trước, trả dòng đã khớp để đổ vào phiếu nháp", async () => {
    const product = await makeProduct("TH0001");
    const file = await xlsx(
      ["Mã sản phẩm", "Đơn vị", "Số lượng", "Đơn giá nhập", "Số lô", "Ngày sản xuất", "Hạn dùng"],
      [["TH0001", "Hộp", 10, 75000, "L100", "01/01/2026", futureDate(500)]],
    );
    const preview = (await importFile("receipt-lines", file, "preview").expect(200)).body.data;
    expect(preview.lines).toHaveLength(1);
    expect(preview.lines[0]).toMatchObject({ productId: product.id, unitId: product.units.find((unit) => unit.name === "Hộp")!.id, quantity: 10, unitCost: 75000, batchNumber: "L100", manufactureDate: "2026-01-01" });
    await importFile("receipt-lines", file, "commit").expect(400);
    expect(await prisma.goodsReceipt.count()).toBe(0);
  });

  it("cần chọn cửa hàng", async () => {
    const file = await xlsx(STOCK_HEADERS, []);
    await api().post("/api/v1/excel/imports/opening-balance?mode=preview").set(authHeaders(adminToken)).attach("file", file, "a.xlsx").expect(400);
  });
});

describe("Xuất báo cáo", () => {
  it("tồn kho theo lô: giá vốn chỉ hiện với người có quyền xem giá vốn", async () => {
    const product = await makeProduct("TH0001");
    await prisma.batch.create({
      data: { storeId: fixture.storeId, productId: product.id, batchNumber: "L1", expiryDate: new Date("2030-01-01"), quantityOnHand: 120, unitCost: 800 },
    });
    const admin = await sheetRows((await download("/api/v1/excel/exports/inventory")).body as Buffer);
    expect(admin[0]).toContain("Giá trị tồn");
    expect(admin[1]).toEqual(expect.arrayContaining(["TH0001", "L1", 120, 96000]));

    const pharmacist = await sheetRows((await download("/api/v1/excel/exports/inventory", pharmacistToken)).body as Buffer);
    expect(pharmacist[0]).not.toContain("Giá trị tồn");
  });

  it("hóa đơn và sổ bán thuốc kê đơn: kiểm tra khoảng ngày, có sheet chi tiết", async () => {
    await api().get("/api/v1/excel/exports/invoices?from=2026-05-01&to=2026-01-01").set(h()).expect(422);
    await api().get("/api/v1/excel/exports/invoices?from=2024-01-01&to=2026-01-01").set(h()).expect(422);
    await api().get("/api/v1/excel/exports/invoices?from=2026-02-30").set(h()).expect(422);

    const invoices = (await download("/api/v1/excel/exports/invoices?from=2026-01-01&to=2026-01-31")).body as Buffer;
    expect((await sheetRows(invoices, 1))[0]).toContain("Lô xuất (FEFO)");

    await download("/api/v1/excel/exports/rx-sales", adminToken, 403);
    const rx = await sheetRows((await download("/api/v1/excel/exports/rx-sales", pharmacistToken)).body as Buffer);
    expect(rx[0]).toEqual(expect.arrayContaining(["Người kê đơn", "Số lô", "Hạn dùng"]));
  });

  it("sổ bán thuốc kê đơn ghi đủ đơn thuốc, người kê, số lô, hạn dùng và người bán", async () => {
    const product = await makeProduct("TH0005", "RX");
    const pill = product.units.find((unit) => unit.name === "Viên")!;
    await prisma.productPrice.create({ data: { productUnitId: pill.id, salePrice: 3000n, vatRatePercent: 5, effectiveFrom: new Date(Date.now() - 86_400_000) } });
    await prisma.batch.create({ data: { storeId: fixture.storeId, productId: product.id, batchNumber: "AMX01", expiryDate: new Date("2029-03-31"), quantityOnHand: 100 } });
    const customer = await prisma.customer.create({ data: { fullName: "Phạm Văn C", phone: "0904444555", birthYear: 1975 } });
    const idem = () => ({ "Idempotency-Key": randomUUID() });
    const draft = await api()
      .post("/api/v1/prescriptions")
      .set(h(pharmacistToken))
      .send({
        prescriberName: "BS. Nguyễn Văn B",
        facilityName: "Bệnh viện Đa khoa Hà Nội",
        prescribedDate: new Date().toISOString().slice(0, 10),
        diagnosisText: "Viêm họng cấp",
        items: [{ productId: product.id, unitId: pill.id, drugNameText: "Amoxicillin 500mg", quantity: 20 }],
      })
      .expect(201);
    await api().post(`/api/v1/prescriptions/${draft.body.data.id}/verify`).set({ ...h(pharmacistToken), ...idem() }).send({}).expect(200);
    await api()
      .post("/api/v1/invoices")
      .set({ ...h(pharmacistToken), ...idem() })
      .send({ customerId: customer.id, prescriptionId: draft.body.data.id, lines: [{ productId: product.id, unitId: pill.id, quantity: 20, prescriptionItemId: draft.body.data.items[0].id }] })
      .expect(201);

    const rx = await sheetRows((await download("/api/v1/excel/exports/rx-sales", pharmacistToken)).body as Buffer);
    expect(rx).toHaveLength(2);
    expect(rx[1]).toEqual(expect.arrayContaining(["Phạm Văn C", 1975, "BS. Nguyễn Văn B", "Bệnh viện Đa khoa Hà Nội", "Viêm họng cấp", "TH0005", "Kê đơn", 20, "AMX01", "31/03/2029", "Dược sĩ"]));

    const workbook = (await download("/api/v1/excel/exports/invoices")).body as Buffer;
    const [invoices, lines] = [await sheetRows(workbook, 0), await sheetRows(workbook, 1)];
    expect(invoices[1]).toEqual(expect.arrayContaining(["Phạm Văn C", 60000, "Hoàn tất"]));
    expect(lines[1]).toEqual(expect.arrayContaining(["TH0005", 20, 3000, 60000, "AMX01"]));
  });
});

describe("Kiểm kê qua Excel", () => {
  async function openCount() {
    const productRow = await makeProduct("TH0007", "OTC");
    const pill = productRow.units.find((unit) => unit.name === "Viên")!;
    await prisma.batch.create({
      data: { storeId: fixture.storeId, productId: productRow.id, batchNumber: "KK01", expiryDate: new Date("2029-06-30"), quantityOnHand: 120, shelfLocation: "Kệ A1" },
    });
    const opened = await api().post("/api/v1/stock-counts").set(h(pharmacistToken)).send({}).expect(201);
    return { productRow, pill, count: opened.body.data.count };
  }

  it("xuất bảng đếm không kèm tồn hệ thống để đếm khách quan", async () => {
    await openCount();
    const rows = await sheetRows((await download("/api/v1/excel/exports/stock-count", pharmacistToken)).body as Buffer);
    expect(rows[0]).toEqual(expect.arrayContaining(["Số lô", "Đơn vị đếm", "Số đếm được"]));
    // Cố ý không có cột tồn hệ thống: người đếm không chép theo số có sẵn.
    expect(rows[0]!.join(" ")).not.toContain("Tồn");
    expect(rows[1]).toEqual(expect.arrayContaining(["TH0007", "KK01", "Kệ A1"]));
  });

  it("nhập số đếm vào đợt đang mở, bỏ qua dòng chưa đếm và báo lô lạ", async () => {
    const { pill } = await openCount();
    const file = await xlsx(
      ["Mã sản phẩm", "Số lô", "Đơn vị đếm", "Số đếm được"],
      [
        ["TH0007", "KK01", "Viên", 118],
        ["TH0007", "KK01", "Viên", ""],
        ["TH0007", "KHONGCO", "Viên", 5],
      ],
    );
    const preview = (await importFile("stock-count", file, "preview", pharmacistToken).expect(200)).body.data;
    expect(preview.validRows).toBe(1);
    expect(preview.issues[0].message).toContain("không nằm trong đợt kiểm kê");
    expect(preview.notes.join(" ")).toContain("Ghi số đếm vào đợt KK-NT01");

    const good = await xlsx(["Mã sản phẩm", "Số lô", "Đơn vị đếm", "Số đếm được"], [["TH0007", "KK01", "Viên", 118]]);
    const result = (await importFile("stock-count", good, "commit", pharmacistToken).expect(200)).body.data;
    expect(result).toMatchObject({ created: 1, updated: 0 });

    const line = await prisma.stockCountLine.findFirstOrThrow();
    expect(line).toMatchObject({ countedQuantity: 118, countedBaseQuantity: 118, systemBaseQuantityAtCount: 120, countedUnitId: pill.id });
  });

  it("chưa mở đợt kiểm kê thì báo rõ phải mở trước", async () => {
    await makeProduct("TH0008", "OTC");
    const file = await xlsx(["Mã sản phẩm", "Số lô", "Đơn vị đếm", "Số đếm được"], [["TH0008", "X1", "Viên", 1]]);
    const response = await importFile("stock-count", file, "preview", pharmacistToken).expect(409);
    expect(response.body.error.message).toContain("chưa có đợt kiểm kê nào đang mở");
  });
});
