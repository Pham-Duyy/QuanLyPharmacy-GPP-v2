import ExcelJS from "exceljs";
import { AppError } from "../../lib/app-error.js";
import { MAX_CSV_BYTES, MAX_CSV_ROWS, normalizeText, parseTemporal } from "./parse.js";
import type { Dataset, RawCell } from "./types.js";

/**
 * Đọc bảng số liệu từ tệp Excel do người dùng tự lập, không theo mẫu nào:
 * có thể có dòng tiêu đề báo cáo phía trên, ô gộp, công thức, dòng "Tổng
 * cộng", và bảng ngang kiểu "Chi nhánh | T1 | T2 | … | T12".
 */

export type SheetInfo = { name: string; rows: number };

export type WorkbookSource = {
  kind: "xlsx";
  sheets: SheetInfo[];
  sheet: string;
  /** Những gì đã tự xử lý khi đọc, để người dùng biết bảng được hiểu thế nào. */
  notes: string[];
};

const TOTAL_ROW = /^(tong|tong cong|cong|total|grand total|sum|subtotal)\b/;
/** Tiêu đề cột tháng không ghi năm: "T1", "Tháng 1", "Th1". */
const BARE_MONTH = /^(?:thang|th|t)\s*(\d{1,2})$/;

function invalid(message: string): AppError {
  return new AppError(422, "INVALID_FILE", message);
}

/** Excel lưu ngày giờ theo "giờ tường"; exceljs trả về Date UTC mang đúng giờ đó. */
function dateText(value: Date): string {
  const iso = value.toISOString();
  const time = iso.slice(11, 16);
  return time === "00:00" ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${time}`;
}

/** Giá trị thật của ô: công thức lấy kết quả, chữ định dạng lấy chữ, lỗi #N/A là trống. */
function unwrap(value: ExcelJS.CellValue): RawCell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return dateText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? "Có" : "Không";
  if (typeof value === "object") {
    if ("error" in value) return null;
    if ("result" in value) return unwrap(value.result as ExcelJS.CellValue);
    if ("richText" in value)
      return (
        value.richText
          .map((part) => part.text)
          .join("")
          .trim() || null
      );
    if ("text" in value) return String(value.text).trim() || null;
    return null;
  }
  const text = String(value).trim();
  return text === "" ? null : text;
}

function sheetMatrix(sheet: ExcelJS.Worksheet): RawCell[][] {
  const matrix: RawCell[][] = [];
  const width = sheet.actualColumnCount > 0 ? sheet.columnCount : 0;
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: RawCell[] = [];
    // Ô gộp: exceljs trả giá trị của ô chính cho mọi ô trong vùng gộp.
    for (let column = 1; column <= width; column += 1)
      cells.push(unwrap(row.getCell(column).value));
    matrix[rowNumber - 1] = cells;
  });
  for (let index = 0; index < matrix.length; index += 1) matrix[index] ??= [];
  return matrix;
}

const filled = (row: RawCell[]) => row.filter((cell) => cell !== null).length;

/**
 * Dòng tiêu đề bảng: trong 20 dòng đầu, dòng đầu tiên có nhiều ô gần bằng
 * dòng rộng nhất và toàn chữ (tiêu đề không phải số). Các dòng phía trên là
 * tên báo cáo, kỳ báo cáo… bị bỏ qua.
 */
function findHeaderRow(matrix: RawCell[][]): number {
  const head = matrix.slice(0, 20);
  const widest = Math.max(0, ...head.map(filled));
  if (widest < 2) return -1;
  return head.findIndex((row) => {
    const values = row.filter((cell) => cell !== null);
    const texty = values.filter(
      (cell) => typeof cell === "string" && !/^-?[\d.,\s]+$/.test(cell),
    ).length;
    // Ô tiêu đề gộp ngang cả bảng lặp một chữ ở mọi cột: không phải dòng tên cột.
    const distinct = new Set(values.map(String)).size;
    return (
      values.length >= Math.max(2, Math.ceil(widest * 0.6)) &&
      texty >= values.length * 0.6 &&
      distinct >= Math.max(2, values.length * 0.6)
    );
  });
}

function isTotalRow(row: RawCell[]): boolean {
  const firstText = row.find((cell): cell is string => typeof cell === "string");
  return firstText !== undefined && TOTAL_ROW.test(normalizeText(firstText));
}

function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name}_${count}`;
  });
}

/**
 * Bảng ngang (mỗi cột là một kỳ) đổi thành bảng dọc: mỗi dòng một kỳ, để
 * phân tích theo thời gian như bảng thường.
 */
