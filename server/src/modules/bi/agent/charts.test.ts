import { describe, expect, it } from "vitest";
import { chartFromTool, collectCharts, MAX_CHARTS } from "./charts.js";

/** Biểu đồ trong câu trả lời (bước 6.4): dựng tất định từ kết quả tool. */

describe("biểu đồ từ kết quả tool", () => {
  it("xu hướng: nhãn kỳ, đánh dấu kỳ dở dang; không có lợi nhuận thì chỉ một đường", () => {
    const content = {
      grain: "week",
      points: [
        { period_start: "2026-10-19", revenue: 6_000, partial: false },
        { period_start: "2026-10-26", revenue: 9_000, partial: true },
      ],
    };
    expect(chartFromTool("get_sales_trend", { store: "ALL", grain: "week" }, content)).toEqual({
      kind: "line",
      title: "Doanh thu theo tuần · toàn chuỗi",
      labels: ["Tuần 19/10", "Tuần 26/10 *"],
      series: [{ name: "Doanh thu", values: [6_000, 9_000] }],
      valueFormat: "currency",
    });
    const withProfit = chartFromTool(
      "get_sales_trend",
      { store: "NT01", grain: "day" },
      {
        points: [
          { period_start: "2026-10-28", revenue: 100, profit: 30 },
          { period_start: "2026-10-29", revenue: 120, profit: 40 },
        ],
      },
    );
    expect(withProfit?.kind === "line" && withProfit.series.map((line) => line.name)).toEqual([
      "Doanh thu",
      "Lợi nhuận",
    ]);
  });

  it("cơ cấu, xếp hạng, dự báo; một điểm hoặc tool khác thì không vẽ", () => {
    expect(
      chartFromTool(
        "get_breakdown",
        { by: "category" },
        {
          rows: [
            { label: "Giảm đau", revenue: 500, share_pct: 50 },
            { label: "Kháng sinh", revenue: 300, share_pct: 30 },
          ],
        },
      ),
    ).toMatchObject({
      kind: "bars",
      title: "Cơ cấu doanh thu theo nhóm thuốc",
      bars: [
        { label: "Giảm đau", value: 500, share: 50 },
        { label: "Kháng sinh", value: 300, share: 30 },
      ],
    });
    expect(
      chartFromTool(
        "get_top_products",
        { store: "NT01", rank: "low_profit" },
        {
          products: [
            { medicine_name: "A", margin_pct: 3 },
            { medicine_name: "B", margin_pct: 5 },
          ],
        },
      ),
    ).toMatchObject({ title: "Thuốc biên lợi nhuận thấp · NT01", valueFormat: "percent" });
    expect(
      chartFromTool(
        "get_forecast",
        { store: "ALL", target: "revenue" },
        {
          points: [
            { date: "2026-11-01", value: 10, low: 8, high: 12 },
            { date: "2026-11-02", value: 11, low: 9, high: 13 },
          ],
        },
      ),
    ).toMatchObject({
      kind: "line",
      labels: ["01/11", "02/11"],
      series: [{ name: "Dự báo", values: [10, 11], dashed: true }],
      band: { low: [8, 9], high: [12, 13] },
    });
    expect(
      chartFromTool("get_breakdown", { by: "store" }, { rows: [{ label: "NT01", revenue: 1 }] }),
    ).toBeNull();
    expect(chartFromTool("get_revenue", { store: "ALL" }, { current: { revenue: 1 } })).toBeNull();
  });

  it("gộp: bỏ tool lỗi, cùng tiêu đề giữ bản mới nhất, tối đa 3 biểu đồ", () => {
    const trend = (revenue: number, store = "ALL") => ({
      name: "get_sales_trend",
      input: { store, grain: "day" },
      ok: true,
      content: {
        points: [
          { period_start: "2026-10-28", revenue },
          { period_start: "2026-10-29", revenue },
        ],
      },
    });
    const charts = collectCharts([
      trend(1),
      { ...trend(2), ok: false },
      trend(3),
      trend(4, "NT01"),
      trend(5, "NT02"),
      trend(6, "NT03"),
    ]);
    expect(charts).toHaveLength(MAX_CHARTS);
    expect(charts.map((chart) => chart.title)).toEqual([
      "Doanh thu theo ngày · NT01",
      "Doanh thu theo ngày · NT02",
      "Doanh thu theo ngày · NT03",
    ]);
    expect(collectCharts([trend(1), trend(3)])).toMatchObject([{ series: [{ values: [3, 3] }] }]);
  });
});
