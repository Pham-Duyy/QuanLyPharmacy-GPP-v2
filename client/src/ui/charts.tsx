import { Empty, Tooltip } from "antd";
import type { ReactNode } from "react";

export type DonutSlice = { label: string; value: number; color: string };

/**
 * Biểu đồ tròn dựng bằng conic-gradient thuần CSS — không kéo cả thư viện
 * biểu đồ vào chỉ để vẽ vài vòng tròn.
 */
export function Donut({
  slices,
  centerLabel,
  formatTotal,
  emptyText = "Chưa có dữ liệu",
}: {
  slices: DonutSlice[];
  centerLabel: string;
  formatTotal: (total: number) => string;
  emptyText?: string;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (slices.length === 0 || total <= 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />;

  const ends = slices.reduce<number[]>((acc, slice) => [...acc, (acc.at(-1) ?? 0) + slice.value], []);
  const stops = slices.map((slice, index) => {
    const start = ((ends[index - 1] ?? 0) / total) * 360;
    const end = (ends[index]! / total) * 360;
    return `${slice.color} ${start}deg ${end}deg`;
  });

  return (
    <div className="donut-wrap">
      <div className="donut-chart" style={{ background: `conic-gradient(${stops.join(", ")})` }} role="img" aria-label={centerLabel}>
        <div className="donut-center">
          <span>{centerLabel}</span>
          <strong>{formatTotal(total)}</strong>
        </div>
      </div>
      <div className="donut-legend">
        {slices.map((slice) => (
          <div className="donut-legend-item" key={slice.label}>
            <span className="donut-dot" style={{ background: slice.color }} />
            <span className="donut-legend-label" title={slice.label}>
              {slice.label}
            </span>
            <span className="donut-legend-value">{Math.round((slice.value / total) * 1000) / 10}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export type BarPoint = { key: string; label: string; value: number; tooltip: ReactNode };

export function BarTrend({ points, variant = "revenue", emptyText }: { points: BarPoint[]; variant?: "revenue" | "profit"; emptyText: string }) {
  if (points.every((point) => point.value === 0)) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />;
  const maximum = Math.max(...points.map((point) => point.value), 1);
  // Kỳ dài thì nhãn ngày dày đặc, chỉ in cách quãng cho dễ đọc.
  const labelEvery = points.length > 16 ? Math.ceil(points.length / 10) : 1;

  return (
    <div className="revenue-chart">
      {points.map((point, index) => (
        <Tooltip key={point.key} title={point.tooltip}>
          <div className="revenue-bar-item">
            <div className="revenue-bar-wrap">
              <div
                className={variant === "profit" ? "revenue-bar profit" : "revenue-bar"}
                style={{ height: `${Math.max((Math.max(point.value, 0) / maximum) * 100, point.value > 0 ? 3 : 0)}%` }}
              />
            </div>
            <span>{index % labelEvery === 0 ? point.label : " "}</span>
          </div>
        </Tooltip>
      ))}
    </div>
  );
}
