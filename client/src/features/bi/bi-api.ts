import { http } from "../../api/http.js";
import { formatVnd, type Envelope } from "../../api/types.js";
import { foldText } from "../../app/fold-text.js";
import type { ChartBand, ChartMarker } from "../analytics/AnalysisCharts.js";
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
  /** Có stock.cost.read ở mọi cửa hàng: thấy lợi nhuận toàn chuỗi (D23). */
  costAll: boolean;
  costStores: string[];
  /** Cửa hàng được xem xếp hạng sản phẩm (report.sales/report.chain). */
  salesStores: string[];
  /** Được hỏi trợ lý AI (report.ai, D25). */
  canAsk: boolean;
};

/** Phạm vi đang xem có được thấy lợi nhuận, giá vốn, biên lợi nhuận không (D23). */
export function canSeeCost(access: BiAccess | undefined, store: string): boolean {
  if (!access) return false;
  return access.costAll || (store !== "ALL" && access.costStores.includes(store));
}

/** Phạm vi đang xem có được xem xếp hạng sản phẩm không (D8). */
export function canSeeProducts(access: BiAccess | undefined, store: string): boolean {
  if (!access) return false;
  return store === "ALL"
    ? access.allStores && access.salesStores.length === access.stores.length
    : access.salesStores.includes(store);
}

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

export type ForecastPoint = {
  date: string;
  value: number;
  low: number | null;
  high: number | null;
};

export type RevenueForecast =
  | { status: "insufficient_data"; message: string }
  | {
      status: "ok";
      model: string;
      model_label: string;
      accuracy_measured: boolean;
      /** Sai số backtest (WAPE) của phần bán lẻ; null khi chưa đủ dữ liệu để đo. */
      wape: number | null;
      points: ForecastPoint[];
      total: number;
      change_vs_last_7_pct: number | null;
      wholesale_per_day?: number;
    };

export type DemandRow = {
  store_code: string;
  medicine_code: string;
  medicine_name: string | null;
  model: string;
  wape_total: number | null;
  next_7_days: number;
  next_7_low: number | null;
  next_7_high: number | null;
  next_30_days: number;
  change_vs_last_7_pct: number | null;
};

export type Stockout = {
  store_code: string;
  medicine_code: string;
  medicine_name: string | null;
  stock_quantity: number;
  stockout_date: string | null;
  days_until_stockout: number | null;
};

export type AnomalyEvent = {
  kind: string;
  severity: Severity;
  direction: "down" | "up";
  store_code: string;
  medicine_code: string | null;
  medicine_name: string | null;
  start: string;
  end: string;
  days: string[];
  actual: number;
  expected: number;
  change_pct: number | null;
  message: string;
  short: string;
  methods: string[];
};

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

// --- Đặt hàng, ABC–XYZ (Phase 5, bước 5.4) ----------------------------------------------------

export type AbcGroup = "A" | "B" | "C";
export type XyzGroup = "X" | "Y" | "Z";

export type ClassItem = {
  medicine_code: string;
  medicine_name: string | null;
  category: string | null;
  revenue: number;
  share_pct: number;
  cumulative_pct: number;
  abc: AbcGroup;
  xyz: XyzGroup | null;
  cell: string;
  cv: number | null;
  weekly_mean: number | null;
  service_level: number;
  sold: boolean;
};

export type Classification = {
  as_of: string;
  store: string;
  window: { start: string; end: string };
  total_revenue: number;
  summary: Record<AbcGroup, { label: string; count: number; revenue: number; share_pct: number }>;
  matrix: Record<string, { count: number; revenue: number; service_level: number }>;
  unclassified_xyz: number;
  items: ClassItem[];
};

export type ReorderReason = "out_of_stock" | "stockout_before_arrival" | "below_min" | "reorder";

export type ReorderItem = {
  store_code: string;
  medicine_code: string;
  medicine_name: string | null;
  unit: string | null;
  cell: string;
  reason: ReorderReason;
  stock_quantity: number;
  usable_quantity: number;
  expiring_quantity: number;
  target_quantity: number;
  safety_stock: number;
  lead_time_days: number;
  pack_size: number;
  transfers: Array<{ from_store: string; quantity: number }>;
  transfer_quantity: number;
  order_quantity: number;
  order_packs: number;
  order_value: number | null;
  unit_cost: number | null;
  supplier: string | null;
  days_until_stockout: number | null;
  action: "order" | "transfer" | "transfer_and_order";
};

