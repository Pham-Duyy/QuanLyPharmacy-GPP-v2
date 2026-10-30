import { normalizeText, parseNumber, parseTemporal } from "./parse.js";
import { GRAIN_LABELS } from "./planner.js";
import type { TypedDataset } from "./summarize.js";
import {
  GRAINS,
  type Aggregate,
  type AnalysisPlan,
  type ExecutionResult,
  type Grain,
  type GroupStat,
  type OverallStat,
  type SeriesLine,
} from "./types.js";

/** Quá số kỳ này thì tự gộp lên đơn vị thời gian lớn hơn, biểu đồ vẫn đọc được. */
const MAX_PERIODS = 400;
export const OTHER_GROUP = "Khác";

type Accumulator = { sum: number; count: number; max: number; min: number };

const emptyAccumulator = (): Accumulator => ({ sum: 0, count: 0, max: -Infinity, min: Infinity });

function add(target: Accumulator, value: number): void {
  target.sum += value;
  target.count += 1;
  target.max = Math.max(target.max, value);
  target.min = Math.min(target.min, value);
}

function merge(target: Accumulator, source: Accumulator): void {
  target.sum += source.sum;
  target.count += source.count;
  target.max = Math.max(target.max, source.max);
  target.min = Math.min(target.min, source.min);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Giá trị của một ô tổng hợp; kỳ không có dòng nào: tổng và đếm là 0, còn lại là trống. */
function valueOf(accumulator: Accumulator | undefined, aggregate: Aggregate): number | null {
  if (!accumulator || accumulator.count === 0)
    return aggregate === "sum" || aggregate === "count" ? 0 : null;
  switch (aggregate) {
    case "sum":
      return round(accumulator.sum);
    case "count":
      return accumulator.count;
    case "mean":
      return round(accumulator.sum / accumulator.count);
    case "max":
      return round(accumulator.max);
    case "min":
      return round(accumulator.min);
  }
}

// --- Kỳ thời gian ------------------------------------------------------------

/** Đầu kỳ chứa mốc `at` (giờ tường, đọc bằng getUTC*). */
export function bucketStart(at: Date, grain: Grain): Date {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  switch (grain) {
    case "minute":
      return new Date(Date.UTC(year, month, at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes()));
    case "hour":
      return new Date(Date.UTC(year, month, at.getUTCDate(), at.getUTCHours()));
    case "day":
      return new Date(Date.UTC(year, month, at.getUTCDate()));
    case "week": {
      // Tuần bắt đầu từ thứ Hai.
      const day = new Date(Date.UTC(year, month, at.getUTCDate()));
      day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
      return day;
    }
    case "month":
      return new Date(Date.UTC(year, month, 1));
    case "quarter":
      return new Date(Date.UTC(year, month - (month % 3), 1));
    case "year":
      return new Date(Date.UTC(year, 0, 1));
  }
}

export function nextBucket(start: Date, grain: Grain): Date {
  const next = new Date(start);
  switch (grain) {
    case "minute":
      next.setUTCMinutes(next.getUTCMinutes() + 1);
      break;
    case "hour":
      next.setUTCHours(next.getUTCHours() + 1);
      break;
    case "day":
      next.setUTCDate(next.getUTCDate() + 1);
      break;
    case "week":
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    case "month":
      next.setUTCMonth(next.getUTCMonth() + 1);
      break;
    case "quarter":
      next.setUTCMonth(next.getUTCMonth() + 3);
      break;
    case "year":
      next.setUTCFullYear(next.getUTCFullYear() + 1);
      break;
  }
  return next;
}

export function periodKey(start: Date, grain: Grain): string {
  const iso = start.toISOString();
  switch (grain) {
    case "minute":
      return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
    case "hour":
      return `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00`;
    case "day":
    case "week":
      return iso.slice(0, 10);
    case "month":
      return iso.slice(0, 7);
    case "quarter":
      return `${iso.slice(0, 4)}-Q${Math.floor(start.getUTCMonth() / 3) + 1}`;
    case "year":
      return iso.slice(0, 4);
  }
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Nhãn trục hoành ngắn gọn theo kiểu Việt Nam. */
export function periodLabel(start: Date, grain: Grain, multiDay: boolean): string {
  const day = `${pad(start.getUTCDate())}/${pad(start.getUTCMonth() + 1)}`;
  const time = `${pad(start.getUTCHours())}:${pad(start.getUTCMinutes())}`;
  switch (grain) {
    case "minute":
    case "hour":
      return multiDay ? `${day} ${time}` : time;
    case "day":
      return day;
    case "week":
      return `Tuần ${day}`;
    case "month":
      return `${pad(start.getUTCMonth() + 1)}/${start.getUTCFullYear()}`;
    case "quarter":
      return `Q${Math.floor(start.getUTCMonth() / 3) + 1}/${start.getUTCFullYear()}`;
    case "year":
      return String(start.getUTCFullYear());
  }
}

function countPeriods(first: Date, last: Date, grain: Grain): number {
  let count = 0;
  for (let at = first; at <= last && count <= MAX_PERIODS; at = nextBucket(at, grain)) count += 1;
  return count;
}

// --- Bộ lọc ------------------------------------------------------------------

function rowMatcher(plan: AnalysisPlan, typed: TypedDataset): (row: number) => boolean {
  const checks = plan.filters.map((filter) => {
    const column = typed.byName.get(filter.column)!;
    const wanted = filter.values.map((value) => normalizeText(value));
    const numericTargets = filter.values.map((value) =>
      column.times
        ? (parseTemporal(value)?.at.getTime() ?? null)
        : parseNumber(value, column.summary.numberStyle ?? "plain"),
    );
    const target = numericTargets[0] ?? null;

    return (row: number): boolean => {
      const text = column.texts[row];
      if (text === null || text === undefined) return false;
      const normalized = normalizeText(text);
      switch (filter.operator) {
        case "eq":
          return normalized === wanted[0];
        case "neq":
          return normalized !== wanted[0];
        case "in":
          return wanted.includes(normalized);
        case "contains":
          return wanted.some((value) => normalized.includes(value));
        default: {
          const actual = column.times
            ? (column.times[row]?.at.getTime() ?? null)
            : (column.numbers?.[row] ?? null);
          if (actual === null || target === null) return false;
          if (filter.operator === "gt") return actual > target;
          if (filter.operator === "gte") return actual >= target;
          if (filter.operator === "lt") return actual < target;
          return actual <= target;
        }
      }
    };
  });
  return (row) => checks.every((check) => check(row));
}

// --- Thống kê chuỗi ----------------------------------------------------------

function percent(change: number, base: number): number | null {
  if (base === 0) return null;
  return Math.round((change / Math.abs(base)) * 1000) / 10;
}

/**
 * % thay đổi từ đầu tới cuối đường hồi quy tuyến tính: ít bị một kỳ đột biến
 * kéo lệch. Đường xu hướng bắt đầu ở mức không dương thì không tính được %.
 */
function trendPercent(values: Array<number | null>): number | null {
  const points = values
    .map((value, index) => (value === null ? null : { x: index, y: value }))
    .filter((point): point is { x: number; y: number } => point !== null);
  if (points.length < 3) return null;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  if (denominator === 0) return null;
  const slope = numerator / denominator;
  const start = meanY + slope * (points[0]!.x - meanX);
  const end = meanY + slope * (points.at(-1)!.x - meanX);
  if (start <= 0) return null;
  return Math.max(Math.round(((end - start) / start) * 1000) / 10, -100);
}

type SeriesStats = Pick<
  GroupStat,
  "first" | "last" | "change" | "changePercent" | "trendPercent" | "peakPeriod" | "lowPeriod"
> & {
  firstPeriod: string | null;
  lastPeriod: string | null;
  peak: { period: string; value: number } | null;
  low: { period: string; value: number } | null;
};

function seriesStats(values: Array<number | null>, periods: string[]): SeriesStats {
  const present = values
    .map((value, index) => (value === null ? null : { value, period: periods[index]! }))
    .filter((point): point is { value: number; period: string } => point !== null);
  if (present.length === 0)
    return {
      first: null,
      last: null,
      change: null,
      changePercent: null,
      trendPercent: null,
      peakPeriod: null,
      lowPeriod: null,
      firstPeriod: null,
      lastPeriod: null,
      peak: null,
      low: null,
    };
  const first = present[0]!;
  const last = present.at(-1)!;
  const peak = present.reduce((best, point) => (point.value > best.value ? point : best));
  const low = present.reduce((best, point) => (point.value < best.value ? point : best));
  const change = present.length > 1 ? round(last.value - first.value) : null;
  return {
    first: first.value,
    last: last.value,
    change,
    changePercent: change === null ? null : percent(change, first.value),
    trendPercent: trendPercent(values),
    peakPeriod: peak.period,
    lowPeriod: low.period,
    firstPeriod: first.period,
    lastPeriod: last.period,
    peak: { period: peak.period, value: peak.value },
    low: { period: low.period, value: low.value },
  };
}

export type ExecuteOptions = {
  /**
   * Giờ tường hiện tại. Có thì kỳ cuối đang diễn ra (tháng này chưa hết) được
   * loại khỏi phép so sánh, để không báo "giảm mạnh" chỉ vì tháng chưa xong.
   */
  now?: Date;
};

/**
 * Chạy kế hoạch trên dữ liệu: hoàn toàn tất định, không gọi AI. Mọi con số
 * trong biểu đồ và nhận xét đều lấy từ đây.
 */
export function executePlan(
  plan: AnalysisPlan,
  typed: TypedDataset,
  options: ExecuteOptions = {},
): { result: ExecutionResult; warnings: string[]; plan: AnalysisPlan } {
  const warnings: string[] = [];
  const effectivePlan = structuredClone(plan);
  const aggregate = effectivePlan.measure.aggregate;
  const measure = effectivePlan.measure.column
    ? typed.byName.get(effectivePlan.measure.column)!.numbers!
    : null;
  const timeColumn = effectivePlan.time ? typed.byName.get(effectivePlan.time.column)! : null;
  const groupColumn = effectivePlan.groupBy
    ? typed.byName.get(effectivePlan.groupBy.column)!
    : null;
  const matches = rowMatcher(effectivePlan, typed);

  let rows: number[] = [];
  for (let row = 0; row < typed.rowCount; row += 1) {
    if (!matches(row)) continue;
    if (measure && measure[row] === null) continue;
    if (timeColumn && !timeColumn.times![row]) continue;
    rows.push(row);
  }
  const skipped = typed.rowCount - rows.length;
  if (skipped > 0 && effectivePlan.filters.length === 0)
    warnings.push(
      `Bỏ qua ${skipped.toLocaleString("vi-VN")} dòng thiếu giá trị hoặc sai định dạng`,
    );

  // Kỳ thời gian.
  const periods: Date[] = [];
  let grain: Grain | null = effectivePlan.time?.grain ?? null;
  if (timeColumn && grain && rows.length > 0) {
    const stamps = rows.map((row) => timeColumn.times![row]!.at.getTime());
    let firstStamp = new Date(Math.min(...stamps));
    const lastStamp = new Date(Math.max(...stamps));
    let chosen: Grain = grain;
    while (
      chosen !== "year" &&
      countPeriods(bucketStart(firstStamp, chosen), bucketStart(lastStamp, chosen), chosen) >
        MAX_PERIODS
    ) {
      const coarser: Grain = GRAINS[GRAINS.indexOf(chosen) + 1]!;
      warnings.push(
        `Quá nhiều kỳ theo ${GRAIN_LABELS[chosen]}, tự gộp theo ${GRAIN_LABELS[coarser]}`,
      );
      chosen = coarser;
    }
    grain = chosen;
    effectivePlan.time!.grain = chosen;

    // Lùi từ kỳ cuối đủ `lastPeriods` kỳ.
    const lastStart = bucketStart(lastStamp, chosen);
    const lastPeriods = effectivePlan.time!.lastPeriods;
    if (lastPeriods) {
      let start = lastStart;
      for (let step = 1; step < lastPeriods; step += 1)
        start = bucketStart(new Date(start.getTime() - 1), chosen);
      if (start > firstStamp) firstStamp = start;
    }
    for (
      let at = bucketStart(firstStamp, chosen);
      at <= lastStart && periods.length < MAX_PERIODS;
      at = nextBucket(at, chosen)
    )
      periods.push(at);

    const windowStart = periods[0]!.getTime();
    rows = rows.filter((row) => timeColumn.times![row]!.at.getTime() >= windowStart);
  }

  const keys = grain ? periods.map((start) => periodKey(start, grain)) : [];
  const multiDay =
    periods.length > 1 &&
    periods[0]!.toISOString().slice(0, 10) !== periods.at(-1)!.toISOString().slice(0, 10);
  const labels = grain ? periods.map((start) => periodLabel(start, grain, multiDay)) : [];
  const keyIndex = new Map(keys.map((key, index) => [key, index]));

  // Tổng hợp theo (nhóm, kỳ).
  const overallCells = keys.map(() => emptyAccumulator());
  const groupCells = new Map<string, Accumulator[]>();
  const groupTotals = new Map<string, Accumulator>();
  const overallTotal = emptyAccumulator();

  for (const row of rows) {
    const value = measure ? measure[row]! : 1;
    add(overallTotal, value);
    const index = grain
      ? keyIndex.get(periodKey(bucketStart(timeColumn!.times![row]!.at, grain), grain))
      : undefined;
    if (index !== undefined) add(overallCells[index]!, value);
    if (groupColumn) {
      const group = groupColumn.texts[row] ?? "(Trống)";
      let total = groupTotals.get(group);
      if (!total) {
        total = emptyAccumulator();
        groupTotals.set(group, total);
        groupCells.set(
          group,
          keys.map(() => emptyAccumulator()),
        );
      }
      add(total, value);
      if (index !== undefined) add(groupCells.get(group)![index]!, value);
    }
  }

  // Nhóm nhiều quá thì giữ topN nhóm lớn nhất, phần còn lại gộp "Khác" khi phép tính cộng dồn được.
  const ranked = [...groupTotals.entries()].sort(
    (a, b) => (valueOf(b[1], aggregate) ?? 0) - (valueOf(a[1], aggregate) ?? 0),
  );
  const topN = effectivePlan.groupBy?.topN ?? 8;
  const kept = ranked.slice(0, topN);
  const rest = ranked.slice(topN);
  const additive = aggregate === "sum" || aggregate === "count";
  if (rest.length > 0 && additive) {
    const otherTotal = emptyAccumulator();
    const otherCells = keys.map(() => emptyAccumulator());
    for (const [group, total] of rest) {
      merge(otherTotal, total);
      groupCells.get(group)!.forEach((cell, index) => merge(otherCells[index]!, cell));
    }
    groupCells.set(OTHER_GROUP, otherCells);
    kept.push([OTHER_GROUP, otherTotal]);
  }

  // Kỳ cuối đang diễn ra thì không đưa vào so sánh đầu – cuối.
  let comparable = keys.length;
  if (options.now && grain && periods.length >= 3) {
    const current = bucketStart(options.now, grain).getTime();
    if (periods.at(-1)!.getTime() === current) {
      comparable -= 1;
      warnings.push(
        `${labels.at(-1)} chưa hết ${GRAIN_LABELS[grain]}: vẫn vẽ trên biểu đồ nhưng không tính vào mức tăng/giảm`,
      );
    }
  }
  const statKeys = keys.slice(0, comparable);

  const overallSeries = overallCells.map((cell) => valueOf(cell, aggregate));
  const grandTotal = valueOf(overallTotal, aggregate) ?? 0;
  const groupSeries: SeriesLine[] = kept.map(([group]) => ({
    name: group,
    values: groupCells.get(group)!.map((cell) => valueOf(cell, aggregate)),
  }));

  const groups: GroupStat[] = kept.map(([group, total], index) => {
    const values = groupSeries[index]!.values.slice(0, comparable);
    const stats = seriesStats(values, statKeys);
    const value = valueOf(total, aggregate) ?? 0;
    return {
      group,
      total: value,
      share: additive && grandTotal !== 0 ? Math.round((value / grandTotal) * 1000) / 10 : null,
      first: stats.first,
      last: stats.last,
      change: stats.change,
      changePercent: stats.changePercent,
      trendPercent: stats.trendPercent,
      peakPeriod: stats.peakPeriod,
      lowPeriod: stats.lowPeriod,
    };
  });

  const overallStats = seriesStats(overallSeries.slice(0, comparable), statKeys);
  const present = overallSeries
    .slice(0, comparable)
    .filter((value): value is number => value !== null);
  const average =
    present.length > 0 ? round(present.reduce((a, b) => a + b, 0) / present.length) : null;
  const anomalies: OverallStat["anomalies"] = [];
  if (present.length >= 6 && average !== null) {
    const std = Math.sqrt(
      present.reduce((sum, value) => sum + (value - average) ** 2, 0) / present.length,
    );
    if (std > 0)
      overallSeries.slice(0, comparable).forEach((value, index) => {
        if (value === null) return;
        const z = (value - average) / std;
        if (Math.abs(z) >= 2)
          anomalies.push({ period: statKeys[index]!, value, direction: z > 0 ? "high" : "low" });
      });
  }
  const lastTwo = present.slice(-2);
  const overall: OverallStat = {
    total: grandTotal,
    periodCount: keys.length,
    firstPeriod: overallStats.firstPeriod,
    lastPeriod: overallStats.lastPeriod,
    first: overallStats.first,
    last: overallStats.last,
    change: overallStats.change,
    changePercent: overallStats.changePercent,
    trendPercent: overallStats.trendPercent,
    lastStepPercent: lastTwo.length === 2 ? percent(lastTwo[1]! - lastTwo[0]!, lastTwo[0]!) : null,
    peak: overallStats.peak,
    low: overallStats.low,
    average,
    anomalies,
  };

  return {
    plan: effectivePlan,
    warnings,
    result: {
      rowsUsed: rows.length,
      periods: keys,
      periodLabels: labels,
      overallSeries,
      groupSeries: grain ? groupSeries : [],
      overall,
      groups,
      otherGroupCount: additive ? rest.length : 0,
    },
  };
}
