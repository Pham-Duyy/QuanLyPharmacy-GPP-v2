import { OTHER_GROUP } from "./execute.js";
import { GRAIN_LABELS, humanizeColumn } from "./planner.js";
import type {
  AnalysisPlan,
  ChartSpec,
  ExecutionResult,
  Fact,
  Grain,
  Narrative,
  ValueFormat,
} from "./types.js";

export function formatValue(value: number, format: ValueFormat): string {
  if (format === "percent") return formatPercent(value);
  const abs = Math.abs(value);
  if (format === "currency") {
    if (abs >= 1e9)
      return `${(value / 1e9).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} tỷ đ`;
    if (abs >= 1e6)
      return `${(value / 1e6).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} triệu đ`;
    return `${Math.round(value).toLocaleString("vi-VN")} đ`;
  }
  return value.toLocaleString("vi-VN", { maximumFractionDigits: 2 });
}

export function formatPercent(value: number): string {
  const text = Math.abs(value).toLocaleString("vi-VN", { maximumFractionDigits: 1 });
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${text}%`;
}

/** Tên kỳ đầy đủ cho câu nhận xét, khác nhãn trục ngắn gọn trên biểu đồ. */
export function describePeriod(key: string, grain: Grain | null): string {
  if (!grain) return key;
  const [date = "", time = ""] = key.split(" ");
  const [year, month, day] = date.split("-");
  switch (grain) {
    case "minute":
    case "hour":
      return `${time} ngày ${day}/${month}/${year}`;
    case "day":
      return `ngày ${day}/${month}/${year}`;
    case "week":
      return `tuần từ ${day}/${month}/${year}`;
    case "month":
      return `tháng ${month}/${year}`;
    case "quarter":
      return `quý ${key.slice(6)}/${key.slice(0, 4)}`;
    case "year":
      return `năm ${key}`;
  }
}

/**
 * Bước VizGenerator: chọn biểu đồ theo kế hoạch. Đặc tả biểu đồ là dữ liệu
 * (không phải mã), trình duyệt tự vẽ, nên không có mã sinh tự động nào chạy.
 */
export function buildCharts(
  plan: AnalysisPlan,
  result: ExecutionResult,
  format: ValueFormat,
): ChartSpec[] {
  const charts: ChartSpec[] = [];
  const measure = plan.measure.label;
  const grain = plan.time?.grain ?? null;
  const hasGroups = result.groups.length > 1;

  if (grain && result.periods.length > 0) {
    charts.push({
      kind: "line",
      id: "trend-total",
      title: `${measure} theo ${GRAIN_LABELS[grain]}`,
      periods: result.periods,
      labels: result.periodLabels,
      series: [{ name: `Tổng ${measure.toLowerCase()}`, values: result.overallSeries }],
      valueFormat: format,
    });
    if (hasGroups && result.groupSeries.length > 1)
      charts.push({
        kind: "line",
        id: "trend-groups",
        title: `${measure} theo ${GRAIN_LABELS[grain]}, từng ${humanizeColumn(plan.groupBy!.column).toLowerCase()}`,
        periods: result.periods,
        labels: result.periodLabels,
        series: result.groupSeries,
        valueFormat: format,
      });
  }

  if (hasGroups) {
    charts.push({
      kind: "bar",
      id: "compare-groups",
      title: `So sánh ${measure.toLowerCase()} giữa các ${humanizeColumn(plan.groupBy!.column).toLowerCase()}`,
      bars: result.groups.map((group) => ({
        label: group.group,
        value: group.total,
        share: group.share,
      })),
      valueFormat: format,
    });
    if (grain && result.groups.some((group) => group.changePercent !== null))
      charts.push({
        kind: "change",
        id: "change-groups",
        title: `Mức tăng/giảm kỳ cuối so với kỳ đầu`,
        bars: [...result.groups]
          .sort((a, b) => (a.changePercent ?? 0) - (b.changePercent ?? 0))
          .map((group) => ({
            label: group.group,
            percent: group.changePercent,
            from: group.first ?? 0,
            to: group.last ?? 0,
          })),
        valueFormat: format,
      });
  }
  return charts;
}

/**
 * Các nhận xét tính bằng luật. Đây là nguồn sự thật cho phần nhận xét: AI
 * (nếu bật) chỉ được viết lại cho dễ đọc từ danh sách này.
 */
export function buildFacts(
  plan: AnalysisPlan,
  result: ExecutionResult,
  format: ValueFormat,
): Fact[] {
  const facts: Fact[] = [];
  const measure = plan.measure.label;
  const grain = plan.time?.grain ?? null;
  const { overall } = result;
  const value = (amount: number) => formatValue(amount, format);
  const period = (key: string) => describePeriod(key, grain);
  const toneOf = (change: number | null): Fact["tone"] =>
    change === null || change === 0 ? "neutral" : change > 0 ? "positive" : "negative";

  if (result.rowsUsed === 0) {
    facts.push({
      kind: "total",
      tone: "neutral",
      text: "Không có dòng dữ liệu nào khớp với yêu cầu.",
    });
    return facts;
  }

  // Tổng gồm cả kỳ đang diễn ra, nên khoảng ghi theo mọi kỳ trên biểu đồ.
  const span =
    grain && result.periods.length > 0
      ? ` (${period(result.periods[0]!)} – ${period(result.periods.at(-1)!)})`
      : "";
  if (plan.measure.aggregate === "sum" || plan.measure.aggregate === "count")
    facts.push({
      kind: "total",
      tone: "neutral",
      text: `Tổng ${measure.toLowerCase()}${span}: ${value(overall.total)}.`,
    });

  if (grain && overall.changePercent !== null && overall.first !== null && overall.last !== null) {
    const amount = `${Math.abs(overall.changePercent).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
    const direction =
      overall.changePercent === 0
        ? "không đổi"
        : `${overall.changePercent > 0 ? "tăng" : "giảm"} ${amount}`;
    const trend =
      overall.trendPercent !== null
        ? ` Đường xu hướng cả kỳ ${overall.trendPercent === 0 ? "đi ngang" : overall.trendPercent > 0 ? "đi lên" : "đi xuống"} (${formatPercent(overall.trendPercent)}).`
        : "";
    facts.push({
      kind: "change",
      tone: toneOf(overall.changePercent),
      text: `${measure} ${period(overall.lastPeriod!)} ${direction} so với ${period(overall.firstPeriod!)} (${value(overall.first)} → ${value(overall.last)}).${trend}`,
    });
  }

  if (grain && overall.peak && overall.low && overall.peak.period !== overall.low.period) {
    facts.push({
      kind: "peak",
      tone: "neutral",
      text: `Cao nhất vào ${period(overall.peak.period)} (${value(overall.peak.value)}), thấp nhất vào ${period(overall.low.period)} (${value(overall.low.value)}).`,
    });
  }

  if (grain && overall.lastStepPercent !== null && result.periods.length > 2) {
    facts.push({
      kind: "step",
      tone: toneOf(overall.lastStepPercent),
      text: `Kỳ gần nhất so với kỳ liền trước: ${formatPercent(overall.lastStepPercent)}.`,
    });
  }

  const realGroups = result.groups.filter((group) => group.group !== OTHER_GROUP);
  if (realGroups.length > 1) {
    const unit = humanizeColumn(plan.groupBy!.column);
    const withChange = realGroups.filter((group) => group.changePercent !== null);
    if (grain && withChange.length > 0) {
      const worst = withChange.reduce((a, b) => (b.changePercent! < a.changePercent! ? b : a));
      const best = withChange.reduce((a, b) => (b.changePercent! > a.changePercent! ? b : a));
      if (worst.changePercent! < 0)
        facts.push({
          kind: "decline",
          tone: "negative",
          text: `${unit} "${worst.group}" giảm mạnh nhất: ${formatPercent(worst.changePercent!)} (${value(worst.first!)} → ${value(worst.last!)}).`,
        });
      else
        facts.push({
          kind: "decline",
          tone: "positive",
          text: `Không ${unit.toLowerCase()} nào giảm; thấp nhất là "${worst.group}" với ${formatPercent(worst.changePercent!)}.`,
        });
      if (best !== worst && best.changePercent! > 0)
        facts.push({
          kind: "growth",
          tone: "positive",
          text: `${unit} "${best.group}" tăng mạnh nhất: ${formatPercent(best.changePercent!)} (${value(best.first!)} → ${value(best.last!)}).`,
        });
      const declining = withChange.filter((group) => group.changePercent! < 0);
      if (declining.length > 1)
        facts.push({
          kind: "decline",
          tone: "negative",
          text: `${declining.length}/${withChange.length} ${unit.toLowerCase()} có ${measure.toLowerCase()} kỳ cuối thấp hơn kỳ đầu: ${declining.map((group) => group.group).join(", ")}.`,
        });
    }
    const leader = realGroups[0]!;
    const laggard = realGroups.at(-1)!;
    facts.push({
      kind: "share",
      tone: "neutral",
      text:
        leader.share !== null
          ? `"${leader.group}" dẫn đầu với ${value(leader.total)} (${leader.share.toLocaleString("vi-VN")}% tổng); thấp nhất là "${laggard.group}" với ${value(laggard.total)}.`
          : `"${leader.group}" cao nhất (${value(leader.total)}); thấp nhất là "${laggard.group}" (${value(laggard.total)}).`,
    });
  }

  for (const anomaly of overall.anomalies.slice(0, 3))
    facts.push({
      kind: "anomaly",
      tone: anomaly.direction === "high" ? "positive" : "negative",
      text: `${period(anomaly.period)} ${anomaly.direction === "high" ? "cao" : "thấp"} bất thường so với các kỳ khác (${value(anomaly.value)}).`,
    });

  return facts;
}

/** Nhận xét khi không dùng AI: câu tiêu đề lấy từ ý quan trọng nhất. */
export function narrativeFromFacts(facts: Fact[]): Narrative {
  const headline =
    facts.find((fact) => fact.kind === "decline" && fact.tone === "negative") ??
    facts.find((fact) => fact.kind === "change") ??
    facts[0];
  return {
    headline: headline?.text ?? "Không có dữ liệu để nhận xét.",
    findings: facts.filter((fact) => fact !== headline).map((fact) => fact.text),
    recommendations: [],
  };
}
