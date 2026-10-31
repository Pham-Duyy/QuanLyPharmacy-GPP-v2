/**
 * Biểu đồ trong câu trả lời của trợ lý AI (Phase 6, bước 6.4). Dựng tất định từ đúng kết quả
 * tool mà Claude đã đọc (đã lọc quyền ở bi.service.ts), không để mô hình tự vẽ hay tự đưa số:
 * biểu đồ luôn khớp số liệu nguồn. Chỉ tool có dạng chuỗi thời gian hoặc xếp hạng mới có biểu đồ.
 */

import type { ChartSpec as AnalysisChart } from "../../analytics/types.js";

type Json = Record<string, unknown>;
export type ChartFormat = "currency" | "number" | "percent";

export type AnswerChart =
  | {
      kind: "line";
      title: string;
      labels: string[];
      series: Array<{ name: string; values: Array<number | null>; dashed?: boolean }>;
      band?: { low: Array<number | null>; high: Array<number | null> };
      valueFormat: ChartFormat;
    }
  | {
      kind: "bars";
      title: string;
      bars: Array<{ label: string; value: number; share: number | null }>;
      valueFormat: ChartFormat;
    };

/** Tối đa biểu đồ mỗi câu trả lời: đủ minh họa, không làm câu trả lời dài lê thê. */
export const MAX_CHARTS = 3;

const rows = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const scopeLabel = (store: unknown) =>
  store === "ALL" || store === undefined ? "toàn chuỗi" : String(store);

/** "2026-10-28" → "28/10"; tuần: "Tuần 26/10"; tháng: "10/2026". */
function periodLabel(iso: string, grain: string): string {
  const [year, month, day] = iso.slice(0, 10).split("-");
  if (grain === "month") return `${month}/${year}`;
  if (grain === "week") return `Tuần ${day}/${month}`;
  return `${day}/${month}`;
}

const GRAIN: Record<string, string> = { day: "ngày", week: "tuần", month: "tháng" };
const BREAKDOWN: Record<string, string> = {
  category: "nhóm thuốc",
  store: "cửa hàng",
  sale_type: "loại bán",
  payment_method: "hình thức thanh toán",
};

function bars(
  title: string,
  list: Json[],
  label: (row: Json) => string,
  value: (row: Json) => number | null,
  valueFormat: ChartFormat,
  share?: (row: Json) => number | null,
): AnswerChart | null {
  const items = list
    .map((row) => ({ label: label(row), value: value(row), share: share?.(row) ?? null }))
    .filter(
      (item): item is { label: string; value: number; share: number | null } =>
        Boolean(item.label) && item.value !== null,
    )
    .slice(0, 10);
  return items.length >= 2 ? { kind: "bars", title, bars: items, valueFormat } : null;
}

