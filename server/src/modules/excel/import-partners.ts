import { prisma } from "../../db/prisma.js";
import { COMMIT_TIMEOUT_MS, RowReader, fold, headerMap, type ImportDefinition, type ImportIssue, type PlannedRow } from "./import-kit.js";
import { asChoice, asInt, asText, type ColumnDef } from "./workbook.js";

const ACTIVE_CHOICES = { "Đang giao dịch": true, "Ngừng giao dịch": false } as const;

// ---------------------------------------------------------------------------
// Nhà cung cấp
// ---------------------------------------------------------------------------

export const SUPPLIER_COLUMNS: ColumnDef[] = [
  { key: "name", header: "Tên nhà cung cấp", required: true, width: 36 },
  { key: "taxCode", header: "Mã số thuế", width: 16, note: "Dùng để nhận biết nhà cung cấp đã có. Không có MST thì so theo tên." },
  { key: "licenseNumber", header: "Số giấy phép kinh doanh dược", width: 24 },
  { key: "address", header: "Địa chỉ", width: 40 },
  { key: "phone", header: "Điện thoại", width: 16 },
  { key: "status", header: "Trạng thái", width: 16, note: "Đang giao dịch hoặc Ngừng giao dịch. Để trống: giữ nguyên." },
];

type SupplierRow = { existingId: string | null; fields: Record<string, string | null>; isActive: boolean | null };

export const suppliersImport: ImportDefinition<SupplierRow> = {
  type: "suppliers",
  title: "Nhà cung cấp",
  permission: ["catalog.manage"],
  needsStore: false,
  columns: SUPPLIER_COLUMNS,
  guide: [
    "Mỗi dòng là một nhà cung cấp. Có mã số thuế trùng thì cập nhật, không thì so theo tên (không phân biệt dấu).",
    "Ô để trống khi cập nhật: giữ nguyên giá trị cũ.",
    "Có lỗi ở bất kỳ dòng nào thì không dòng nào được ghi.",
  ],
  example: [
    { name: "Công ty CP Dược phẩm Minh Tâm", taxCode: "0301234567", licenseNumber: "1234/ĐKKD-BYT", address: "25 Nguyễn Trãi, Q.5, TP.HCM", phone: "02838123456", status: "Đang giao dịch" },
  ],

  async plan(rows) {
    const headers = headerMap(SUPPLIER_COLUMNS);
    const issues: ImportIssue[] = [];
    const planned: PlannedRow<SupplierRow>[] = [];
    const suppliers = await prisma.supplier.findMany({ select: { id: true, name: true, taxCode: true } });
    const byTax = new Map(suppliers.filter((item) => item.taxCode).map((item) => [item.taxCode!, item.id]));
    const byName = new Map(suppliers.map((item) => [fold(item.name), item.id]));
    const seen = new Map<string, number>();

    for (const raw of rows) {
      const r = new RowReader(raw.rowNumber, headers);
      const v = raw.values;
      const name = r.read("name", () => asText(v["name"], 300, "Tên nhà cung cấp"));
      const taxCode = r.read("taxCode", () => asText(v["taxCode"], 20, "Mã số thuế"));
      const fields = {
        name,
        taxCode,
        licenseNumber: r.read("licenseNumber", () => asText(v["licenseNumber"], 50, "Số giấy phép")),
        address: r.read("address", () => asText(v["address"], 500, "Địa chỉ")),
        phone: r.read("phone", () => asText(v["phone"], 20, "Điện thoại")),
      };
      const isActive = r.read("status", () => asChoice(v["status"], "Trạng thái", ACTIVE_CHOICES));
      r.require("name", name);
      if (taxCode && !/^[0-9-]+$/.test(taxCode)) r.fail("taxCode", "Mã số thuế chỉ gồm chữ số và dấu gạch ngang");

      const key = taxCode ? `tax:${taxCode}` : name ? `name:${fold(name)}` : "";
      if (key) {
        const dup = seen.get(key);
        if (dup) r.fail(taxCode ? "taxCode" : "name", `Trùng nhà cung cấp ở dòng ${dup}`);
        seen.set(key, raw.rowNumber);
      }
      issues.push(...r.issues);
      if (r.issues.length > 0 || !name) continue;

      const existingId = (taxCode ? byTax.get(taxCode) : undefined) ?? byName.get(fold(name)) ?? null;
      planned.push({ row: raw.rowNumber, action: existingId ? "update" : "create", label: name, data: { existingId, fields, isActive } });
    }
    return { rows: planned, issues, notes: [] };
  },

  async commit(plan) {
    let created = 0;
    let updated = 0;
    await prisma.$transaction(
      async (tx) => {
        for (const { data } of plan.rows) {
          const values = Object.fromEntries(Object.entries(data.fields).filter(([, value]) => value !== null));
          if (data.existingId) {
            await tx.supplier.update({
              where: { id: data.existingId },
              data: { ...values, ...(data.isActive !== null ? { isActive: data.isActive } : {}), version: { increment: 1 } },
            });
            updated++;
          } else {
            await tx.supplier.create({ data: { name: data.fields["name"]!, ...values, isActive: data.isActive ?? true } });
            created++;
          }
        }
      },
      { timeout: COMMIT_TIMEOUT_MS, maxWait: 10_000 },
    );
    return { created, updated };
  },
};

