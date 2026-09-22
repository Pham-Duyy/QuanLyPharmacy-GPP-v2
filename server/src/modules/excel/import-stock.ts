import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { businessDateNow } from "../../lib/settings.js";
import { MIN_SHELF_LIFE_DAYS } from "../inventory/goods-receipts.schema.js";
import { createOpeningBalance } from "../inventory/opening-balance.service.js";
import { RowReader, fold, headerMap, type ImportDefinition, type ImportIssue, type PlannedRow } from "./import-kit.js";
import { asDate, asInt, asText, type ColumnDef, type RawRow } from "./workbook.js";

const DAY_MS = 86_400_000;

type StockLine = {
  productId: string;
  productCode: string;
  productName: string;
  unitId: string;
  unitName: string;
  conversionToBase: number;
  quantity: number;
  unitCost: number;
  batchNumber: string;
  manufactureDate: string | null;
  expiryDate: string;
};

const day = (value: Date) => value.toISOString().slice(0, 10);

/**
 * Đọc chung cho tồn đầu kỳ và dòng phiếu nhập: khớp sản phẩm theo mã, đơn
 * vị theo tên, kiểm tra số lô, ngày sản xuất/hạn dùng theo cùng quy tắc
 * với phiếu nhập (hạn dùng phải sau hôm nay, cách NSX tối thiểu 30 ngày).
 */
async function planStockLines(rows: RawRow[], columns: ColumnDef[], options: { storeId: string | null; checkExistingBatch: boolean }) {
  const headers = headerMap(columns);
  const issues: ImportIssue[] = [];
  const planned: PlannedRow<StockLine>[] = [];
  const codes = [...new Set(rows.map((row) => String(row.values["productCode"] ?? "").trim()).filter(Boolean))];
  const products = await prisma.product.findMany({ where: { code: { in: codes } }, include: { units: { where: { isActive: true } } } });
  const byCode = new Map(products.map((product) => [product.code, product]));
  const existingBatches =
    options.checkExistingBatch && options.storeId
      ? await prisma.batch.findMany({ where: { storeId: options.storeId, productId: { in: products.map((product) => product.id) } }, select: { productId: true, batchNumber: true } })
      : [];
  const batchTaken = new Set(existingBatches.map((batch) => `${batch.productId}|${fold(batch.batchNumber)}`));
  const seen = new Map<string, number>();
  const today = businessDateNow();

  for (const raw of rows) {
    const r = new RowReader(raw.rowNumber, headers);
    const v = raw.values;
    const code = r.read("productCode", () => asText(v["productCode"], 50, "Mã sản phẩm"));
    const unitName = r.read("unit", () => asText(v["unit"], 50, "Đơn vị"));
    const quantity = r.read("quantity", () => asInt(v["quantity"], "Số lượng", { min: 1 }));
    const unitCost = r.read("unitCost", () => asInt(v["unitCost"], "Đơn giá", { min: 0 }));
    const batchNumber = r.read("batchNumber", () => asText(v["batchNumber"], 50, "Số lô"));
    const manufactureDate = columns.some((column) => column.key === "manufactureDate") ? r.read("manufactureDate", () => asDate(v["manufactureDate"], "Ngày sản xuất")) : null;
    const expiryDate = r.read("expiryDate", () => asDate(v["expiryDate"], "Hạn dùng"));

    r.require("productCode", code);
    r.require("unit", unitName);
    r.require("quantity", quantity);
    r.require("unitCost", unitCost);
    r.require("batchNumber", batchNumber);
    r.require("expiryDate", expiryDate);

    const product = code ? byCode.get(code) : undefined;
    if (code && !product) r.fail("productCode", `Không có sản phẩm mã ${code} — thêm vào danh mục trước`);
    else if (product && !product.isActive) r.fail("productCode", "Sản phẩm đã ngừng kinh doanh");
    const unit = product && unitName ? product.units.find((item) => fold(item.name) === fold(unitName)) : undefined;
    if (product && unitName && !unit) r.fail("unit", `Sản phẩm không có đơn vị "${unitName}" (có: ${product.units.map((item) => item.name).join(", ")})`);

    if (expiryDate && expiryDate.getTime() <= today.getTime()) r.fail("expiryDate", "Hạn dùng phải sau hôm nay");
    if (manufactureDate && manufactureDate.getTime() > today.getTime()) r.fail("manufactureDate", "Ngày sản xuất không được ở tương lai");
    if (manufactureDate && expiryDate && expiryDate.getTime() - manufactureDate.getTime() < MIN_SHELF_LIFE_DAYS * DAY_MS) {
      r.fail("expiryDate", `Hạn dùng phải sau ngày sản xuất ít nhất ${MIN_SHELF_LIFE_DAYS} ngày — kiểm tra lại NSX/HSD trên bao bì`);
    }
    if (product && batchNumber) {
      const key = `${product.id}|${fold(batchNumber)}`;
      const dup = seen.get(key);
      if (dup) r.fail("batchNumber", `Trùng số lô với dòng ${dup}`);
      seen.set(key, raw.rowNumber);
      if (batchTaken.has(key)) r.fail("batchNumber", "Lô này đã có trong kho cửa hàng");
    }

    issues.push(...r.issues);
    if (r.issues.length > 0 || !product || !unit || !quantity || unitCost === null || !batchNumber || !expiryDate) continue;
    planned.push({
      row: raw.rowNumber,
      action: "create",
      label: `${product.code} · ${product.name} · lô ${batchNumber} · ${quantity} ${unit.name}`,
      data: {
        productId: product.id,
        productCode: product.code,
        productName: product.name,
        unitId: unit.id,
        unitName: unit.name,
        conversionToBase: unit.conversionToBase,
        quantity,
        unitCost,
        batchNumber,
        manufactureDate: manufactureDate ? day(manufactureDate) : null,
        expiryDate: day(expiryDate),
      },
    });
  }
  return { rows: planned, issues, notes: [] as string[] };
}