export function chartFromTool(name: string, input: unknown, content: Json): AnswerChart | null {
  const args = (input ?? {}) as Json;
  switch (name) {
    case "get_sales_trend": {
      const points = rows(content["points"]);
      if (points.length < 2) return null;
      const grain = String(args["grain"] ?? content["grain"] ?? "day");
      const hasProfit = points.some((point) => num(point["profit"]) !== null);
      return {
        kind: "line",
        title: `Doanh thu theo ${GRAIN[grain] ?? grain} · ${scopeLabel(args["store"])}`,
        labels: points.map(
          (point) =>
            periodLabel(String(point["period_start"]), grain) + (point["partial"] ? " *" : ""),
        ),
        series: [
          { name: "Doanh thu", values: points.map((point) => num(point["revenue"])) },
          ...(hasProfit
            ? [{ name: "Lợi nhuận", values: points.map((point) => num(point["profit"])) }]
            : []),
        ],
        valueFormat: "currency",
      };
    }
    case "get_breakdown":
      return bars(
        `Cơ cấu doanh thu theo ${BREAKDOWN[String(args["by"])] ?? String(args["by"])}`,
        rows(content["rows"]),
        (row) => String(row["label"] ?? ""),
        (row) => num(row["revenue"]),
        "currency",
        (row) => num(row["share_pct"]),
      );
    case "get_top_products": {
      const rank = String(args["rank"] ?? "revenue");
      const products = rows(content["products"]);
      const medicine = (row: Json) => String(row["medicine_name"] ?? row["medicine_code"] ?? "");
      const scope = scopeLabel(args["store"]);
      if (rank === "profit")
        return bars(
          `Thuốc lãi nhiều nhất · ${scope}`,
          products,
          medicine,
          (row) => num(row["profit"]),
          "currency",
        );
      if (rank === "low_profit")
        return bars(
          `Thuốc biên lợi nhuận thấp · ${scope}`,
          products,
          medicine,
          (row) => num(row["margin_pct"]),
          "percent",
        );
      if (rank === "declining")
        return bars(
          `Thuốc giảm doanh thu mạnh · ${scope}`,
          products,
          medicine,
          (row) => num(row["growth_pct"]),
          "percent",
        );
      return bars(
        `Thuốc bán chạy theo doanh thu · ${scope}`,
        products,
        medicine,
        (row) => num(row["revenue"]),
        "currency",
      );
    }
    case "get_forecast": {
      if (args["target"] === "demand") {
        return bars(
          `Nhu cầu 7 ngày tới · ${scopeLabel(args["store"])}`,
          rows(content["demand"]),
          (row) => String(row["medicine_name"] ?? row["medicine_code"] ?? ""),
          (row) => num(row["next_7_days"]),
          "number",
        );
      }
      const points = rows(content["points"]);
      if (points.length < 2) return null;
      return {
        kind: "line",
        title: `Dự báo doanh thu · ${scopeLabel(args["store"])}`,
        labels: points.map((point) => periodLabel(String(point["date"]), "day")),
        series: [
          { name: "Dự báo", values: points.map((point) => num(point["value"])), dashed: true },
        ],
        band: {
          low: points.map((point) => num(point["low"])),
          high: points.map((point) => num(point["high"])),
        },
        valueFormat: "currency",
      };
    }
    default:
      return null;
  }
}

/** Biểu đồ của phần phân tích tệp (Excel/CSV, bước 6.6) đổi sang dạng của câu trả lời. */
export function chartFromAnalysis(chart: AnalysisChart): AnswerChart | null {
  if (chart.kind === "line") {
    return {
      kind: "line",
      title: chart.title,
      labels: chart.labels,
      series: chart.series.map(({ name, values }) => ({ name, values })),
      valueFormat: chart.valueFormat,
    };
  }
  if (chart.kind === "bar") {
    return { kind: "bars", title: chart.title, bars: chart.bars, valueFormat: chart.valueFormat };
  }
  // Biểu đồ tăng/giảm: thanh theo phần trăm thay đổi.
  const changes = chart.bars
    .filter((bar) => bar.percent !== null)
    .map((bar) => ({ label: bar.label, value: bar.percent!, share: null }));
  return changes.length
    ? { kind: "bars", title: chart.title, bars: changes, valueFormat: "percent" }
    : null;
}

/** Gộp biểu đồ của mọi tool đã chạy thành công: bỏ trùng tiêu đề, giữ tối đa MAX_CHARTS. */
export function collectCharts(
  outcomes: Array<{ name: string; input: unknown; ok: boolean; content: Json }>,
): AnswerChart[] {
  const charts: AnswerChart[] = [];
  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    const chart = chartFromTool(outcome.name, outcome.input, outcome.content);
    if (!chart) continue;
    // Cùng tiêu đề (tool chạy lại ở vòng sau): giữ bản mới nhất, đúng vị trí cũ.
    const same = charts.findIndex((existing) => existing.title === chart.title);
    if (same >= 0) charts[same] = chart;
    else charts.push(chart);
  }
  return charts.slice(-MAX_CHARTS);
}
