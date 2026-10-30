import { describe, expect, it } from "vitest";
import { ageText, clockText, trendChart, type Trend } from "./bi-api.js";

describe("bảng điều hành", () => {
  it("biểu đồ đánh dấu kỳ đang dở", () => {
    const trend: Trend = {
      grain: "week",
      start: "2026-10-19",
      end: "2026-10-29",
      points: [
        { period_start: "2026-10-19", revenue: 6_000, profit: 2_000, orders: 1, partial: false },
        { period_start: "2026-10-26", revenue: 22_000, profit: 7_000, orders: 2, partial: true },
      ],
    };
    const chart = trendChart(trend);
    expect(chart.labels).toEqual(["Tuần 19/10", "Tuần 26/10 *"]);
    expect(chart.series.map((line) => line.values)).toEqual([
      [6_000, 22_000],
      [2_000, 7_000],
    ]);
    expect(chart.hasPartial).toBe(true);
    expect(
      trendChart({
        ...trend,
        grain: "month",
        points: [{ ...trend.points[0]!, period_start: "2026-10-01" }],
      }).labels,
    ).toEqual(["10/2026"]);
  });

  it("thời điểm và độ cũ của số liệu", () => {
    expect(clockText("2026-10-29T16:49:03+07:00")).toBe("16:49:03 29/10/2026");
    expect(clockText(null)).toBe("—");
    expect(ageText(12)).toBe("vừa xong");
    expect(ageText(185)).toBe("3 phút trước");
    expect(ageText(7_300)).toBe("2 giờ trước");
    expect(ageText(null)).toBe("chưa rõ");
  });
});