export type Transfer = {
  from_store: string;
  to_store: string;
  medicine_code: string;
  medicine_name: string | null;
  unit: string | null;
  quantity: number;
  value: number | null;
};

export type ReorderPlan = {
  as_of: string;
  store: string;
  available: boolean;
  cover_days?: number;
  lines?: number;
  order_lines?: number;
  order_value?: number;
  transfer_lines?: number;
  transfer_value?: number;
  by_supplier?: Array<{ supplier: string; lines: number; order_value: number }>;
  items: ReorderItem[];
  transfers: Transfer[];
};

export const REASON_LABELS: Record<ReorderReason, string> = {
  out_of_stock: "Hết hàng",
  stockout_before_arrival: "Hết trước khi hàng về",
  below_min: "Dưới tối thiểu",
  reorder: "Bổ sung",
};

export const XYZ_LABELS: Record<XyzGroup, string> = {
  X: "Ổn định",
  Y: "Dao động",
  Z: "Thất thường",
};

/** "1.000 Viên (10 × 100)": số lượng đặt kèm số đơn vị đặt khi quy cách > 1. */
export function orderText(
  item: Pick<ReorderItem, "order_quantity" | "order_packs" | "pack_size" | "unit">,
): string {
  const base = `${item.order_quantity.toLocaleString("vi-VN")}${item.unit ? ` ${item.unit}` : ""}`;
  return item.pack_size > 1 ? `${base} (${item.order_packs} × ${item.pack_size})` : base;
}

/** "CH02 · 250, cửa hàng khác · 30": nguồn chuyển hàng cho một dòng. */
export function transferText(item: Pick<ReorderItem, "transfers">): string {
  return item.transfers
    .map((move) => `${move.from_store} · ${move.quantity.toLocaleString("vi-VN")}`)
    .join(", ");
}

// --- AI Agent (Phase 4, bước 4.5) ------------------------------------------------------------

export type AgentStatus =
  "answered" | "blocked" | "round_limit" | "timeout" | "refused" | "truncated" | "unavailable";

export type AgentToolCall = {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  error?: string;
};

export type AgentVerification = { checked: number; unverified: string[]; retried: boolean };

export type AgentReply = {
  logId: string;
  conversationId: string;
  status: AgentStatus;
  answer: string | null;
  notice: string | null;
  /** Lý do cụ thể khi không gọi được Claude (khóa sai, hết tiền...). */
  detail?: string | null;
  verification: AgentVerification | null;
  toolCalls: AgentToolCall[];
  rounds: number;
  model: string;
  durationMs: number;
  costUsd: number | null;
  conversation: { turns: number; maxTurns: number; expiresAt: string };
  remainingThisHour: number;
};

/** Chi tiêu AI của cả chuỗi trong tháng (giờ Việt Nam, bước 6.2). */
export type AiBudget = {
  monthlyUsd: number;
  spentUsd: number;
  remainingUsd: number;
  questions: number;
  resetsAt: string;
  exceeded: boolean;
};

export type AgentAvailability = {
  /** Có quyền report.ai (D25). */
  allowed: boolean;
  /** Máy chủ có ANTHROPIC_API_KEY. */
  enabled: boolean;
  /** Chủ nhà thuốc đang bật trợ lý (D26). */
  turnedOn: boolean;
  budget: AiBudget;
  limits: {
    questionsPerHour: number;
    remainingThisHour: number;
    conversationTurns: number;
    questionChars: number;
    timeoutSeconds: number;
  };
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
  anomalies: (store: string, days = 14) =>
    get<{ since: string; events: AnomalyEvent[] }>("anomalies", { store, days }),
  revenueForecast: (store: string) =>
    get<{ data_through: string; revenue: RevenueForecast | null }>("forecast", {
      store,
      target: "revenue",
    }),
  classification: (store: string) => get<Classification>("classification", { store }),
  reorder: (store: string) => get<ReorderPlan>("reorder", { store }),
  agentStatus: () => get<AgentAvailability>("ask/status"),
  ask: async (body: { question: string; conversationId?: string; store: string }) =>
    (await http.post<Envelope<AgentReply>>("/bi/ask", body)).data.data,
  demandForecast: (store: string) =>
    get<{ data_through: string; demand: DemandRow[]; stockout: Stockout[] }>("forecast", {
      store,
      target: "demand",
    }),
};

