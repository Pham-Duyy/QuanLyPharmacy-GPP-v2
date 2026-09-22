import ExcelJS from "exceljs";
import { AppError } from "../../lib/app-error.js";

/** Kiểu dữ liệu một cột: quyết định định dạng khi xuất và cách đọc khi nhập. */
export type CellKind = "text" | "int" | "money" | "percent" | "date" | "datetime";

export type ColumnDef = {
  key: string;
  header: string;
  kind?: CellKind;
  width?: number;
  required?: boolean;
  /** Mô tả ngắn cho sheet "Hướng dẫn". */
  note?: string;
};

export type SheetSpec = {
  name: string;
  columns: ColumnDef[];
  rows: Array<Record<string, unknown>>;
};

const HEADER_FILL = "FF0B2447";
const REQUIRED_FILL = "FF0876EB";

/**
 * Dựng file .xlsx: hàng tiêu đề đậm nền xanh (cột bắt buộc màu nhấn), cố
 * định hàng đầu, bật lọc, định dạng số tiền/ngày kiểu Việt Nam. Giá trị luôn
 * ghi dưới dạng dữ liệu, không bao giờ là công thức — ô bắt đầu bằng "=" vẫn
 * chỉ là chữ, nên không có rủi ro chèn công thức khi mở bằng Excel.
 */
export async function buildWorkbook(
  sheets: SheetSpec[],
  guide?: { title: string; lines: string[]; columns?: ColumnDef[] },
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Pharmacy GPP";
  workbook.created = new Date();

  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = sheet.columns.map((column) => ({
      key: column.key,
      header: column.required ? `${column.header} *` : column.header,
      width: column.width ?? Math.max(12, Math.min(40, column.header.length + 4)),
      style: styleFor(column.kind),
    }));
    const header = ws.getRow(1);
    header.height = 22;
    sheet.columns.forEach((column, index) => {
      const cell = header.getCell(index + 1);
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: column.required ? REQUIRED_FILL : HEADER_FILL } };
      cell.alignment = { vertical: "middle" };
    });
    for (const row of sheet.rows) ws.addRow(row);
    if (sheet.columns.length > 0) {
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
    }
  }

  if (guide) {
    const ws = workbook.addWorksheet("Hướng dẫn");
    ws.getColumn(1).width = 34;
    ws.getColumn(2).width = 90;
    ws.addRow([guide.title]).font = { bold: true, size: 14 };
    for (const line of guide.lines) ws.addRow([line]);
    if (guide.columns) {
      ws.addRow([]);
      const head = ws.addRow(["Cột", "Ý nghĩa"]);
      head.font = { bold: true };
      for (const column of guide.columns) {
        ws.addRow([column.required ? `${column.header} *` : column.header, column.note ?? ""]);
      }
    }
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function styleFor(kind: CellKind | undefined): Partial<ExcelJS.Style> {
  switch (kind) {
    case "money":
    case "int":
      return { numFmt: "#,##0" };
    case "percent":
      return { numFmt: "0.##" };
    case "date":
      return { numFmt: "dd/mm/yyyy" };
    case "datetime":
      return { numFmt: "dd/mm/yyyy hh:mm" };
    default:
      return {};
  }
}

/** Bỏ dấu, dấu "*", khoảng trắng thừa để khớp tiêu đề cột do người dùng gõ lại. */
export function normalizeHeader(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;

export type RawRow = { rowNumber: number; values: Record<string, unknown> };

/**
 * Đọc sheet đầu tiên của file .xlsx: hàng 1 là tiêu đề, khớp theo tên cột
 * (không phân biệt dấu, hoa thường, thứ tự cột). Bỏ qua hàng trống.
 */
export async function readSheet(buffer: Buffer, columns: ColumnDef[]): Promise<{ rows: RawRow[]; missingColumns: string[] }> {
  if (buffer.length === 0) throw invalidFile("Tệp rỗng");
  if (buffer.length > MAX_IMPORT_BYTES) throw invalidFile("Tệp quá lớn, tối đa 5 MB");
  // .xlsx là tệp zip: bắt đầu bằng "PK". Chặn sớm .xls cũ, .csv hay tệp giả.
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw invalidFile("Chỉ nhận tệp Excel .xlsx (Excel 2007 trở lên). Tệp .xls cũ hãy mở bằng Excel rồi Lưu thành .xlsx");
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw invalidFile("Không đọc được tệp Excel, tệp có thể bị hỏng");
  }
  const ws = workbook.worksheets.find((sheet) => sheet.name !== "Hướng dẫn") ?? workbook.worksheets[0];
  if (!ws) throw invalidFile("Tệp không có sheet dữ liệu");

  const byHeader = new Map(columns.map((column) => [normalizeHeader(column.header), column]));
  const positions = new Map<number, ColumnDef>();
  ws.getRow(1).eachCell((cell, col) => {
    const column = byHeader.get(normalizeHeader(cellText(cell.value)));
    if (column) positions.set(col, column);
  });
  const found = new Set([...positions.values()].map((column) => column.key));
  const missingColumns = columns.filter((column) => column.required && !found.has(column.key)).map((column) => column.header);

  const rows: RawRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const values: Record<string, unknown> = {};
    let hasValue = false;
    for (const [col, column] of positions) {
      const raw = unwrap(row.getCell(col).value);
      if (raw !== null && raw !== "") hasValue = true;
      values[column.key] = raw;
    }
    if (hasValue) rows.push({ rowNumber, values });
  });
  if (rows.length > MAX_IMPORT_ROWS) {
    throw invalidFile(`Tệp có ${rows.length} dòng, tối đa ${MAX_IMPORT_ROWS} dòng mỗi lần nhập`);
  }
  return { rows, missingColumns };
}

