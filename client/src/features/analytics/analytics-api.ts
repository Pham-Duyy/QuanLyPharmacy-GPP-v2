import { http } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";

/** Kiểu dữ liệu khớp `server/src/modules/analytics/types.ts` (contract §20). */
export type ValueFormat = "currency" | "number" | "percent";
export type Grain = "minute" | "hour" | "day" | "week" | "month" | "quarter" | "year";
export type ChainWindow = "day" | "hour" | "minute";

export type AnalysisPlan = {
  intent: string;
  measure: {
    column: string | null;
    aggregate: "sum" | "mean" | "count" | "max" | "min";
    label: string;
  };
  time: { column: string; grain: Grain; lastPeriods: number | null } | null;
  groupBy: { column: string; topN: number | null } | null;
  filters: Array<{ column: string; operator: string; values: string[] }>;
  focus: "trend" | "compare" | "change" | "share" | "overview";
};

export type ColumnSummary = {
  name: string;
  kind: "temporal" | "numeric" | "categorical" | "text";
  distinct: number;
  missing: number;
  samples: string[];
  min?: number;
  max?: number;
  temporalPrecision?: string;
  start?: string;
  end?: string;
};

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
  trendPercent: number | null;
  peakPeriod: string | null;
  lowPeriod: string | null;
};

export type AnalysisSource = {
  kind: "csv" | "xlsx" | "chain";
  sheets: Array<{ name: string; rows: number }>;
  sheet: string | null;
  notes: string[];
};

export type AnalysisResponse = {
  question: string;
  source: AnalysisSource;
  summary: { name: string; rowCount: number; columns: ColumnSummary[] };
  plan: AnalysisPlan;
  planSource: "ai" | "rules" | "provided";
  columnLabels: Record<string, string>;
  valueFormat: ValueFormat;
  result: {
    rowsUsed: number;
    periods: string[];
    periodLabels: string[];
    overall: {
      total: number;
      periodCount: number;
      firstPeriod: string | null;
      lastPeriod: string | null;
      first: number | null;
      last: number | null;
      changePercent: number | null;
      trendPercent: number | null;
      lastStepPercent: number | null;
      peak: { period: string; value: number } | null;
      average: number | null;
    };
    groups: GroupStat[];
    otherGroupCount: number;
    /** Bảng "Chỉ tiêu | Giá trị": không có tổng, tỷ trọng hay biểu đồ. */
    metricTable: boolean;
  };
  charts: ChartSpec[];
  facts: Array<{ kind: string; tone: "positive" | "negative" | "neutral"; text: string }>;
  narrative: { headline: string; findings: string[]; recommendations: string[] };
  narrativeSource: "ai" | "rules";
  warnings: string[];
  generatedAt: string;
};

export type AnalyticsConfig = { aiEnabled: boolean; model: string | null; windows: ChainWindow[] };

export async function fetchAnalyticsConfig(): Promise<AnalyticsConfig> {
  const response = await http.get<Envelope<AnalyticsConfig>>("/analytics/config");
  return response.data.data;
}

/** Tệp Excel (.xlsx) hoặc CSV; `sheet` bỏ trống thì máy chủ lấy sheet đầu tiên có bảng. */
export async function analyzeFile(input: {
  file: File;
  question: string;
  sheet?: string | null;
  plan?: AnalysisPlan;
  narrate?: boolean;
}): Promise<AnalysisResponse> {
  const form = new FormData();
  form.append("file", input.file);
  form.append("question", input.question);
  if (input.sheet) form.append("sheet", input.sheet);
  if (input.plan) form.append("plan", JSON.stringify(input.plan));
  form.append("narrate", String(input.narrate ?? true));
  const response = await http.post<Envelope<AnalysisResponse>>("/analytics/file", form);
  return response.data.data;
}

export async function analyzeChain(input: {
  question: string;
  window: ChainWindow;
  plan?: AnalysisPlan;
  narrate?: boolean;
}): Promise<AnalysisResponse> {
  const response = await http.post<Envelope<AnalysisResponse>>("/analytics/chain", {
    question: input.question,
    window: input.window,
    plan: input.plan,
    narrate: input.narrate ?? true,
  });
  return response.data.data;
}

/** Số gọn cho trục và nhãn: 1,2 tỷ, 350 triệu; giống cách máy chủ viết nhận xét. */
export function formatCompact(value: number, format: ValueFormat): string {
  const abs = Math.abs(value);
  const unit = format === "currency" ? " đ" : "";
  if (format === "percent")
    return `${value.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
  if (abs >= 1e9)
    return `${(value / 1e9).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} tỷ${unit}`;
  if (abs >= 1e6)
    return `${(value / 1e6).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} triệu${unit}`;
  if (abs >= 1e4 && format === "currency")
    return `${(value / 1e3).toLocaleString("vi-VN", { maximumFractionDigits: 0 })} nghìn${unit}`;
  return `${value.toLocaleString("vi-VN", { maximumFractionDigits: 2 })}${unit}`;
}

export function formatFull(value: number, format: ValueFormat): string {
  if (format === "percent")
    return `${value.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
  const text = value.toLocaleString("vi-VN", { maximumFractionDigits: 2 });
  return format === "currency" ? `${text} ₫` : text;
}

export function formatSignedPercent(value: number | null): string {
  if (value === null) return "—";
  const text = Math.abs(value).toLocaleString("vi-VN", { maximumFractionDigits: 1 });
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${text}%`;
}