function unpivotPeriods(
  columns: string[],
  rows: RawCell[][],
  context: string,
  notes: string[],
): { columns: string[]; rows: RawCell[][] } | null {
  const yearInContext = /\b(19|20)\d{2}\b/.exec(context)?.[0];
  const periodOf = (header: string): string | null => {
    const parsed = parseTemporal(header);
    if (parsed) {
      const iso = parsed.at.toISOString();
      return parsed.precision === "month" ? iso.slice(0, 7) : header;
    }
    const bare = BARE_MONTH.exec(normalizeText(header));
    if (bare && yearInContext) {
      const month = Number(bare[1]);
      if (month >= 1 && month <= 12) return `${yearInContext}-${String(month).padStart(2, "0")}`;
    }
    return null;
  };
  const periods = columns.map(periodOf);
  const periodColumns = periods.filter((period) => period !== null).length;
  if (periodColumns < 3) {
    if (
      !yearInContext &&
      columns.filter((column) => BARE_MONTH.test(normalizeText(column))).length >= 3
    )
      notes.push(
        "Các cột tháng không ghi năm và tiêu đề bảng cũng không có năm: thêm năm (ví dụ T1/2025) để phân tích theo thời gian",
      );
    return null;
  }

  const keep = columns.map((_, index) => index).filter((index) => periods[index] === null);
  const measure = /doanh thu|doanh so/.test(normalizeText(context))
    ? "doanh_thu"
    : /so luong/.test(normalizeText(context))
      ? "so_luong"
      : "gia_tri";
  const long: RawCell[][] = [];
  for (const row of rows) {
    periods.forEach((period, index) => {
      if (period === null || row[index] === null || row[index] === undefined) return;
      long.push([...keep.map((column) => row[column] ?? null), period, row[index]!]);
    });
  }
  notes.push(
    `Bảng ngang có ${periodColumns} cột kỳ (${columns.find((_, index) => periods[index])}…): đã chuyển thành dạng mỗi dòng một kỳ`,
  );
  return {
    columns: uniqueNames([...keep.map((index) => columns[index]!), "thoi_gian", measure]),
    rows: long,
  };
}

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  if (buffer.length === 0) throw invalid("Tệp rỗng");
  if (buffer.length > MAX_CSV_BYTES) throw invalid("Tệp quá lớn, tối đa 5 MB");
  // .xlsx là tệp zip: bắt đầu bằng "PK".
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b)
    throw invalid(
      "Chỉ nhận Excel .xlsx (Excel 2007 trở lên). Tệp .xls cũ hãy mở bằng Excel rồi Lưu thành .xlsx",
    );
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw invalid("Không đọc được tệp Excel, tệp có thể bị hỏng hoặc có mật khẩu");
  }
  return workbook;
}

/**
 * Đọc một sheet thành bảng dữ liệu. Không chỉ định sheet thì lấy sheet đầu
 * tiên có bảng (ít nhất hai cột, một dòng số liệu).
 */
export async function readWorkbook(
  buffer: Buffer,
  fileName: string,
  requestedSheet?: string,
): Promise<{ dataset: Dataset; source: WorkbookSource }> {
  const workbook = await loadWorkbook(buffer);
  const visible = workbook.worksheets.filter((sheet) => sheet.state === "visible");
  const sheets: SheetInfo[] = visible.map((sheet) => ({
    name: sheet.name,
    rows: sheet.actualRowCount,
  }));
  if (sheets.length === 0) throw invalid("Tệp không có sheet nào");

  let candidates = visible;
  if (requestedSheet) {
    const sheet = visible.find((item) => item.name === requestedSheet);
    if (!sheet) throw invalid(`Không có sheet "${requestedSheet}" trong tệp`);
    candidates = [sheet];
  }

  for (const sheet of candidates) {
    const notes: string[] = [];
    const matrix = sheetMatrix(sheet);
    const headerIndex = findHeaderRow(matrix);
    if (headerIndex < 0) continue;

    const headerRow = matrix[headerIndex]!;
    const used = headerRow
      .map((_, column) => column)
      .filter((column) =>
        matrix.slice(headerIndex).some((row) => row[column] !== null && row[column] !== undefined),
      );
    let columns = uniqueNames(
      used.map((column) => {
        const header = headerRow[column];
        return header === null || header === undefined ? `cot_${column + 1}` : String(header);
      }),
    );
    if (headerIndex > 0) notes.push(`Bỏ ${headerIndex} dòng tiêu đề báo cáo phía trên bảng`);

    const titles = matrix
      .slice(0, headerIndex)
      .flat()
      .filter((cell) => cell !== null)
      .join(" ");
    let rows: RawCell[][] = [];
    let totals = 0;
    for (const row of matrix.slice(headerIndex + 1)) {
      const cells = used.map((column) => row[column] ?? null);
      if (filled(cells) === 0) continue;
      if (isTotalRow(cells)) {
        totals += 1;
        continue;
      }
      rows.push(cells);
    }
    if (totals > 0) notes.push(`Bỏ ${totals} dòng "Tổng cộng" để không bị cộng trùng`);
    if (rows.length === 0) continue;

    const long = unpivotPeriods(columns, rows, `${titles} ${sheet.name}`, notes);
    if (long) ({ columns, rows } = long);
    if (rows.length > MAX_CSV_ROWS)
      throw invalid(`Sheet có quá ${MAX_CSV_ROWS.toLocaleString("vi-VN")} dòng`);

    return {
      dataset: { name: `${fileName} › ${sheet.name}`, columns, rows },
      source: { kind: "xlsx", sheets, sheet: sheet.name, notes },
    };
  }
  throw invalid(
    requestedSheet
      ? `Sheet "${requestedSheet}" không có bảng số liệu (cần dòng tiêu đề cột và ít nhất một dòng dữ liệu)`
      : "Không tìm thấy bảng số liệu nào trong tệp (cần dòng tiêu đề cột và ít nhất một dòng dữ liệu)",
  );
}

export function looksLikeXlsx(buffer: Buffer, fileName: string): boolean {
  return /\.xlsx$/i.test(fileName) || (buffer[0] === 0x50 && buffer[1] === 0x4b);
}
