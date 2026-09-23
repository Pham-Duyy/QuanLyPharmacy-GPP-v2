import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { saveCounts } from "../inventory/stock-counts.service.js";
import { RowReader, fold, headerMap, type ImportDefinition, type ImportIssue, type PlannedRow } from "./import-kit.js";
import { asInt, asText, type ColumnDef } from "./workbook.js";

export const STOCK_COUNT_COLUMNS: ColumnDef[] = [
  { key: "productCode", header: "Mã sản phẩm", required: true, width: 14 },
  { key: "productName", header: "Tên sản phẩm", width: 34, note: "Chỉ để dễ đọc, hệ thống khớp theo mã sản phẩm và số lô." },
  { key: "batchNumber", header: "Số lô", required: true, width: 14 },
  { key: "shelfLocation", header: "Vị trí kệ", width: 12 },
  { key: "unit", header: "Đơn vị đếm", required: true, width: 12, note: "Tên đơn vị của sản phẩm: Viên, Hộp…" },
  { key: "counted", header: "Số đếm được", required: true, kind: "int", width: 12, note: "Số lượng đếm thực tế trên kệ. Để trống nếu chưa đếm dòng đó." },
  { key: "note", header: "Ghi chú", width: 26 },
];

type CountEntryRow = { lineId: string; unitId: string; quantity: number; note: string | null };

/**
 * Nhập số đếm vào **đợt kiểm kê đang mở** của cửa hàng: nhà thuốc in bảng
 * đếm ra giấy, đếm rồi gõ lại một lượt. Dòng để trống ô số đếm được bỏ qua,
 * không bị coi là đếm được 0.
 */
export const stockCountImport: ImportDefinition<CountEntryRow> = {
  type: "stock-count",
  title: "Số đếm kiểm kê",
  permission: ["stock.adjust.create"],
  needsStore: true,
  columns: STOCK_COUNT_COLUMNS,
  guide: [
    "Dùng cho đợt kiểm kê đang mở của cửa hàng đang chọn. Chưa mở đợt thì mở ở trang Kiểm kê kho trước.",
    "Tải bảng đếm ở mục xuất “Bảng kiểm kê đang mở”, in ra, đếm rồi điền cột Số đếm được và nhập lại tệp này.",
    "Khớp dòng theo Mã sản phẩm + Số lô. Lô không nằm trong đợt sẽ bị báo lỗi — thêm lô đó trên giao diện kiểm kê rồi nhập lại.",
    "Ô Số đếm được để trống nghĩa là chưa đếm, hệ thống bỏ qua dòng đó chứ không ghi 0.",
  ],
  example: [{ productCode: "TH0001", productName: "Paracetamol 500mg", batchNumber: "PA260901", shelfLocation: "Kệ A1", unit: "Hộp", counted: 12, note: "" }],

  async plan(rows, ctx) {
    const headers = headerMap(STOCK_COUNT_COLUMNS);
    const issues: ImportIssue[] = [];
    const planned: PlannedRow<CountEntryRow>[] = [];

    const count = await prisma.stockCount.findFirst({ where: { storeId: ctx.storeId!, status: "COUNTING" } });
    if (!count) {
      throw AppError.invalidState("Cửa hàng chưa có đợt kiểm kê nào đang mở. Mở đợt ở trang Kiểm kê kho trước khi nhập số đếm.");
    }

    const lines = await prisma.stockCountLine.findMany({
      where: { stockCountId: count.id },
      include: {
        batch: { select: { batchNumber: true } },
        product: { select: { code: true, units: { where: { isActive: true }, select: { id: true, name: true } } } },
      },
    });
    const byKey = new Map(lines.map((line) => [`${fold(line.product.code)}|${fold(line.batch.batchNumber)}`, line]));
    const seen = new Map<string, number>();

    for (const raw of rows) {
      const r = new RowReader(raw.rowNumber, headers);
      const v = raw.values;
      const productCode = r.read("productCode", () => asText(v["productCode"], 50, "Mã sản phẩm"));
      const batchNumber = r.read("batchNumber", () => asText(v["batchNumber"], 50, "Số lô"));
      const unitName = r.read("unit", () => asText(v["unit"], 50, "Đơn vị đếm"));
      const counted = r.read("counted", () => asInt(v["counted"], "Số đếm được", { min: 0 }));
      const note = r.read("note", () => asText(v["note"], 300, "Ghi chú"));

      r.require("productCode", productCode);
      r.require("batchNumber", batchNumber);
      // Chưa đếm: bỏ qua dòng, không báo lỗi thiếu đơn vị.
      if (counted === null && r.issues.length === 0) continue;
      r.require("unit", unitName);

      const line = productCode && batchNumber ? byKey.get(`${fold(productCode)}|${fold(batchNumber)}`) : undefined;
      if (productCode && batchNumber && !line) {
        r.fail("batchNumber", `Lô ${batchNumber} của ${productCode} không nằm trong đợt kiểm kê ${count.code}`);
      }
      const unit = line && unitName ? line.product.units.find((item) => fold(item.name) === fold(unitName)) : undefined;
      if (line && unitName && !unit) {
        r.fail("unit", `Sản phẩm không có đơn vị "${unitName}" (có: ${line.product.units.map((item) => item.name).join(", ")})`);
      }
      if (line) {
        const duplicate = seen.get(line.id);
        if (duplicate) r.fail("batchNumber", `Trùng lô với dòng ${duplicate}`);
        seen.set(line.id, raw.rowNumber);
      }

      issues.push(...r.issues);
      if (r.issues.length > 0 || !line || !unit || counted === null) continue;

      planned.push({
        row: raw.rowNumber,
        action: line.countedBaseQuantity === null ? "create" : "update",
        label: `${line.product.code} · lô ${line.batch.batchNumber} · ${counted} ${unit.name}`,
        data: { lineId: line.id, unitId: unit.id, quantity: counted, note: note ?? null },
      });
    }

    const notes = [`Ghi số đếm vào đợt ${count.code} (${planned.length}/${lines.length} dòng của đợt).`];
    return { rows: planned, issues, notes };
  },

  async commit(plan, ctx) {
    const count = await prisma.stockCount.findFirst({ where: { storeId: ctx.storeId!, status: "COUNTING" } });
    if (!count) throw AppError.invalidState("Đợt kiểm kê đã được chốt hoặc hủy trong lúc bạn kiểm tra tệp");

    const result = await saveCounts(ctx.storeId!, count.id, ctx.auth.userId, {
      entries: plan.rows.map(({ data }) => ({ lineId: data.lineId, unitId: data.unitId, quantity: data.quantity, note: data.note })),
    });
    const created = plan.rows.filter((row) => row.action === "create").length;
    return { created, updated: result.saved - created, documentId: count.id };
  },
};
