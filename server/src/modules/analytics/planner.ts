import { z } from "zod";
import { normalizeText } from "./parse.js";
import type { TypedDataset } from "./summarize.js";
import {
  AGGREGATES,
  FILTER_OPERATORS,
  FOCUSES,
  GRAINS,
  type AnalysisPlan,
  type ColumnSummary,
  type DataSummary,
  type Grain,
  type ValueFormat,
} from "./types.js";

/**
 * Lược đồ kế hoạch. Dùng chung cho đầu ra có cấu trúc của AI và cho kế hoạch
 * trình duyệt gửi lại khi tự làm mới, nên không đặt ràng buộc min/max ở đây:
 * `validatePlan` sửa giá trị lệch thay vì từ chối cả kế hoạch.
 */
export const analysisPlanSchema = z.object({
  intent: z.string(),
  measure: z.object({
    column: z.string().nullable(),
    aggregate: z.enum(AGGREGATES),
    label: z.string(),
  }),
  time: z
    .object({
      column: z.string(),
      grain: z.enum(GRAINS),
      lastPeriods: z.number().int().nullable(),
    })
    .nullable(),
  groupBy: z.object({ column: z.string(), topN: z.number().int().nullable() }).nullable(),
  filters: z.array(
    z.object({
      column: z.string(),
      operator: z.enum(FILTER_OPERATORS),
      values: z.array(z.string()),
    }),
  ),
  focus: z.enum(FOCUSES),
});

const GRAIN_WORDS: Array<{ grain: Grain; pattern: RegExp }> = [
  { grain: "minute", pattern: /\bphut\b|\bminute/ },
  { grain: "hour", pattern: /\bgio\b|\bhour/ },
  { grain: "day", pattern: /\bngay\b|\bday|\bdaily/ },
  { grain: "week", pattern: /\btuan\b|\bweek/ },
  { grain: "month", pattern: /\bthang\b|\bmonth/ },
  { grain: "quarter", pattern: /\bquy\b|\bquarter/ },
  { grain: "year", pattern: /\bnam\b|\byear/ },
];

/** Độ dài xấp xỉ mỗi đơn vị, chỉ để đổi "3 giờ" ra số phút, "2 năm" ra số quý. */
const GRAIN_MINUTES: Record<Grain, number> = {
  minute: 1,
  hour: 60,
  day: 1440,
  week: 10_080,
  month: 43_830,
  quarter: 131_490,
  year: 525_960,
};

/** Đại lượng tiền được ưu tiên khi câu hỏi không nói rõ. */
const MONEY_HINT =
  /doanh thu|doanh so|revenue|tien|gia tri|thanh tien|loi nhuan|lai gop|profit|amount/;

const MEASURE_HINT =
  /doanh thu|doanh so|revenue|sales|tien|amount|total|tong|gia tri|thanh tien|loi nhuan|profit|so luong|quantity|qty/;
const GROUP_HINT =
  /chi nhanh|cua hang|nha thuoc|store|branch|khu vuc|region|tinh|thanh pho|nhom|category|danh muc|san pham|product|kenh|channel|nhan vien/;
const COMPARE_HINT =
  /so sanh|compare|chi nhanh|cua hang|nhom|theo tung|xep hang|rank|cao nhat|thap nhat|manh nhat|nhieu nhat|it nhat/;
const CHANGE_HINT = /tang|giam|bien dong|thay doi|change|growth|decline|sut/;
const SHARE_HINT = /ty trong|ti trong|co cau|chiem|share|phan tram/;
const CURRENCY_HINT =
  /doanh|thu|tien|gia|revenue|amount|vnd|chi phi|cost|loi nhuan|lai gop|lai|profit|sales|von/;

/** Từ nối không mang nghĩa khi so tên cột với câu hỏi. */
const STOP_WORDS = new Set([
  "cua",
  "va",
  "cac",
  "nao",
  "nhat",
  "da",
  "gom",
  "co",
  "ck",
  "vat",
  "trong",
  "theo",
]);
/** Cột thứ hạng, số thứ tự: là nhãn, cộng lại vô nghĩa. */
const RANK_NAME = /^(hang|xep hang|rank|stt|thu tu|so thu tu)$/;
const PERCENT_NAME = /ty trong|ti trong|ty le|ti le|phan tram|percent/;
/** Câu hỏi nhắc "mặt hàng", "thuốc" thì nhóm theo cột tên sản phẩm. */
const ENTITY_QUESTION = /mat hang|san pham|thuoc|hang hoa|product|item/;
const ENTITY_COLUMN = /ten san pham|san pham|ten thuoc|mat hang|ten hang|^ten$|product|name|item/;
/** Bảng chỉ tiêu: mỗi dòng một chỉ tiêu khác loại (số phiếu, tiền…), không cộng dồn được. */
export const METRIC_LABEL =
  /^(chi tieu|khoan muc|hang muc|noi dung|metric|indicator|ten chi tieu)$/;