function invalidFile(message: string): AppError {
  return new AppError(422, "INVALID_FILE", message);
}

/** Lấy giá trị thật của ô: công thức lấy kết quả, rich text/hyperlink lấy chữ. */
function unwrap(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    if ("result" in value) return unwrap(value.result as ExcelJS.CellValue);
    if ("richText" in value) return value.richText.map((part) => part.text).join("").trim();
    if ("text" in value) return String(value.text).trim();
    if ("error" in value) return null;
  }
  return typeof value === "string" ? value.trim() : value;
}

function cellText(value: ExcelJS.CellValue): string {
  const raw = unwrap(value);
  return raw === null ? "" : String(raw);
}

// ---------------------------------------------------------------------------
// Đọc giá trị ô theo kiểu, trả lỗi dễ hiểu
// ---------------------------------------------------------------------------

export class CellError extends Error {}

export function asText(value: unknown, max: number, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = (value instanceof Date ? value.toISOString().slice(0, 10) : String(value)).trim();
  if (text.length > max) throw new CellError(`${label} dài quá ${max} ký tự`);
  return text || null;
}

export function asInt(value: unknown, label: string, options: { min?: number } = {}): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).replace(/[.,\s](?=\d{3}\b)/g, "").replace(",", "."));
  if (!Number.isFinite(number) || !Number.isInteger(number)) throw new CellError(`${label} phải là số nguyên`);
  if (options.min !== undefined && number < options.min) throw new CellError(`${label} phải từ ${options.min} trở lên`);
  return number;
}

export function asNumber(value: unknown, label: string, options: { min?: number; max?: number } = {}): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  if (!Number.isFinite(number)) throw new CellError(`${label} phải là số`);
  if (options.min !== undefined && number < options.min) throw new CellError(`${label} phải từ ${options.min} trở lên`);
  if (options.max !== undefined && number > options.max) throw new CellError(`${label} tối đa ${options.max}`);
  return number;
}

/**
 * Ngày: ô kiểu ngày của Excel, hoặc chữ dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd.
 * Trả về nửa đêm UTC đúng ngày (cột `date` trong CSDL).
 */
export function asDate(value: unknown, label: string): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  if (typeof value === "number") {
    // Số sê-ri ngày của Excel (gốc 30/12/1899).
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000);
    return Number.isNaN(date.getTime()) ? fail() : date;
  }
  const text = String(value).trim();
  let match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (match) return build(Number(match[3]), Number(match[2]), Number(match[1]));
  match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) return build(Number(match[1]), Number(match[2]), Number(match[3]));
  return fail();

  function build(year: number, month: number, day: number): Date {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return fail();
    return date;
  }
  function fail(): never {
    throw new CellError(`${label} không đúng ngày (dạng dd/mm/yyyy)`);
  }
}

/** Khớp giá trị chữ với danh sách lựa chọn (không phân biệt dấu/hoa thường). */
export function asChoice<T extends string | boolean>(value: unknown, label: string, choices: Record<string, T>): T | null {
  if (value === null || value === undefined || value === "") return null;
  const key = normalizeHeader(String(value));
  const found = Object.entries(choices).find(([name]) => normalizeHeader(name) === key);
  if (!found) throw new CellError(`${label} không hợp lệ, chọn một trong: ${Object.keys(choices).join(", ")}`);
  return found[1];
}