/** Loại bất thường đánh dấu được trên biểu đồ doanh thu. */
const REVENUE_ANOMALIES = new Set(["revenue_drop_day", "revenue_drop_today", "revenue_spike"]);
/** Số ngày dự báo vẽ nối sau biểu đồ 30 ngày. */
export const CHART_FORECAST_DAYS = 14;

/**
 * Biểu đồ ngày: doanh thu, lợi nhuận đã qua + đường dự báo nét đứt (kèm dải tin cậy) cho
 * CHART_FORECAST_DAYS ngày tới + chấm đỏ ở ngày bất thường. Tuần/tháng giữ như cũ.
 * Hôm nay chưa xong: có cả số đến giờ này (đường liền) và dự báo cả ngày (nét đứt) để so.
 * Chỉ chấm bất thường của ĐÚNG phạm vi đang xem (`scope`): bất thường riêng của CH03 chấm lên
 * đường toàn chuỗi sẽ khiến người xem tưởng cả chuỗi bất thường.
 */
export function trendWithForecast(
  trend: Trend,
  forecast?: RevenueForecast | null,
  events: AnomalyEvent[] = [],
  scope = "ALL",
): {
  labels: string[];
  series: SeriesLine[];
  hasPartial: boolean;
  band?: ChartBand;
  markers: ChartMarker[];
} {
  const base = trendChart(trend);
  if (trend.grain !== "day") return { ...base, markers: [] };
  const dates = trend.points.map((point) => point.period_start);
  const markers: ChartMarker[] = [];
  for (const event of events) {
    if (!REVENUE_ANOMALIES.has(event.kind) || event.store_code !== scope) continue;
    for (const day of event.days) {
      const index = dates.indexOf(day);
      if (index >= 0) markers.push({ index, note: event.message });
    }
  }
  if (!forecast || forecast.status !== "ok") return { ...base, markers };

  const last = dates.at(-1) ?? "";
  const future = forecast.points.filter((point) => point.date > last).slice(0, CHART_FORECAST_DAYS);
  const allDates = [...dates, ...future.map((point) => point.date)];
  const labels = [...base.labels, ...future.map((point) => pointLabel(point.date, "day"))];
  const pad = (values: Array<number | null>) => [...values, ...future.map(() => null)];
  const byDate = new Map(forecast.points.map((point) => [point.date, point]));
  const pick = (field: "value" | "low" | "high") =>
    allDates.map((date) => {
      const point = byDate.get(date);
      return point ? point[field] : null;
    });
  return {
    labels,
    series: [
      ...base.series.map((line) => ({ ...line, values: pad(line.values) })),
      { name: "Dự báo doanh thu", values: pick("value"), dashed: true, color: "#64748b" },
    ],
    band: { name: "Khoảng tin cậy ~80%", low: pick("low"), high: pick("high"), color: "#64748b" },
    markers,
    hasPartial: base.hasPartial,
  };
}

/** "±9%" từ WAPE 0,091. */
export function errorText(wape: number | null | undefined): string {
  return wape === null || wape === undefined ? "chưa đo được" : `±${Math.round(wape * 100)}%`;
}

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

/** Dữ liệu cho LineChart: đường doanh thu và (nếu được xem) lợi nhuận; kỳ đang dở gắn dấu *. */
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
      // Không có quyền giá vốn thì máy chủ bỏ trường profit (D23): không vẽ đường lợi nhuận.
      ...(trend.points.some((point) => point.profit !== undefined)
        ? [{ name: "Lợi nhuận", values: trend.points.map((point) => point.profit) }]
        : []),
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
  invalid_pack_size: "Quy cách sai (dùng 1)",
  lead_time_out_of_range: "Thời gian chờ sai (dùng 2 ngày)",
};

