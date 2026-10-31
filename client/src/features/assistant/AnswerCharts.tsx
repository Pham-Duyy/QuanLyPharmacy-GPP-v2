import { LineChart, RankBars } from "../analytics/AnalysisCharts.js";
import type { AnswerChart } from "./assistant-api.js";

/**
 * Biểu đồ dưới câu trả lời. Số lấy từ đúng kết quả tool máy chủ đã đọc (đã lọc quyền), không
 * do mô hình đưa ra, nên luôn khớp nguồn số liệu.
 */
export function AnswerCharts({ charts }: { charts: AnswerChart[] }) {
  if (charts.length === 0) return null;
  return (
    <div className="assistant-charts">
      {charts.map((chart) => (
        <figure key={chart.title} className="assistant-chart">
          <figcaption>{chart.title}</figcaption>
          {chart.kind === "line" ? (
            <LineChart
              labels={chart.labels}
              series={chart.series}
              valueFormat={chart.valueFormat}
              {...(chart.band ? { band: { ...chart.band, name: "Khoảng tin cậy ~80%" } } : {})}
            />
          ) : (
            <RankBars bars={chart.bars} valueFormat={chart.valueFormat} />
          )}
        </figure>
      ))}
    </div>
  );
}
