import { Empty } from "antd";
import { useEffect, useRef, useState } from "react";
import { chartColors } from "../../app/theme.js";
import {
  formatCompact,
  formatFull,
  formatSignedPercent,
  type SeriesLine,
  type ValueFormat,
} from "./analytics-api.js";

/**
 * Biểu đồ của trợ lý phân tích, vẽ bằng SVG thuần như các biểu đồ khác của
 * dự án (`charts.tsx`): không kéo thư viện biểu đồ vào cho vài kiểu hình.
 */

function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(entry.contentRect.width, 280));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** Mốc trục tung tròn số: 1, 2, 2.5, 5 × 10^n. */
function niceTicks(minimum: number, maximum: number, count = 4): number[] {
  if (minimum === maximum) maximum = minimum + 1;
  const raw = (maximum - minimum) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((value) => value >= raw)!;
  const start = Math.floor(minimum / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= maximum + step * 0.001; value += step) ticks.push(value);
  if (ticks.at(-1)! < maximum) ticks.push(ticks.at(-1)! + step);
  return ticks;
}

const HEIGHT = 280;
const PAD = { top: 16, right: 16, bottom: 34, left: 76 };

/** Dải tô mờ giữa hai đường (ví dụ khoảng tin cậy của dự báo). */
export type ChartBand = {
  name: string;
  low: Array<number | null>;
  high: Array<number | null>;
  color?: string;
};
/** Chấm đánh dấu trên đường đầu tiên (ví dụ ngày bất thường); `note` hiện khi rê chuột. */
export type ChartMarker = { index: number; note: string };

