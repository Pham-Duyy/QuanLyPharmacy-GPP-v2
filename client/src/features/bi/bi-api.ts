import { http } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";
import type { SeriesLine } from "../analytics/analytics-api.js";

/**
 * Bảng điều hành (Phase 1, bước 1.7). Số liệu do analytics-service tính sẵn,
 * đi qua cổng `server/src/modules/bi` để áp quyền theo cửa hàng. Trang này
 * không tính lại con số nào, chỉ hiển thị.
 */

export type Period = "day" | "week" | "month";
export type BreakdownBy = "category" | "store" | "top_medicines";

export type BiAccess = { allStores: boolean; stores: Array<{ code: string; name: string }> };

export type VersionInfo = {
  version: number | null;
  as_of: string | null;
  created_at: string | null;
};

export type KpiValues = {
  revenue: number;
  cogs: number;
  profit: number;
  margin_pct: number | null;
  orders: number;
  units: number;
  avg_order_value: number | null;
  cost_coverage_pct: number | null;
};

type Window = { start: string; end: string };

export type PeriodKpi = {
  label: string;
  previous_label: string;
  current_window: Window;
  previous_window: Window;
  current: KpiValues;
  previous_same_span: KpiValues;
  growth: Partial<
    Record<"revenue" | "profit" | "orders" | "units" | "avg_order_value", number | null>
  >;
};

export type DatasetQuality = {
  file: string;
  rows_read: number;
  rows_valid: number;
  rows_rejected: number;
  errors: number;
  warnings: number;
  by_code: Record<string, number>;
};

export type Summary = {
  version: number;
  as_of: string;
  store: string;
  stores: string[];
  periods: Record<Period, PeriodKpi>;
  /** null khi người xem chỉ được xem một số cửa hàng. */
  data_quality: Record<string, DatasetQuality> | null;
};

export type TrendPoint = {
  period_start: string;
  revenue: number;
  profit: number;
  orders: number;
  /** Kỳ chưa kết thúc (hôm nay, tuần này…): đừng đọc như kỳ đã đủ. */
  partial: boolean;
};

export type Trend = { grain: Period; start: string; end: string; points: TrendPoint[] };

export type BreakdownRow = {
  key: string;
  label: string;
  revenue: number;
  share_pct: number | null;
};

export type Issue = {
  dataset: string;
  row: number | null;
  column: string | null;
  code: string;
  severity: "error" | "warning";
  message: string;
  value: string | null;
};

export type DataQuality = {
  checked_at: string | null;
  summary: Record<string, DatasetQuality>;
  total: number;
  issues: Issue[];
};

export type Health = {
  status: "ok" | "degraded";
  snapshot: { version: number; age_seconds: number | null } | null;
  last_run: { status: string; finished_at: string; error_message?: string | null } | null;
  monitor: { events: number; runs: number; last_latency_ms: number | null } | null;
};

async function get<T>(path: string, params?: Record<string, string | number | undefined>) {
  return (await http.get<Envelope<T>>(`/bi/${path}`, { params })).data.data;
}

export const biApi = {
  access: () => get<BiAccess>("access"),
  version: () => get<VersionInfo>("version"),
  health: () => get<Health>("health"),
  summary: (store: string) => get<Summary>("summary", { store }),
  trend: (store: string, grain: Period) => get<Trend>("sales-trend", { store, grain }),
  breakdown: (by: BreakdownBy) => get<{ rows: BreakdownRow[] }>("breakdown", { by }),
  dataQuality: () => get<DataQuality>("data-quality", { limit: 100 }),
};

/** Tần suất hỏi version: rẻ (vài chục byte), đủ nhanh cho tiêu chí "dưới 60 giây". */
export const VERSION_POLL_MS = 30_000;

function pointLabel(periodStart: string, grain: Period): string {
  const [year, month, day] = periodStart.split("-");
  if (grain === "month") return `${month}/${year}`;
  return grain === "week" ? `Tuần ${day}/${month}` : `${day}/${month}`;
}

/** Dữ liệu cho LineChart: hai đường doanh thu và lợi nhuận; kỳ đang dở gắn dấu *. */
export function trendChart(trend: Trend): {
  labels: string[];
  series: SeriesLine[];
  hasPartial: boolean;
} {
  const labels = trend.points.map(
    (point) => pointLabel(point.period_start, trend.grain) + (point.partial ? " *" : ""),
  );
  return {
    labels,
    series: [
      { name: "Doanh thu", values: trend.points.map((point) => point.revenue) },
      { name: "Lợi nhuận", values: trend.points.map((point) => point.profit) },
    ],
    hasPartial: trend.points.some((point) => point.partial),
  };
}

/** "vừa xong", "3 phút trước"… để người xem biết số liệu có còn mới. */
export function ageText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "chưa rõ";
  if (seconds < 60) return "vừa xong";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} phút trước`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} giờ trước`;
  return `${Math.floor(seconds / 86_400)} ngày trước`;
}

/** "2026-10-29T16:49:03+07:00" → "16:49:03 29/10/2026" theo đúng giờ ghi trong chuỗi. */
export function clockText(iso: string | null | undefined): string {
  const match = iso?.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/);
  if (!match) return "—";
  const [, year, month, day, time] = match;
  return `${time} ${day}/${month}/${year}`;
}

export const ISSUE_LABELS: Record<string, string> = {
  missing_required: "Thiếu dữ liệu bắt buộc",
  invalid_value: "Giá trị không hợp lệ",
  invalid_code: "Mã không hợp lệ",
  duplicate_row: "Dòng trùng",
  unknown_column: "Cột lạ",
  negative_value: "Số âm",
  min_above_max: "Tồn tối thiểu lớn hơn tối đa",
  non_positive_quantity: "Số lượng ≤ 0",
  fractional_quantity: "Số lượng lẻ",
  negative_price: "Giá âm",
  zero_price: "Giá bằng 0",
  below_cost: "Bán dưới giá vốn",
  future_date: "Ngày ở tương lai",
  date_too_old: "Ngày quá cũ",
  invalid_batch: "Số lô không hợp lệ",
  unknown_medicine: "Thuốc không có trong danh mục",
  zero_quantity: "Lô tồn 0 (bỏ qua)",
  expiry_before_received: "Hạn dùng trước ngày nhập",
  expiry_too_far: "Hạn dùng xa bất thường",
  unknown_store: "Cửa hàng không có trong tệp bán",
};
