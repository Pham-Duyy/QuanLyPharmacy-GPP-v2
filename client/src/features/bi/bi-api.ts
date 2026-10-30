import { http } from "../../api/http.js";
import { formatVnd, type Envelope } from "../../api/types.js";
import { foldText } from "../../app/fold-text.js";
import type { SeriesLine } from "../analytics/analytics-api.js";

/**
 * Bảng điều hành (Phase 1, bước 1.7). Số liệu do analytics-service tính sẵn,
 * đi qua cổng `server/src/modules/bi` để áp quyền theo cửa hàng. Trang này
 * không tính lại con số nào, chỉ hiển thị.
 */

export type Period = "day" | "week" | "month";
export type BreakdownBy = "category" | "store" | "top_medicines";

export type BiAccess = {
  allStores: boolean;
  stores: Array<{ code: string; name: string }>;
  /** Có quyền report.inventory ở mọi cửa hàng. */
  inventoryAll: boolean;
  inventoryStores: string[];
};

/** Phạm vi đang xem (ALL hoặc mã cửa hàng) có được xem tồn kho, hạn dùng không. */
export function canSeeInventory(access: BiAccess | undefined, store: string): boolean {
  if (!access) return false;
  return access.inventoryAll || (store !== "ALL" && access.inventoryStores.includes(store));
}

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
  /** Thẻ KPI tồn kho; null khi không có quyền tồn kho ở phạm vi này. */
  overview: Overview | null;
};

export type Severity = "critical" | "high" | "medium" | "low";

export type Overview = {
  stock_as_of: string | null;
  inventory_available: boolean;
  alerts: Record<Severity, number>;
  total_stock_value?: number | null;
  out_of_stock?: number;
  low_stock?: number;
  dead_stock?: number;
  expired_lots?: number;
  expiring_30d_lots?: number;
  at_risk_value?: number | null;
};

export type Alert = {
  code: string;
  severity: Severity;
  title: string;
  section: "inventory" | "expiry" | "anomalies" | "kpi" | "data_quality";
  count: number | null;
  value: number | null;
  items: string[];
};

export type ProductRow = {
  medicine_code: string;
  medicine_name: string | null;
  category: string | null;
  revenue?: number | null;
  profit?: number | null;
  margin_pct?: number | null;
  units?: number | null;
  orders?: number | null;
  previous_revenue?: number | null;
  growth_pct?: number | null;
  stock_quantity?: number | null;
  stock_value?: number | null;
  last_sale?: string | null;
  days_since_sale?: number | null;
};

export type ProductRanking =
  "revenue" | "profit" | "low_profit" | "declining" | "slow" | "not_sold";

export type Products = {
  label: string;
  previous_label: string;
  revenue: ProductRow[];
  profit: ProductRow[];
  low_profit: ProductRow[];
  declining: ProductRow[];
  stock: {
    basis: "inventory" | "sales_history";
    slow: ProductRow[];
    not_sold: ProductRow[];
    not_sold_total: number;
  };
};

export type StockStatus = "out_of_stock" | "low" | "dead" | "high" | "normal";

export type StockItem = {
  store_code: string;
  medicine_code: string;
  medicine_name: string | null;
  unit: string | null;
  status: StockStatus;
  stock_quantity: number;
  stock_value: number | null;
  ads: number;
  days_of_cover: number | null;
  last_sale: string | null;
  days_since_sale: number | null;
};

export type Inventory =
  | { available: false }
  | {
      available: true;
      stock_as_of: string | null;
      total_stock_value: number | null;
      summary: Record<StockStatus, { label: string; count: number; stock_value: number | null }>;
      items: StockItem[];
    };

export type ExpiryLevel = "expired" | "critical" | "warning" | "monitor" | "normal";

export type Lot = {
  store_code: string;
  medicine_code: string;
  medicine_name: string | null;
  unit: string | null;
  batch_code: string;
  expiry_date: string;
  days_left: number;
  level: ExpiryLevel;
  quantity: number;
  value: number | null;
  ads: number;
  fefo_rank: number | null;
  sellable_before_expiry: number | null;
  at_risk_quantity: number | null;
  at_risk_value: number | null;
};

export type Expiry =
  | { available: false }
  | {
      available: true;
      levels: Record<
        ExpiryLevel,
        { label: string; lots: number; quantity: number; value: number | null }
      >;
      at_risk: { lots: number; quantity: number; value: number | null } | null;
      lots: Lot[];
      risk_lots: Lot[];
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
  alerts: (store: string) => get<{ alerts: Alert[] }>("alerts", { store }),
  products: (store: string, period: Period) => get<Products>("products", { store, period }),
  inventory: (store: string) => get<Inventory>("inventory", { store }),
  expiry: (store: string) => get<Expiry>("expiry", { store }),
};

/** Giá vốn bình quân làm lợi nhuận có phần lẻ; tiền hiển thị tròn đồng. */
export function money(value: number | null | undefined): string {
  return formatVnd(value === null || value === undefined ? null : Math.round(value));
}

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

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Nghiêm trọng",
  high: "Cao",
  medium: "Trung bình",
  low: "Thấp",
};

export const STATUS_LABELS: Record<StockStatus, string> = {
  out_of_stock: "Hết hàng",
  low: "Sắp hết",
  dead: "Tồn chết",
  high: "Tồn cao",
  normal: "Bình thường",
};

export const LEVEL_LABELS: Record<ExpiryLevel, string> = {
  expired: "Đã hết hạn",
  critical: "Nguy cấp (≤ 7 ngày)",
  warning: "Cảnh báo (8–30 ngày)",
  monitor: "Theo dõi (31–90 ngày)",
  normal: "Bình thường",
};

/** Lọc danh sách theo chữ gõ vào: không phân biệt hoa thường, bỏ dấu tiếng Việt. */
export function matchesText(text: string, ...fields: Array<string | null | undefined>): boolean {
  const wanted = foldText(text.trim());
  if (!wanted) return true;
  return fields.some((field) => field && foldText(field).includes(wanted));
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
