import {
  detectNumberStyle,
  normalizeText,
  parseNumber,
  parseTemporal,
  parseYear,
  type TemporalValue,
} from "./parse.js";
import type { ColumnSummary, DataSummary, Dataset, TemporalPrecision } from "./types.js";

/** Cột đã đổi kiểu, dùng cho bước tính toán; bản tóm tắt gửi AI chỉ là `summary`. */
export type TypedColumn = {
  summary: ColumnSummary;
  texts: Array<string | null>;
  numbers: Array<number | null> | null;
  times: Array<TemporalValue | null> | null;
};

export type TypedDataset = {
  name: string;
  rowCount: number;
  columns: TypedColumn[];
  byName: Map<string, TypedColumn>;
};

/** Ít nhất tỉ lệ này ô có giá trị đọc được thì mới nhận kiểu cho cả cột. */
const TYPE_THRESHOLD = 0.9;
const MAX_CATEGORIES = 60;

const IDENTIFIER_NAME = /(^| )(ma|id|code|stt|so thu tu|sdt|so dien thoai|phone|zip)( |$)/;
const YEAR_NAME = /^(nam|year|nam tai chinh)$/;

const PRECISION_ORDER: TemporalPrecision[] = ["minute", "hour", "day", "month", "year"];

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatTemporal(value: TemporalValue): string {
  const iso = value.at.toISOString();
  switch (value.precision) {
    case "year":
      return iso.slice(0, 4);
    case "month":
      return iso.slice(0, 7);
    case "day":
      return iso.slice(0, 10);
    default:
      return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }
}

function profileColumn(name: string, raw: Array<string | number | null>): TypedColumn {
  const texts = raw.map((cell) => (cell === null ? null : String(cell)));
  const present = texts.filter((cell): cell is string => cell !== null);
  const missing = texts.length - present.length;
  const distinctValues = new Set(present);
  const samples = [...distinctValues].slice(0, 5);
  const base = { name, distinct: distinctValues.size, missing, samples };
  const normalized = normalizeText(name);

  // Thời gian trước số: `2025-03` cũng là chuỗi số nếu đọc lỏng.
  const yearColumn = YEAR_NAME.test(normalized);
  const times = raw.map((cell) => (yearColumn ? parseYear(cell) : parseTemporal(cell)));
  const timeHits = times.filter((value) => value !== null) as TemporalValue[];
  if (present.length > 0 && timeHits.length >= present.length * TYPE_THRESHOLD) {
    const ordered = timeHits.map((value) => value.at.getTime()).sort((a, b) => a - b);
    // Có giờ phút mà toàn 0 giờ 0 phút thì thực chất chỉ là ngày.
    let precision = timeHits.reduce<TemporalPrecision>(
      (finest, value) =>
        PRECISION_ORDER.indexOf(value.precision) < PRECISION_ORDER.indexOf(finest)
          ? value.precision
          : finest,
      "year",
    );
    if (precision === "minute") {
      const minutes = timeHits.some((value) => value.at.getUTCMinutes() !== 0);
      const hours = timeHits.some((value) => value.at.getUTCHours() !== 0);
      precision = minutes ? "minute" : hours ? "hour" : "day";
    }
    const start = timeHits.find((value) => value.at.getTime() === ordered[0])!;
    const end = timeHits.find((value) => value.at.getTime() === ordered.at(-1))!;
    return {
      summary: {
        ...base,
        kind: "temporal",
        temporalPrecision: precision,
        start: formatTemporal({ at: start.at, precision }),
        end: formatTemporal({ at: end.at, precision }),
      },
      texts,
      numbers: null,
      times: times.map((value) => (value ? { at: value.at, precision } : null)),
    };
  }

  const numberStyle = detectNumberStyle(present);
  const numbers = raw.map((cell) => parseNumber(cell, numberStyle));
  const numberHits = numbers.filter((value): value is number => value !== null);
  if (
    present.length > 0 &&
    numberHits.length >= present.length * TYPE_THRESHOLD &&
    !IDENTIFIER_NAME.test(normalized) &&
    !/^(hang|xep hang|rank|stt|thu tu|so thu tu)$/.test(normalized)
  ) {
    const sum = numberHits.reduce((total, value) => total + value, 0);
    return {
      summary: {
        ...base,
        kind: "numeric",
        numberStyle,
        min: Math.min(...numberHits),
        max: Math.max(...numberHits),
        mean: round(sum / numberHits.length),
        sum: round(sum),
      },
      texts,
      numbers,
      times: null,
    };
  }

  const counts = new Map<string, number>();
  for (const value of present) counts.set(value, (counts.get(value) ?? 0) + 1);
  const topValues = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([value, count]) => ({ value, count }));
  const categorical =
    distinctValues.size <= MAX_CATEGORIES || distinctValues.size <= present.length * 0.5;
  return {
    summary: { ...base, kind: categorical ? "categorical" : "text", topValues },
    texts,
    numbers: null,
    times: null,
  };
}

/**
 * Bước Summarizer của LIDA: suy ra kiểu từng cột và thống kê gọn. Bản tóm
 * tắt này là thứ AI nhìn thấy thay cho dữ liệu gốc.
 */
export function profileDataset(dataset: Dataset): TypedDataset {
  const columns = dataset.columns.map((name, index) =>
    profileColumn(
      name,
      dataset.rows.map((row) => row[index] ?? null),
    ),
  );
  return {
    name: dataset.name,
    rowCount: dataset.rows.length,
    columns,
    byName: new Map(columns.map((column) => [column.summary.name, column])),
  };
}

export function toSummary(typed: TypedDataset): DataSummary {
  return {
    name: typed.name,
    rowCount: typed.rowCount,
    columns: typed.columns.map((column) => column.summary),
  };
}
