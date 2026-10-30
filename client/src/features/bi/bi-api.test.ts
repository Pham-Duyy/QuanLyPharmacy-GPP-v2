import { describe, expect, it } from "vitest";
import {
  ageText,
  canSeeInventory,
  clockText,
  errorText,
  matchesText,
  money,
  trendChart,
  trendWithForecast,
  type AnomalyEvent,
  type RevenueForecast,
  type Trend,
} from "./bi-api.js";

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

  it("quyền xem tồn kho theo phạm vi", () => {
    const access = { allStores: true, stores: [], inventoryAll: false, inventoryStores: ["NT01"] };
    expect(canSeeInventory(access, "NT01")).toBe(true);
    expect(canSeeInventory(access, "NT02")).toBe(false);
    expect(canSeeInventory(access, "ALL")).toBe(false);
    expect(canSeeInventory({ ...access, inventoryAll: true }, "ALL")).toBe(true);
    expect(canSeeInventory(undefined, "NT01")).toBe(false);
  });

  it("tìm không dấu, tiền tròn đồng", () => {
    expect(matchesText("siro ho", "Siro ho Prospan 100ml")).toBe(true);
    expect(matchesText("đường", null, "Que thử đường huyết")).toBe(true);
    expect(matchesText("duong", "Que thử đường huyết")).toBe(true);
    expect(matchesText("xyz", "Paracetamol")).toBe(false);
    expect(matchesText("  ", "bất kỳ")).toBe(true);
    expect(money(3_606_160.72)).toBe(money(3_606_161));
    expect(money(null)).toBe("—");
  });

  it("biểu đồ ngày nối dự báo nét đứt, dải tin cậy, chấm bất thường", () => {
    const trend: Trend = {
      grain: "day",
      start: "2026-10-28",
      end: "2026-10-30",
      points: [
        { period_start: "2026-10-28", revenue: 100, profit: 30, orders: 5, partial: false },
        { period_start: "2026-10-29", revenue: 40, profit: 10, orders: 2, partial: false },
        { period_start: "2026-10-30", revenue: 60, profit: 20, orders: 3, partial: true },
      ],
    };
    const forecast: RevenueForecast = {
      status: "ok",
      model: "holt_winters",
      model_label: "Holt-Winters",
      accuracy_measured: true,
      wape: 0.091,
      total: 330,
      change_vs_last_7_pct: 1.5,
      points: [
        { date: "2026-10-30", value: 110, low: 90, high: 120 },
        { date: "2026-10-31", value: 120, low: 100, high: 130 },
      ],
    };
    const outage = {
      kind: "revenue_drop_day",
      store_code: "CH01",
      days: ["2026-10-29"],
      message: "CH01 mất điện",
    } as AnomalyEvent;
    const medicine = {
      kind: "medicine_drop",
      store_code: "CH01",
      days: ["2026-10-28"],
      message: "thuốc",
    } as AnomalyEvent;
    // Bất thường của cửa hàng khác không được chấm lên biểu đồ CH01.
    const elsewhere = { ...outage, store_code: "CH03", days: ["2026-10-28"] } as AnomalyEvent;
    const chart = trendWithForecast(trend, forecast, [outage, medicine, elsewhere], "CH01");

    expect(chart.labels).toEqual(["28/10", "29/10", "30/10 *", "31/10"]);
    expect(chart.series.map((line) => line.name)).toEqual([
      "Doanh thu",
      "Lợi nhuận",
      "Dự báo doanh thu",
    ]);
    expect(chart.series[0]!.values).toEqual([100, 40, 60, null]);
    // Hôm nay có cả số đến giờ này (60) và dự báo cả ngày (110) để so.
    expect(chart.series[2]!.values).toEqual([null, null, 110, 120]);
    expect(chart.series[2]!.dashed).toBe(true);
    expect(chart.band!.low).toEqual([null, null, 90, 100]);
    expect(chart.markers).toEqual([{ index: 1, note: "CH01 mất điện" }]); // không chấm thuốc, không chấm CH03
    expect(trendWithForecast(trend, forecast, [outage], "ALL").markers).toEqual([]);

    expect(trendWithForecast({ ...trend, grain: "week" }, forecast).series).toHaveLength(2);
    expect(
      trendWithForecast(trend, { status: "insufficient_data", message: "Chưa đủ" }).band,
    ).toBeUndefined();
    expect(errorText(0.091)).toBe("±9%");
    expect(errorText(null)).toBe("chưa đo được");
  });
});