const STOCK_COLUMNS = (options: { withManufacture: boolean; costLabel: string }): ColumnDef[] => [
  { key: "productCode", header: "Mã sản phẩm", required: true, width: 14, note: "Mã trong danh mục Thuốc & sản phẩm." },
  { key: "productName", header: "Tên sản phẩm", width: 32, note: "Chỉ để dễ đọc, hệ thống khớp theo mã." },
  { key: "unit", header: "Đơn vị", required: true, width: 10, note: "Tên đơn vị của sản phẩm (Viên, Hộp…)." },
  { key: "quantity", header: "Số lượng", required: true, kind: "int", width: 10 },
  { key: "unitCost", header: options.costLabel, required: true, kind: "money", width: 14, note: "Giá cho 1 đơn vị ở cột Đơn vị." },
  { key: "batchNumber", header: "Số lô", required: true, width: 14 },
  ...(options.withManufacture ? [{ key: "manufactureDate", header: "Ngày sản xuất", kind: "date" as const, width: 14, note: "dd/mm/yyyy" }] : []),
  { key: "expiryDate", header: "Hạn dùng", required: true, kind: "date", width: 14, note: "dd/mm/yyyy, phải sau hôm nay." },
];

export const OPENING_BALANCE_COLUMNS = STOCK_COLUMNS({ withManufacture: false, costLabel: "Giá vốn" });
export const RECEIPT_LINE_COLUMNS = STOCK_COLUMNS({ withManufacture: true, costLabel: "Đơn giá nhập" });

export const openingBalanceImport: ImportDefinition<StockLine> = {
  type: "opening-balance",
  title: "Tồn đầu kỳ",
  permission: ["stock.opening_balance"],
  needsStore: true,
  columns: OPENING_BALANCE_COLUMNS,
  guide: [
    "Dùng khi bắt đầu sử dụng phần mềm: nhập tồn thực tế từng lô đang có tại cửa hàng đang chọn.",
    "Chỉ nhập được trước khi cửa hàng phát sinh hóa đơn bán đầu tiên. Toàn bộ tệp tạo thành một phiếu tồn đầu kỳ, ghi thẻ kho.",
    "Sản phẩm phải có sẵn trong danh mục (nhập danh mục trước). Mỗi dòng là một lô; cùng sản phẩm khác lô thì nhiều dòng.",
    "Lô hết hạn không nhập làm tồn bán được — xử lý xuất hủy riêng.",
  ],
  example: [{ productCode: "TH0001", productName: "Paracetamol 500mg", unit: "Hộp", quantity: 12, unitCost: 82000, batchNumber: "PA260901", expiryDate: "01/09/2028" }],
  plan: (rows, ctx) => planStockLines(rows, OPENING_BALANCE_COLUMNS, { storeId: ctx.storeId, checkExistingBatch: true }),
  async commit(plan, ctx) {
    if (!ctx.storeId) throw new AppError(400, "STORE_REQUIRED", "Chọn cửa hàng trước khi nhập tồn đầu kỳ");
    const id = await createOpeningBalance(ctx.storeId, ctx.auth.userId, {
      lines: plan.rows.map(({ data }) => ({
        productId: data.productId,
        unitId: data.unitId,
        quantity: data.quantity,
        batchNumber: data.batchNumber,
        expiryDate: new Date(`${data.expiryDate}T00:00:00.000Z`),
        unitCost: data.unitCost,
      })),
    });
    return { created: plan.rows.length, updated: 0, documentId: id };
  },
};

/** Chỉ đọc: trả dòng đã khớp sản phẩm để giao diện đổ vào form phiếu nhập nháp. */
export const receiptLinesImport: ImportDefinition<StockLine> = {
  type: "receipt-lines",
  title: "Dòng hàng phiếu nhập",
  permission: ["goods_receipt.create"],
  needsStore: true,
  previewOnly: true,
  columns: RECEIPT_LINE_COLUMNS,
  guide: [
    "Dùng trong form Tạo phiếu nhập: đọc danh sách hàng theo hóa đơn nhà cung cấp rồi đổ vào phiếu nháp để kiểm tra trước khi lưu.",
    "Sản phẩm khớp theo mã, đơn vị khớp theo tên. Hạn dùng phải sau hôm nay và cách ngày sản xuất tối thiểu 30 ngày.",
  ],
  example: [{ productCode: "TH0001", productName: "Paracetamol 500mg", unit: "Hộp", quantity: 20, unitCost: 30000, batchNumber: "PA260901", manufactureDate: "01/09/2026", expiryDate: "01/09/2028" }],
  plan: (rows, ctx) => planStockLines(rows, RECEIPT_LINE_COLUMNS, { storeId: ctx.storeId, checkExistingBatch: false }),
};