export function LineChart({
  labels,
  series,
  valueFormat,
  band,
  markers = [],
}: {
  labels: string[];
  series: SeriesLine[];
  valueFormat: ValueFormat;
  band?: ChartBand;
  markers?: ChartMarker[];
}) {
  const { ref, width } = useWidth(720);
  const [hover, setHover] = useState<number | null>(null);
  const colorOf = (line: SeriesLine, index: number) =>
    line.color ?? chartColors[index % chartColors.length]!;
  const values = [
    ...series.flatMap((line) => line.values),
    ...(band ? [...band.low, ...band.high] : []),
  ].filter((value): value is number => value !== null);
  if (labels.length === 0 || values.length === 0)
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có dữ liệu" />;

  const ticks = niceTicks(Math.min(0, ...values), Math.max(...values));
  const low = ticks[0]!;
  const high = ticks.at(-1)!;
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (index: number) =>
    PAD.left + (labels.length === 1 ? plotWidth / 2 : (index / (labels.length - 1)) * plotWidth);
  const y = (value: number) => PAD.top + plotHeight - ((value - low) / (high - low)) * plotHeight;
  const labelEvery = Math.max(
    1,
    Math.ceil(labels.length / Math.max(2, Math.floor(plotWidth / 70))),
  );

  const pathOf = (line: SeriesLine) => {
    let path = "";
    let open = false;
    line.values.forEach((value, index) => {
      if (value === null) {
        open = false;
        return;
      }
      path += `${open ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
      open = true;
    });
    return path;
  };

  // Dải: đi theo đường trên từ trái sang phải, rồi đường dưới từ phải sang trái, đóng lại.
  const bandPath = (() => {
    if (!band) return "";
    const indexes = band.low
      .map((_, index) => index)
      .filter((index) => band.low[index] !== null && band.high[index] !== null);
    if (indexes.length < 2) return "";
    const top = indexes.map(
      (index, step) =>
        `${step ? "L" : "M"}${x(index).toFixed(1)},${y(band.high[index]!).toFixed(1)}`,
    );
    const bottom = [...indexes]
      .reverse()
      .map((index) => `L${x(index).toFixed(1)},${y(band.low[index]!).toFixed(1)}`);
    return `${top.join("")}${bottom.join("")}Z`;
  })();
  const markerAt = new Map(markers.map((marker) => [marker.index, marker.note]));

  const onMove = (event: React.PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    setHover(Math.round(ratio * (labels.length - 1)));
  };

  const single = series.length === 1;
  return (
    <div ref={ref} className="analysis-line">
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`Biểu đồ đường ${series.map((line) => line.name).join(", ")}`}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
              className="analysis-grid"
            />
            <text
              x={PAD.left - 8}
              y={y(tick)}
              className="analysis-axis"
              textAnchor="end"
              dominantBaseline="middle"
            >
              {formatCompact(tick, valueFormat)}
            </text>
          </g>
        ))}
        {labels.map((label, index) => {
          const last = index === labels.length - 1;
          if (index % labelEvery !== 0 && !last) return null;
          // Nhãn cuối luôn hiện: bỏ nhãn đều đặn ngay trước nó nếu quá sát (tránh chồng chữ).
          if (!last && labelEvery > 1 && labels.length - 1 - index < labelEvery) return null;
          // Nhãn sát mép canh vào trong để không bị cắt.
          const anchor =
            labels.length > 1 && last
              ? "end"
              : index === 0 && labels.length > 1
                ? "start"
                : "middle";
          return (
            <text
              key={index}
              x={x(index)}
              y={HEIGHT - 10}
              className="analysis-axis"
              textAnchor={anchor}
            >
              {label}
            </text>
          );
        })}
        {single ? (
          <path
            d={`${pathOf(series[0]!)}L${x(series[0]!.values.length - 1)},${y(low)}L${x(0)},${y(low)}Z`}
            fill={chartColors[0]}
            opacity={0.08}
          />
        ) : null}
        {bandPath ? (
          <path d={bandPath} fill={band?.color ?? chartColors[0]} opacity={0.14} />
        ) : null}
        {series.map((line, index) => (
          <path
            key={line.name}
            d={pathOf(line)}
            fill="none"
            stroke={colorOf(line, index)}
            strokeWidth={single ? 2.5 : 2}
            strokeLinejoin="round"
            strokeDasharray={line.dashed ? "6 5" : undefined}
          />
        ))}
        {labels.length <= 40
          ? series.map((line, seriesIndex) =>
              line.values.map((value, index) =>
                value === null ? null : (
                  <circle
                    key={`${line.name}-${index}`}
                    cx={x(index)}
                    cy={y(value)}
                    r={hover === index ? 4.5 : 3}
                    fill="var(--c-surface)"
                    stroke={colorOf(line, seriesIndex)}
                    strokeWidth={2}
                  />
                ),
              ),
            )
          : null}
        {markers.map((marker) => {
          const value = series[0]?.values[marker.index];
          if (value === null || value === undefined) return null;
          return (
            <circle
              key={`marker-${marker.index}`}
              cx={x(marker.index)}
              cy={y(value)}
              r={hover === marker.index ? 7 : 5.5}
              className="analysis-marker"
            />
          );
        })}
        {hover !== null ? (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={PAD.top}
            y2={PAD.top + plotHeight}
            className="analysis-guide"
          />
        ) : null}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={plotWidth}
          height={plotHeight}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hover !== null ? (
        <div
          className="analysis-tooltip"
          style={{ left: Math.min(x(hover) + 12, width - 220), top: PAD.top }}
        >
          <strong>{labels[hover]}</strong>
          {series.map((line, index) =>
            line.values[hover] === null && line.dashed ? null : (
              <div key={line.name} className="analysis-tooltip-row">
                <span className="donut-dot" style={{ background: colorOf(line, index) }} />
                <span className="analysis-tooltip-name">{line.name}</span>
                <span>
                  {line.values[hover] === null || line.values[hover] === undefined
                    ? "—"
                    : formatFull(line.values[hover]!, valueFormat)}
                </span>
              </div>
            ),
          )}
          {band && band.low[hover] !== null && band.low[hover] !== undefined ? (
            <div className="analysis-tooltip-row">
              <span className="analysis-tooltip-name">{band.name}</span>
              <span>
                {formatCompact(band.low[hover]!, valueFormat)} –{" "}
                {formatCompact(band.high[hover]!, valueFormat)}
              </span>
            </div>
          ) : null}
          {markerAt.has(hover) ? (
            <div className="analysis-tooltip-alert">{markerAt.get(hover)}</div>
          ) : null}
        </div>
      ) : null}
      {!single ? (
        <div className="analysis-legend">
          {series.map((line, index) => (
            <span key={line.name} className="analysis-legend-item">
              <span className="donut-dot" style={{ background: colorOf(line, index) }} />
              {line.name}
            </span>
          ))}
          {markers.length ? (
            <span className="analysis-legend-item">
              <span className="donut-dot analysis-marker-dot" />
              Ngày bất thường
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Thanh ngang xếp hạng: hợp với tên nhóm dài (tên cửa hàng, tên thuốc). */
export function RankBars({
  bars,
  valueFormat,
}: {
  /** color: màu riêng khi màu mang nghĩa (đỏ = hết hạn…); bỏ trống thì lấy theo thứ tự. */
  bars: Array<{ label: string; value: number; share: number | null; color?: string }>;
  valueFormat: ValueFormat;
}) {
  const maximum = Math.max(...bars.map((bar) => Math.abs(bar.value)), 1);
  return (
    <div className="analysis-rank">
      {bars.map((bar, index) => (
        <div key={bar.label} className="analysis-rank-row">
          <span className="analysis-rank-label" title={bar.label}>
            {bar.label}
          </span>
          <div className="analysis-rank-track">
            <div
              className="analysis-rank-fill"
              style={{
                width: `${Math.max((Math.abs(bar.value) / maximum) * 100, 1)}%`,
                background: bar.color ?? chartColors[index % chartColors.length],
              }}
            />
          </div>
          <span className="analysis-rank-value" title={formatFull(bar.value, valueFormat)}>
            {formatCompact(bar.value, valueFormat)}
            {bar.share !== null ? <small> · {bar.share.toLocaleString("vi-VN")}%</small> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Thanh phân kỳ quanh mốc 0: giảm sang trái màu đỏ, tăng sang phải màu xanh. */
export function ChangeBars({
  bars,
  valueFormat,
}: {
  bars: Array<{ label: string; percent: number | null; from: number; to: number }>;
  valueFormat: ValueFormat;
}) {
  const maximum = Math.max(...bars.map((bar) => Math.abs(bar.percent ?? 0)), 1);
  return (
    <div className="analysis-change">
      {bars.map((bar) => {
        const percent = bar.percent ?? 0;
        const width = `${(Math.abs(percent) / maximum) * 50}%`;
        return (
          <div
            key={bar.label}
            className="analysis-change-row"
            title={`${formatFull(bar.from, valueFormat)} → ${formatFull(bar.to, valueFormat)}`}
          >
            <span className="analysis-rank-label">{bar.label}</span>
            <div className="analysis-change-track">
              <span className="analysis-change-axis" />
              <div
                className={percent < 0 ? "analysis-change-fill down" : "analysis-change-fill up"}
                style={percent < 0 ? { right: "50%", width } : { left: "50%", width }}
              />
            </div>
            <span
              className={percent < 0 ? "analysis-change-value down" : "analysis-change-value up"}
            >
              {formatSignedPercent(bar.percent)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