// ---------------------------------------------------------------------------
// Khách hàng
// ---------------------------------------------------------------------------

const GENDER_CHOICES = { Nam: "MALE", Nữ: "FEMALE", Khác: "OTHER" } as const;

export const CUSTOMER_COLUMNS: ColumnDef[] = [
  { key: "code", header: "Mã KH", width: 11, note: "Để trống với khách mới (hệ thống tự cấp). Có mã thì cập nhật đúng khách đó." },
  { key: "fullName", header: "Họ tên", width: 26 },
  { key: "phone", header: "Số điện thoại", width: 15, note: "Không có mã KH thì so theo số điện thoại để tránh tạo trùng khách." },
  { key: "birthYear", header: "Năm sinh", kind: "int", width: 10 },
  { key: "gender", header: "Giới tính", width: 10, note: "Nam, Nữ, Khác" },
  { key: "email", header: "Email", width: 24 },
  { key: "address", header: "Địa chỉ", width: 34 },
  { key: "note", header: "Ghi chú chăm sóc", width: 34 },
];

type CustomerRow = { existingId: string | null; fields: Record<string, string | number | null> };

export const customersImport: ImportDefinition<CustomerRow> = {
  type: "customers",
  title: "Khách hàng",
  permission: ["customer.manage"],
  needsStore: false,
  columns: CUSTOMER_COLUMNS,
  guide: [
    "Mỗi dòng là một khách. Cần ít nhất họ tên hoặc số điện thoại.",
    "Có Mã KH thì cập nhật đúng khách đó; không có thì so theo số điện thoại, không trùng thì tạo khách mới.",
    "Chỉ nhập thông tin liên hệ cơ bản. Hồ sơ sức khỏe (dị ứng, bệnh nền) phải ghi nhận đồng ý của khách trên phần mềm, không nhập qua Excel.",
    "Có lỗi ở bất kỳ dòng nào thì không dòng nào được ghi.",
  ],
  example: [{ code: "", fullName: "Nguyễn Thị Mai", phone: "0901234567", birthYear: 1988, gender: "Nữ", email: "mai@example.com", address: "Phường B, TP. Hồ Chí Minh", note: "Ưu tiên liên hệ qua điện thoại" }],

  async plan(rows) {
    const headers = headerMap(CUSTOMER_COLUMNS);
    const issues: ImportIssue[] = [];
    const planned: PlannedRow<CustomerRow>[] = [];
    const codes = rows.map((row) => String(row.values["code"] ?? "").trim().toUpperCase()).filter(Boolean);
    const phones = rows.map((row) => String(row.values["phone"] ?? "").replace(/\s/g, "")).filter(Boolean);
    const [byCodeRows, byPhoneRows] = await Promise.all([
      prisma.customer.findMany({ where: { code: { in: codes } }, select: { id: true, code: true, isAnonymized: true } }),
      prisma.customer.findMany({ where: { phone: { in: phones }, isAnonymized: false }, select: { id: true, phone: true } }),
    ]);
    const byCode = new Map(byCodeRows.map((row) => [row.code, row]));
    const phoneOwners = new Map<string, string[]>();
    for (const row of byPhoneRows) phoneOwners.set(row.phone!, [...(phoneOwners.get(row.phone!) ?? []), row.id]);
    const seenPhones = new Map<string, number>();
    const currentYear = new Date().getUTCFullYear();

    for (const raw of rows) {
      const r = new RowReader(raw.rowNumber, headers);
      const v = raw.values;
      const code = r.read("code", () => asText(v["code"], 20, "Mã KH"))?.toUpperCase() ?? null;
      const fullName = r.read("fullName", () => asText(v["fullName"], 200, "Họ tên"));
      const phone = r.read("phone", () => asText(v["phone"], 20, "Số điện thoại"))?.replace(/\s/g, "") ?? null;
      const birthYear = r.read("birthYear", () => asInt(v["birthYear"], "Năm sinh", { min: 1900 }));
      const gender = r.read("gender", () => asChoice(v["gender"], "Giới tính", GENDER_CHOICES));
      const email = r.read("email", () => asText(v["email"], 200, "Email"));
      const address = r.read("address", () => asText(v["address"], 300, "Địa chỉ"));
      const note = r.read("note", () => asText(v["note"], 1000, "Ghi chú"));

      if (!fullName && !phone) r.fail("fullName", "Cần ít nhất họ tên hoặc số điện thoại");
      if (phone && !/^[0-9+()-]{6,20}$/.test(phone)) r.fail("phone", "Số điện thoại không hợp lệ");
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) r.fail("email", "Email không hợp lệ");
      if (birthYear && birthYear > currentYear) r.fail("birthYear", "Năm sinh ở tương lai");

      let existingId: string | null = null;
      if (code) {
        const found = byCode.get(code);
        if (!found) r.fail("code", `Không có khách mã ${code}`);
        else if (found.isAnonymized) r.fail("code", "Khách này đã được ẩn danh, không cập nhật được");
        else existingId = found.id;
      } else if (phone) {
        const owners = phoneOwners.get(phone) ?? [];
        if (owners.length > 1) r.fail("phone", "Có nhiều khách cùng số điện thoại này — điền Mã KH để chỉ rõ khách nào");
        existingId = owners[0] ?? null;
      }
      if (phone) {
        const dup = seenPhones.get(phone);
        if (dup) r.fail("phone", `Trùng số điện thoại với dòng ${dup}`);
        seenPhones.set(phone, raw.rowNumber);
      }

      issues.push(...r.issues);
      if (r.issues.length > 0) continue;
      planned.push({
        row: raw.rowNumber,
        action: existingId ? "update" : "create",
        label: [code, fullName ?? phone].filter(Boolean).join(" · "),
        data: { existingId, fields: { fullName, phone, birthYear, gender, email, address, note } },
      });
    }
    return { rows: planned, issues, notes: [] };
  },

  async commit(plan) {
    let created = 0;
    let updated = 0;
    await prisma.$transaction(
      async (tx) => {
        for (const { data } of plan.rows) {
          const values = Object.fromEntries(Object.entries(data.fields).filter(([, value]) => value !== null));
          if (data.existingId) {
            await tx.customer.update({ where: { id: data.existingId }, data: { ...values, version: { increment: 1 } } });
            updated++;
          } else {
            await tx.customer.create({ data: values });
            created++;
          }
        }
      },
      { timeout: COMMIT_TIMEOUT_MS, maxWait: 10_000 },
    );
    return { created, updated };
  },
};
