import { AppError } from "../../lib/app-error.js";
import type { Dataset, NumberStyle, RawCell, TemporalPrecision } from "./types.js";

export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 100_000;

/** Đếm dấu phân cách ngoài ngoặc kép ở dòng tiêu đề để chọn `,` `;` hay tab. */
function detectDelimiter(headerLine: string): string {
  const candidates = [",", ";", "\t"];
  let best = ",";
  let bestCount = -1;
  for (const candidate of candidates) {
    let count = 0;
    let quoted = false;
    for (const char of headerLine) {
      if (char === '"') quoted = !quoted;
      else if (!quoted && char === candidate) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Đọc CSV theo RFC 4180: ô có ngoặc kép, ngoặc kép lồng `""`, xuống dòng
 * trong ô, CRLF. Bỏ BOM mà Excel thêm khi lưu "CSV UTF-8".
 */
export function parseCsv(text: string, name: string): Dataset {
  const source = text.replace(/^﻿/, "");
  const firstLineEnd = source.search(/\r?\n/);
  const delimiter = detectDelimiter(firstLineEnd === -1 ? source : source.slice(0, firstLineEnd));

  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      if (records.length > MAX_CSV_ROWS + 1)
        throw AppError.validation(`Tệp có quá ${MAX_CSV_ROWS.toLocaleString("vi-VN")} dòng`);
    } else field += char;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((row) => row.some((cell) => cell.trim() !== ""));
  if (nonEmpty.length < 2)
    throw AppError.validation("Tệp CSV cần dòng tiêu đề và ít nhất một dòng dữ liệu");

  const header = nonEmpty[0]!.map((cell, index) => cell.trim() || `cot_${index + 1}`);
  const seen = new Map<string, number>();
  const columns = header.map((column) => {
    const count = (seen.get(column) ?? 0) + 1;
    seen.set(column, count);
    return count === 1 ? column : `${column}_${count}`;
  });

  const rows: RawCell[][] = nonEmpty.slice(1).map((row) =>
    columns.map((_, index) => {
      const value = row[index]?.trim() ?? "";
      return value === "" ? null : value;
    }),
  );
  return { name, columns, rows };
}

// --- Số ----------------------------------------------------------------------

const CURRENCY = /(vnđ|vnd|đồng|đ|₫|usd|\$|%)/gi;

function stripNumber(value: string): string {
  return value.replace(CURRENCY, "").replace(/\s/g, "");
}

/**
 * Chọn cách viết số cho cả cột, vì một giá trị lẻ như `1.500` không tự biết
 * là một nghìn năm trăm hay một phẩy năm.
 */
export function detectNumberStyle(values: string[]): NumberStyle {
  let vn = 0;
  let intl = 0;
  let threeDigitDots = 0;
  let otherDots = 0;
  for (const raw of values) {
    const value = stripNumber(raw);
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(value) && /\.\d{3}(\.|,|$)/.test(value)) {
      if (/\.\d{3}\./.test(value) || value.includes(",")) vn += 1;
      else threeDigitDots += 1;
    } else if (/^-?\d+\.\d+$/.test(value)) otherDots += 1;
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(value)) intl += 1;
    else if (/^-?\d+,\d{1,2}$/.test(value)) vn += 1;
  }
  if (vn > 0 && vn >= intl) return "vn";
  if (intl > 0) return "intl";
  // Toàn `x.yyy` mà không có số thập phân kiểu khác: gần như chắc là phân cách nghìn.
  if (threeDigitDots > 0 && otherDots === 0) return "vn";
  return "plain";
}

export function parseNumber(raw: RawCell, style: NumberStyle): number | null {
  if (raw === null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let value = stripNumber(raw);
  if (value === "" || value === "-") return null;
  const negative = /^\(.*\)$/.test(value);
  if (negative) value = value.slice(1, -1);
  if (style === "vn") value = value.replace(/\./g, "").replace(",", ".");
  else if (style === "intl") value = value.replace(/,/g, "");
  else if (/^-?\d+,\d+$/.test(value)) value = value.replace(",", ".");
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value)) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return negative ? -number : number;
}

// --- Thời gian ---------------------------------------------------------------

/**
 * Mốc thời gian lưu dưới dạng Date "giờ tường" (đọc bằng getUTC*), không
 * đổi múi giờ: `2025-03-01 08:00` trong tệp là 8 giờ sáng ở cửa hàng.
 */
export type TemporalValue = { at: Date; precision: TemporalPrecision };

function build(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  precision: TemporalPrecision,
): TemporalValue | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (at.getUTCDate() !== day) return null;
  return { at, precision };
}

function withTime(
  year: number,
  month: number,
  day: number,
  hour: string | undefined,
  minute: string | undefined,
): TemporalValue | null {
  if (hour === undefined) return build(year, month, day, 0, 0, "day");
  return build(year, month, day, Number(hour), Number(minute ?? 0), "minute");
}

/**
 * Nhận các cách ghi ngày tháng hay gặp trong tệp kinh doanh ở Việt Nam:
 * `2025-03-01`, `2025-03-01 08:30`, ISO có `T`, `01/03/2025` (ngày trước),
 * `2025-03`, `03/2025`, `T3/2025`, `Tháng 3/2025`, `Q1/2025`.
 */
export function parseTemporal(raw: RawCell): TemporalValue | null {
  if (raw === null || typeof raw === "number") return null;
  const value = raw.trim();
  let match =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      value,
    );
  if (match) return withTime(+match[1]!, +match[2]!, +match[3]!, match[4], match[5]);

  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(value);
  if (match) return withTime(+match[3]!, +match[2]!, +match[1]!, match[4], match[5]);

  match = /^(\d{4})[-/](\d{1,2})$/.exec(value);
  if (match) return build(+match[1]!, +match[2]!, 1, 0, 0, "month");

  match = /^(?:th[áa]ng\s*|t)?(\d{1,2})[/.-](\d{4})$/i.exec(value);
  if (match) return build(+match[2]!, +match[1]!, 1, 0, 0, "month");

  match = /^(?:q|qu[ýy]\s*)([1-4])[/.\s-]*(\d{4})$/i.exec(value);
  if (match) return build(+match[2]!, (+match[1]! - 1) * 3 + 1, 1, 0, 0, "month");

  match = /^(\d{4})[-\s]?q([1-4])$/i.exec(value);
  if (match) return build(+match[1]!, (+match[2]! - 1) * 3 + 1, 1, 0, 0, "month");

  return null;
}

/** Tên cột năm (`nam`, `year`) chứa số bốn chữ số thì coi là thời gian. */
export function parseYear(raw: RawCell): TemporalValue | null {
  const text = typeof raw === "number" ? String(raw) : raw?.trim();
  if (!text || !/^\d{4}$/.test(text)) return null;
  return build(Number(text), 1, 1, 0, 0, "year");
}

// --- Chuẩn hóa chữ -----------------------------------------------------------

/** Bỏ dấu tiếng Việt, chữ thường, gạch dưới thành khoảng trắng: so khớp tên cột với câu hỏi. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