const TOOL_LABELS: Record<string, string> = {
  get_business_summary: "Tổng quan kinh doanh",
  get_revenue: "Doanh thu",
  get_profit: "Lợi nhuận",
  get_sales_trend: "Xu hướng bán hàng",
  get_breakdown: "Cơ cấu",
  get_top_products: "Xếp hạng sản phẩm",
  get_slow_products: "Sản phẩm bán chậm",
  get_inventory: "Tồn kho",
  get_low_stock: "Sắp hết hàng",
  get_expiring_products: "Sắp hết hạn",
  get_expired_products: "Đã hết hạn",
  get_anomalies: "Bất thường",
  get_forecast: "Dự báo",
  get_data_quality: "Chất lượng dữ liệu",
  get_reorder_suggestions: "Gợi ý đặt hàng",
  get_abc_analysis: "Phân loại ABC",
  get_customer_debt: "Công nợ khách hàng",
  get_supplier_data: "Nhà cung cấp",
};

const PARAM_LABELS: Record<string, Record<string, string>> = {
  period: { day: "hôm nay", week: "tuần này", month: "tháng này" },
  grain: { day: "theo ngày", week: "theo tuần", month: "theo tháng" },
  target: { revenue: "doanh thu", demand: "nhu cầu từng thuốc" },
  rank: {
    revenue: "doanh thu cao",
    profit: "lợi nhuận cao",
    low_profit: "lợi nhuận thấp",
    declining: "giảm mạnh",
  },
  kind: { slow: "bán chậm", not_sold: "không bán được" },
  scope: { at_risk: "có nguy cơ", next_30_days: "30 ngày tới", next_90_days: "90 ngày tới" },
  by: {
    category: "nhóm thuốc",
    store: "cửa hàng",
    sale_type: "loại bán",
    payment_method: "thanh toán",
  },
};

/** "Doanh thu · ALL · hôm nay": nguồn số Agent đã tra, đọc được cho người dùng. */
export function toolCallLabel(call: Pick<AgentToolCall, "name" | "input">): string {
  const parts = [TOOL_LABELS[call.name] ?? call.name];
  for (const [key, value] of Object.entries(call.input ?? {})) {
    if (key === "store")
      parts.push(
        String(value).toUpperCase() === "ALL" ? "toàn chuỗi" : String(value).toUpperCase(),
      );
    else if (key === "days") parts.push(`${String(value)} ngày`);
    else if (key === "status") parts.push(value === "all" ? "mọi trạng thái" : String(value));
    else parts.push(PARAM_LABELS[key]?.[String(value)] ?? String(value));
  }
  return parts.join(" · ");
}

/** Kết quả đối chiếu số, hiện dưới câu trả lời. */
export function verificationText(reply: Pick<AgentReply, "status" | "verification">): {
  tone: "success" | "warning" | "error" | "default";
  text: string;
} {
  const verification = reply.verification;
  if (reply.status === "blocked" && verification) {
    return {
      tone: "error",
      text: `Đã chặn: ${verification.unverified.length} số không có nguồn (${verification.unverified.join("; ")})`,
    };
  }
  if (!verification) return { tone: "default", text: "Chưa đối chiếu" };
  if (verification.checked === 0) return { tone: "default", text: "Không có con số" };
  const base = `Đã đối chiếu ${verification.checked} số`;
  return verification.retried
    ? { tone: "warning", text: `${base} · đã sửa 1 lần` }
    : { tone: "success", text: base };
}

/** Câu hỏi gợi ý theo phạm vi đang xem và quyền tồn kho. */
export function suggestedQuestions(storeLabel: string, inventoryAllowed: boolean): string[] {
  const where = storeLabel === "ALL" ? "toàn chuỗi" : storeLabel;
  return [
    `Doanh thu hôm nay của ${where} so với cùng kỳ thế nào?`,
    `5 thuốc bán chạy nhất tháng này của ${where}?`,
    "14 ngày qua có gì bất thường không, nguyên nhân có thể là gì?",
    `Dự báo doanh thu 7 ngày tới của ${where}?`,
    ...(inventoryAllowed
      ? ["Thuốc nào sắp hết hàng, cần nhập trước?", "Lô nào sắp hết hạn có nguy cơ không bán kịp?"]
      : []),
  ];
}

/** "$0,034": chi phí ước tính một câu hỏi. */
export function usdText(value: number | null | undefined): string {
  if (value === null || value === undefined) return "không rõ";
  return `$${value.toFixed(value < 0.01 ? 4 : 3).replace(".", ",")}`;
}