const TIME_WORDS =
  /xu huong|theo (phut|gio|ngay|tuan|thang|quy|nam)|gan nhat|tang|giam|bien dong|trend|over time/;
const RANKING_WORDS =
  /\bnao\b|xep hang|\btop\b|cao nhat|thap nhat|nhieu nhat|it nhat|lon nhat|nho nhat|which|highest|lowest/;

/**
 * Mức khớp giữa câu hỏi và tên cột: nhắc nguyên tên được điểm cao, còn lại
 * đếm số từ của tên cột có trong câu hỏi. "Doanh thu thuần" thắng "Hạng" khi
 * hỏi "mặt hàng nào doanh thu thuần cao nhất".
 */
function relevance(question: string, column: ColumnSummary): number {
  const name = normalizeText(column.name);
  if (name.length > 1 && ` ${question} `.includes(` ${name} `) && name.includes(" ")) return 10;
  const words = new Set(question.split(" "));
  return name
    .split(" ")
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .filter((word) => words.has(word)).length;
}

function best<T>(items: T[], score: (item: T) => number): T | undefined {
  let winner: T | undefined;
  let top = 0;
  for (const item of items) {
    const value = score(item);
    if (value > top) {
      top = value;
      winner = item;
    }
  }
  return winner;
}

function mentioned(question: string, column: ColumnSummary): boolean {
  const name = normalizeText(column.name);
  return name.length > 1 && ` ${question} `.includes(` ${name} `);
}

/** Đơn vị thời gian hợp lý theo độ dài khoảng dữ liệu, để biểu đồ có từ ~6 tới ~60 điểm. */
function grainForSpan(column: ColumnSummary): Grain {
  if (column.temporalPrecision === "year") return "year";
  if (!column.start || !column.end) return "month";
  const hours =
    (new Date(`${column.end.replace(" ", "T")}Z`).getTime() -
      new Date(`${column.start.replace(" ", "T")}Z`).getTime()) /
    3_600_000;
  const candidates: Array<[Grain, number]> = [
    ["minute", 3],
    ["hour", 72],
    ["day", 24 * 75],
    ["week", 24 * 7 * 30],
    ["month", 24 * 365 * 5],
    ["quarter", 24 * 365 * 15],
  ];
  const allowed = GRAINS.slice(GRAINS.indexOf(column.temporalPrecision ?? "day"));
  for (const [grain, limit] of candidates) {
    if (allowed.includes(grain) && hours <= limit) return grain;
  }
  return "year";
}

/**
 * Lập kế hoạch bằng luật khi chưa cấu hình AI hoặc AI lỗi. Đủ cho câu hỏi
 * kiểu "xu hướng doanh thu 12 tháng, chi nhánh nào giảm mạnh nhất".
 */
