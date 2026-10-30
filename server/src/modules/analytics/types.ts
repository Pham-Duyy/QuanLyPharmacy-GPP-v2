/**
 * Kiểu dữ liệu dùng chung của trợ lý phân tích (contract §20).
 *
 * Luồng xử lý theo kiến trúc LIDA (Dibia, ACL 2023): tóm tắt dữ liệu →
 * lập kế hoạch phân tích từ câu hỏi → tính toán tất định → biểu đồ → nhận
 * xét. AI chỉ đọc bản tóm tắt và các con số đã tính, không tự tính số.
 */

/** Ô dữ liệu thô: CSV luôn là chuỗi, nguồn CSDL có thể là số. */
export type RawCell = string | number | null;

export type Dataset = {
  name: string;
  columns: string[];
  rows: RawCell[][];
};

export type ColumnKind = "temporal" | "numeric" | "categorical" | "text";

/** Độ mịn của cột thời gian, suy ra từ định dạng giá trị. */
export type TemporalPrecision = "minute" | "hour" | "day" | "month" | "year";

export type ColumnSummary = {
  name: string;
  kind: ColumnKind;
  distinct: number;
  missing: number;
  samples: string[];
  numberStyle?: NumberStyle;
  min?: number;
  max?: number;
  mean?: number;
  sum?: number;
  temporalPrecision?: TemporalPrecision;
  start?: string;
  end?: string;
  /** Các giá trị hay gặp nhất của cột phân loại, giúp AI viết bộ lọc đúng chữ. */
  topValues?: Array<{ value: string; count: number }>;
};

export type DataSummary = {
  name: string;
  rowCount: number;
  columns: ColumnSummary[];
};

/** Cách viết số: VN `1.234.567,5`, quốc tế `1,234,567.5`, hay số trơn. */
export type NumberStyle = "vn" | "intl" | "plain";

export const GRAINS = ["minute", "hour", "day", "week", "month", "quarter", "year"] as const;
export type Grain = (typeof GRAINS)[number];

export const AGGREGATES = ["sum", "mean", "count", "max", "min"] as const;
export type Aggregate = (typeof AGGREGATES)[number];

export const FILTER_OPERATORS = ["eq", "neq", "in", "contains", "gt", "gte", "lt", "lte"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export const FOCUSES = ["trend", "compare", "change", "share", "overview"] as const;
export type Focus = (typeof FOCUSES)[number];

/**
 * Kế hoạch phân tích: thứ duy nhất AI sinh ra ở bước lập kế hoạch. Máy chủ
 * kiểm tra lại từng trường với bản tóm tắt trước khi chạy.
 */
export type AnalysisPlan = {
  intent: string;
  measure: { column: string | null; aggregate: Aggregate; label: string };
  time: { column: string; grain: Grain; lastPeriods: number | null } | null;
  groupBy: { column: string; topN: number | null } | null;
  filters: Array<{ column: string; operator: FilterOperator; values: string[] }>;
  focus: Focus;
};

export type ValueFormat = "currency" | "number" | "percent";

export type SeriesLine = { name: string; values: Array<number | null> };

export type ChartSpec =
  | {
      kind: "line";
      id: string;
      title: string;
      periods: string[];
      labels: string[];
      series: SeriesLine[];
      valueFormat: ValueFormat;
    }
  | {
      kind: "bar";
      id: string;
      title: string;
      bars: Array<{ label: string; value: number; share: number | null }>;
      valueFormat: ValueFormat;
    }
  | {
      kind: "change";
      id: string;
      title: string;
      bars: Array<{ label: string; percent: number | null; from: number; to: number }>;
      valueFormat: ValueFormat;
    };

export type GroupStat = {
  group: string;
  total: number;
  share: number | null;
  first: number | null;
  last: number | null;
  change: number | null;
  changePercent: number | null;
  /** % thay đổi theo đường xu hướng (hồi quy tuyến tính) trên cả kỳ. */
  trendPercent: number | null;
  peakPeriod: string | null;
  lowPeriod: string | null;
};

export type OverallStat = {
  total: number;
  periodCount: number;
  firstPeriod: string | null;
  lastPeriod: string | null;
  first: number | null;
  last: number | null;
  change: number | null;
  changePercent: number | null;
  trendPercent: number | null;
  /** Kỳ cuối so với kỳ ngay trước. */
  lastStepPercent: number | null;
  peak: { period: string; value: number } | null;
  low: { period: string; value: number } | null;
  average: number | null;
  anomalies: Array<{ period: string; value: number; direction: "high" | "low" }>;
};

export type ExecutionResult = {
  rowsUsed: number;
  periods: string[];
  periodLabels: string[];
  overallSeries: Array<number | null>;
  groupSeries: SeriesLine[];
  overall: OverallStat;
  groups: GroupStat[];
  /** Số nhóm bị gộp vào "Khác" khi vượt topN. */
  otherGroupCount: number;
};

export type Fact = {
  kind: "total" | "change" | "peak" | "low" | "decline" | "growth" | "share" | "step" | "anomaly";
  tone: "positive" | "negative" | "neutral";
  text: string;
};

export type Narrative = {
  headline: string;
  findings: string[];
  recommendations: string[];
};

/** Nguồn dữ liệu đã đọc: tệp nào, sheet nào, đã tự xử lý gì. */
export type AnalysisSource = {
  kind: "csv" | "xlsx" | "chain";
  sheets: Array<{ name: string; rows: number }>;
  sheet: string | null;
  notes: string[];
};

export type AnalysisResponse = {
  question: string;
  source: AnalysisSource;
  summary: DataSummary;
  plan: AnalysisPlan;
  planSource: "ai" | "rules" | "provided";
  /** Tên hiển thị có dấu của từng cột, ví dụ `cua_hang` → "Cửa hàng". */
  columnLabels: Record<string, string>;
  valueFormat: ValueFormat;
  result: ExecutionResult;
  charts: ChartSpec[];
  facts: Fact[];
  narrative: Narrative;
  narrativeSource: "ai" | "rules";
  warnings: string[];
  generatedAt: string;
};