export function planWithRules(summary: DataSummary, rawQuestion: string): AnalysisPlan {
  const question = normalizeText(rawQuestion);
  const temporal = summary.columns.filter((column) => column.kind === "temporal");
  const numeric = summary.columns.filter((column) => column.kind === "numeric");
  const categorical = summary.columns.filter(
    (column) => column.kind === "categorical" && column.distinct >= 2,
  );

  // Cột thứ hạng và cột phần trăm không làm đại lượng cộng dồn, trừ khi được hỏi đích danh.
  const measures = numeric.filter((column) => !RANK_NAME.test(normalizeText(column.name)));
  const plain = measures.filter((column) => !PERCENT_NAME.test(normalizeText(column.name)));
  const measureColumn =
    best(measures, (column) => relevance(question, column)) ??
    plain.find((column) => MONEY_HINT.test(normalizeText(column.name))) ??
    plain.find((column) => MEASURE_HINT.test(normalizeText(column.name))) ??
    plain[0] ??
    measures[0] ??
    null;

  // Nhóm theo: cột phân loại, hoặc cột tên (mỗi dòng một mặt hàng) khi câu hỏi nhắc tới.
  const labels = summary.columns.filter(
    (column) => (column.kind === "categorical" || column.kind === "text") && column.distinct >= 2,
  );
  const metricLabel = labels.find((column) => METRIC_LABEL.test(normalizeText(column.name)));
  const wantsCompare = COMPARE_HINT.test(question);
  const entityBonus = (column: ColumnSummary) => {
    const name = normalizeText(column.name);
    let score = relevance(question, column);
    if (ENTITY_QUESTION.test(question) && ENTITY_COLUMN.test(name)) score += 3;
    // Mã sản phẩm kém dễ đọc hơn tên sản phẩm.
    if (/(^| )(ma|code|id)( |$)/.test(name)) score -= 1;
    return score;
  };
  const groupColumn =
    metricLabel ??
    best(labels, entityBonus) ??
    categorical.find(
      (column) => GROUP_HINT.test(normalizeText(column.name)) && column.distinct <= 30,
    ) ??
    (wantsCompare ? categorical.find((column) => column.distinct <= 30) : undefined) ??
    null;
  // "Mặt hàng nào … nhiều nhất" là câu hỏi xếp hạng: không chia theo thời gian
  // trừ khi câu hỏi nhắc tới thời gian hay xu hướng.
  const ranking = RANKING_WORDS.test(question) && !TIME_WORDS.test(question);

  const timeColumn =
    metricLabel || (ranking && groupColumn)
      ? null
      : (temporal.find((column) => mentioned(question, column)) ?? temporal[0] ?? null);
  let time: AnalysisPlan["time"] = null;
  if (timeColumn) {
    const lastMatch =
      /(\d+)\s*(phut|gio|ngay|tuan|thang|quy|nam)\b/.exec(question) ??
      /(\d+)\s*(minutes?|hours?|days?|weeks?|months?|quarters?|years?)\b/.exec(question);
    // "theo phút", "mỗi tuần", "hàng tháng": đơn vị chia kỳ người dùng nói rõ.
    const explicit =
      /(?:theo|moi|tung|hang|by|per)\s+(phut|gio|ngay|tuan|thang|quy|nam|minute|hour|day|week|month|quarter|year)/.exec(
        question,
      );
    const grainOf = (word: string) => GRAIN_WORDS.find((entry) => entry.pattern.test(word))?.grain;
    let grain = (explicit && grainOf(explicit[1]!)) || grainForSpan(timeColumn);
    let lastPeriods: number | null = null;
    if (lastMatch) {
      const unit = grainOf(normalizeText(lastMatch[2]!));
      if (unit && !explicit) {
        grain = unit;
        lastPeriods = Number(lastMatch[1]);
      } else if (unit) {
        // "theo phút trong 3 giờ": đổi khoảng thời gian ra số kỳ của đơn vị đã chọn.
        const periods = Math.round(
          (Number(lastMatch[1]) * GRAIN_MINUTES[unit]) / GRAIN_MINUTES[grain],
        );
        if (periods >= 1) lastPeriods = periods;
      }
    }
    time = { column: timeColumn.name, grain, lastPeriods };
  }

  const focus = metricLabel
    ? "overview"
    : SHARE_HINT.test(question)
      ? "share"
      : CHANGE_HINT.test(question) && time
        ? "change"
        : time
          ? "trend"
          : groupColumn
            ? "compare"
            : "overview";

  // Câu hỏi nhắc đích danh giá trị ("của CN01", "Bình Thạnh") thì lọc theo giá trị đó.
  const filters: AnalysisPlan["filters"] = [];
  for (const column of categorical) {
    const named = (column.topValues ?? [])
      .map((entry) => entry.value)
      .filter((value) => {
        // "CN03 - Bình Thạnh" khớp cả khi chỉ nhắc mã "CN03" hoặc tên "Bình Thạnh".
        const parts = [value, ...value.split(/\s+-\s+/)].map(normalizeText);
        return parts.some((text) => text.length > 1 && ` ${question} `.includes(` ${text} `));
      });
    if (named.length > 0 && named.length < column.distinct)
      filters.push({ column: column.name, operator: "in", values: named });
  }

  return {
    intent: rawQuestion.trim() || "Tổng quan dữ liệu",
    measure: measureColumn
      ? { column: measureColumn.name, aggregate: "sum", label: humanizeColumn(measureColumn.name) }
      : { column: null, aggregate: "count", label: "Số dòng" },
    time,
    groupBy: groupColumn
      ? { column: groupColumn.name, topN: metricLabel ? 20 : ranking ? 10 : 8 }
      : null,
    filters,
    focus,
  };
}

/**
 * Kiểm tra kế hoạch với dữ liệu thật trước khi chạy: cột phải tồn tại và đúng
 * kiểu. Kế hoạch từ AI hay từ trình duyệt đều đi qua đây; chỗ sai được sửa
 * về mặc định an toàn và ghi cảnh báo, không chạy mù.
 */
export function validatePlan(
  input: AnalysisPlan,
  typed: TypedDataset,
): { plan: AnalysisPlan; warnings: string[] } {
  const warnings: string[] = [];
  const column = (name: string | null | undefined) => (name ? typed.byName.get(name) : undefined);
  const plan: AnalysisPlan = structuredClone(input);

  const measure = column(plan.measure.column);
  if (plan.measure.column !== null && measure?.summary.kind !== "numeric") {
    warnings.push(`Cột "${plan.measure.column}" không phải cột số, chuyển sang đếm số dòng`);
    plan.measure = { column: null, aggregate: "count", label: "Số dòng" };
  }
  if (plan.measure.column === null) plan.measure.aggregate = "count";
  if (!plan.measure.label.trim())
    plan.measure.label = plan.measure.column ? humanizeColumn(plan.measure.column) : "Số dòng";

  if (plan.time) {
    const time = column(plan.time.column);
    if (time?.summary.kind !== "temporal") {
      warnings.push(
        `Cột "${plan.time.column}" không phải cột thời gian, bỏ phân tích theo thời gian`,
      );
      plan.time = null;
    } else {
      const finestGrain: Grain = time.summary.temporalPrecision ?? "day";
      if (GRAINS.indexOf(plan.time.grain) < GRAINS.indexOf(finestGrain)) {
        warnings.push(
          `Dữ liệu chỉ chi tiết tới ${GRAIN_LABELS[finestGrain]}, không chia nhỏ hơn được`,
        );
        plan.time.grain = finestGrain;
      }
      if (plan.time.lastPeriods !== null && plan.time.lastPeriods < 1) plan.time.lastPeriods = null;
      if (plan.time.lastPeriods !== null)
        plan.time.lastPeriods = Math.min(plan.time.lastPeriods, 500);
    }
  }

  if (plan.groupBy) {
    const group = column(plan.groupBy.column);
    if (!group || group.summary.kind === "numeric" || group.summary.kind === "temporal") {
      warnings.push(`Không nhóm được theo cột "${plan.groupBy.column}"`);
      plan.groupBy = null;
    } else {
      const topN = plan.groupBy.topN ?? 8;
      plan.groupBy.topN = Math.max(1, Math.min(topN, 20));
    }
  }

  plan.filters = plan.filters.filter((filter) => {
    if (column(filter.column)) return true;
    warnings.push(`Bỏ bộ lọc trên cột không có trong dữ liệu: "${filter.column}"`);
    return false;
  });

  return { plan, warnings };
}

/** Tên cột không dấu hay gặp trong tệp kinh doanh, đổi lại thành chữ có dấu để hiện trên biểu đồ. */
const COLUMN_WORDS: Record<string, string> = {
  "doanh thu": "Doanh thu",
  "doanh so": "Doanh số",
  "loi nhuan": "Lợi nhuận",
  "chi phi": "Chi phí",
  "so luong": "Số lượng",
  "so hoa don": "Số hóa đơn",
  "so don": "Số đơn",
  "chi nhanh": "Chi nhánh",
  "cua hang": "Cửa hàng",
  "nha thuoc": "Nhà thuốc",
  "khu vuc": "Khu vực",
  "san pham": "Sản phẩm",
  "nhom hang": "Nhóm hàng",
  "danh muc": "Danh mục",
  "nhan vien": "Nhân viên",
  "kenh ban": "Kênh bán",
  "thoi diem": "Thời điểm",
  thang: "Tháng",
  ngay: "Ngày",
  nam: "Năm",
};

/** `doanh_thu` → "Doanh thu"; tên đã có dấu hay khoảng trắng thì giữ nguyên. */
export function humanizeColumn(name: string): string {
  const known = COLUMN_WORDS[normalizeText(name)];
  if (known) return known;
  const spaced = name.replace(/[_]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export const GRAIN_LABELS: Record<Grain, string> = {
  minute: "phút",
  hour: "giờ",
  day: "ngày",
  week: "tuần",
  month: "tháng",
  quarter: "quý",
  year: "năm",
};

/** Cột tiền thì định dạng đồng; cột đếm hay số lượng thì số trơn. */
export function valueFormatFor(plan: AnalysisPlan): ValueFormat {
  if (plan.measure.column === null || plan.measure.aggregate === "count") return "number";
  const name = normalizeText(`${plan.measure.column} ${plan.measure.label}`);
  if (/so luong|quantity|qty|so don|so hoa don|luot|count/.test(name)) return "number";
  return CURRENCY_HINT.test(name) ? "currency" : "number";
}
