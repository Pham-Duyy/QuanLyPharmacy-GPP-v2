"""Kiểm thử KPI Engine (bước 1.3).

Hai lớp kiểm chứng:
1. Bộ dữ liệu nhỏ, đáp án tính tay (ghi ngay trong test).
2. Đối chiếu với một cách tính độc lập kiểu PivotTable: duyệt từng dòng bằng
   Python thuần, không dùng pandas, trên bộ dữ liệu mẫu hàng chục nghìn dòng.
   Hai cách tính khác nhau ra cùng một số thì mới tin được.
"""

from __future__ import annotations

import importlib.util
import math
import random
from datetime import date, datetime
from pathlib import Path

import pandas as pd
import pytest

from app.analytics import compute_kpis, growth_pct, kpi_summary, period_windows, prepare_sales, sales_breakdown, sales_trend
from app.analytics.periods import Window

AS_OF = pd.Timestamp("2026-10-29 12:00")  # thứ Năm


def line(sale_id, at, code, quantity, price, cost, store="CH01", sale_type="retail") -> dict:
    return {
        "sale_id": sale_id,
        "line_no": 1,
        "sale_datetime": pd.Timestamp(at),
        "sale_type": sale_type,
        "store_code": store,
        "medicine_code": code,
        "batch_code": None,
        "quantity": float(quantity),
        "selling_price": float(price),
        "purchase_price": float(cost) if cost is not None else math.nan,
        "customer_id": None,
        "payment_method": "cash",
    }


MEDICINES = pd.DataFrame(
    [
        {"medicine_code": "GD001", "medicine_name": "Paracetamol 500mg", "category": "Giảm đau"},
        {"medicine_code": "KS001", "medicine_name": "Amoxicillin 500mg", "category": "Kháng sinh"},
    ]
)


@pytest.fixture
def small_sales() -> pd.DataFrame:
    rows = [
        line("HD1", "2026-10-29 09:00", "GD001", 10, 1_200, 800),  # hôm nay: 12.000 / vốn 8.000
        {**line("HD1", "2026-10-29 09:00", "KS001", 2, 5_000, 3_500), "line_no": 2},  # 10.000 / 7.000
        line("HD2", "2026-10-29 10:00", "GD001", 5, 1_200, None),  # 6.000, không có giá vốn
        line("HD3", "2026-10-28 08:00", "GD001", 20, 1_200, 800),  # hôm qua trước 12h: 24.000 / 16.000
        line("HD4", "2026-10-28 15:00", "KS001", 1, 5_000, 3_500),  # hôm qua sau 12h: 5.000
        line("HD5", "2026-10-29 13:00", "GD001", 100, 1_200, 800),  # sau thời điểm tính: không được tính
        line("HD6", "2026-10-20 09:00", "GD001", 10, 1_000, 800, store="CH02"),  # thứ Hai tuần trước
    ]
    return prepare_sales(pd.DataFrame(rows), MEDICINES)


# --- Khoảng thời gian ---------------------------------------------------------------


def test_week_windows_compare_same_elapsed_time():
    windows = period_windows(pd.Timestamp("2026-10-30 15:00"), "week")  # thứ Sáu
    assert windows.current == Window(pd.Timestamp("2026-10-26"), pd.Timestamp("2026-10-30 15:00"))
    assert windows.previous_same_span == Window(pd.Timestamp("2026-10-19"), pd.Timestamp("2026-10-23 15:00"))
    assert windows.previous_full == Window(pd.Timestamp("2026-10-19"), pd.Timestamp("2026-10-26"))


def test_month_window_does_not_spill_past_shorter_previous_month():
    windows = period_windows(pd.Timestamp("2026-10-31 15:00"), "month")
    assert windows.previous_same_span == Window(pd.Timestamp("2026-09-01"), pd.Timestamp("2026-10-01"))
    windows = period_windows(pd.Timestamp("2026-03-30 10:00"), "month")
    assert windows.previous_same_span.end == pd.Timestamp("2026-03-01")  # tháng 2/2026 chỉ có 28 ngày


def test_day_windows():
    windows = period_windows(AS_OF, "day")
    assert windows.current == Window(pd.Timestamp("2026-10-29"), AS_OF)
    assert windows.previous_same_span == Window(pd.Timestamp("2026-10-28"), pd.Timestamp("2026-10-28 12:00"))


# --- Công thức KPI ------------------------------------------------------------------


def test_kpis_hand_calculated(small_sales):
    today = small_sales[period_windows(AS_OF, "day").current.contains(small_sales["sale_datetime"])]
    kpi = compute_kpis(today)
    assert kpi.revenue == 28_000  # 12.000 + 10.000 + 6.000
    assert kpi.cogs == 15_000  # 8.000 + 7.000 (dòng HD2 không có giá vốn)
    assert kpi.profit == 7_000  # 22.000 doanh thu có giá vốn − 15.000
    assert kpi.margin_pct == 31.82  # 7.000 / 22.000
    assert kpi.orders == 2  # HD1, HD2
    assert kpi.units == 17
    assert kpi.lines == 3
    assert kpi.avg_order_value == 14_000
    assert kpi.cost_coverage_pct == 78.57  # 22.000 / 28.000


def test_growth_rules():
    assert growth_pct(120, 100) == 20.0
    assert growth_pct(80, 100) == -20.0
    assert growth_pct(50, 0) is None  # không chia cho 0
    assert growth_pct(None, 100) is None


def test_summary_compares_with_same_time_yesterday(small_sales):
    summary = kpi_summary(small_sales, AS_OF)
    day = summary["periods"]["day"]
    assert day["current"]["revenue"] == 28_000
    # Hôm qua tới 12h chỉ có HD3; HD4 lúc 15h nằm ngoài khoảng so sánh.
    assert day["previous_same_span"]["revenue"] == 24_000
    assert day["previous_full"]["revenue"] == 29_000
    assert day["growth"] == {
        "revenue": 16.7,  # (28.000 − 24.000) / 24.000
        "profit": -12.5,  # (7.000 − 8.000) / 8.000
        "orders": 100.0,
        "units": -15.0,
        "avg_order_value": -41.7,  # 14.000 so với 24.000
    }
    week = summary["periods"]["week"]
    assert week["current"]["revenue"] == 57_000  # HD1–HD4; HD5 sau thời điểm tính
    assert week["previous_full"]["revenue"] == 10_000  # HD6
    # Toàn bộ dữ liệu tới thời điểm tính: không gồm HD5.
    assert summary["all_time"]["revenue"] == 67_000


def test_summary_for_one_store(small_sales):
    summary = kpi_summary(small_sales, AS_OF, store_code="CH02")
    assert summary["periods"]["week"]["current"]["revenue"] == 0
    assert summary["periods"]["week"]["previous_full"]["revenue"] == 10_000
    assert summary["periods"]["week"]["growth"]["revenue"] == -100.0


def test_empty_period_has_no_ratios(small_sales):
    empty = compute_kpis(small_sales.iloc[0:0])
    assert (empty.revenue, empty.orders, empty.margin_pct, empty.avg_order_value) == (0, 0, None, None)


# --- Chuỗi thời gian và cơ cấu ------------------------------------------------------------


def test_trend_fills_missing_days_and_starts_weeks_on_monday(small_sales):
    window = Window(pd.Timestamp("2026-10-20"), AS_OF)
    daily = sales_trend(small_sales, window, "day")
    assert [point["period_start"] for point in daily] == [f"2026-10-{day}" for day in range(20, 30)]
    assert daily[0]["revenue"] == 10_000 and daily[1]["revenue"] == 0
    assert sum(point["revenue"] for point in daily) == 67_000

    weekly = sales_trend(small_sales, window, "week")
    assert [(point["period_start"], point["revenue"]) for point in weekly] == [("2026-10-19", 10_000), ("2026-10-26", 57_000)]


def test_breakdown_by_category_sorted_with_shares(small_sales):
    rows = sales_breakdown(small_sales, Window(pd.Timestamp("2026-10-26"), AS_OF), "category")
    assert [(row["label"], row["revenue"], row["share_pct"]) for row in rows] == [
        ("Giảm đau", 42_000.0, 73.7),
        ("Kháng sinh", 15_000.0, 26.3),
    ]
    labels = [row["label"] for row in sales_breakdown(small_sales, Window(pd.Timestamp("2026-10-26"), AS_OF), "sale_type")]
    assert labels == ["Bán lẻ"]


# --- Đối chiếu kiểu PivotTable trên dữ liệu mẫu lớn -------------------------------------


def _sample_sales() -> pd.DataFrame:
    path = Path(__file__).resolve().parent.parent / "scripts" / "generate_sample_data.py"
    spec = importlib.util.spec_from_file_location("generate_sample_data", path)
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    rng = random.Random(11)
    medicines = generator.build_medicines(rng)
    sales = generator.build_sales(rng, 70, date(2026, 10, 30), datetime(2026, 10, 30, 23, 59))
    sales["sale_datetime"] = pd.to_datetime(sales["sale_datetime"])
    sales = sales.astype({"quantity": float, "selling_price": float, "purchase_price": float})
    return prepare_sales(sales, medicines)


def _pivot(rows: list[dict], window: Window) -> dict:
    """Cách tính thứ hai, như PivotTable: lọc theo ngày rồi cộng từng dòng."""
    revenue = cogs = units = 0.0
    orders = set()
    for row in rows:
        if window.start <= row["sale_datetime"] < window.end:
            revenue += row["quantity"] * row["selling_price"]
            cogs += row["quantity"] * row["purchase_price"]
            units += row["quantity"]
            orders.add(row["sale_id"])
    return {"revenue": round(revenue, 2), "cogs": round(cogs, 2), "units": round(units, 2), "orders": len(orders)}


@pytest.mark.parametrize("as_of", ["2026-10-30 17:30", "2026-10-26 08:00", "2026-10-01 00:00"])
def test_engine_matches_pivot_on_sample_data(as_of):
    sales = _sample_sales()
    rows = sales[["sale_id", "sale_datetime", "quantity", "selling_price", "purchase_price"]].to_dict("records")
    moment = pd.Timestamp(as_of)
    summary = kpi_summary(sales, moment)
    for name in ("day", "week", "month"):
        windows = period_windows(moment, name)
        for key, window in (
            ("current", windows.current),
            ("previous_same_span", windows.previous_same_span),
            ("previous_full", windows.previous_full),
        ):
            engine = summary["periods"][name][key]
            expected = _pivot(rows, window)
            got = {field: engine[field] for field in ("revenue", "cogs", "units", "orders")}
            assert got == pytest.approx(expected, abs=0.01), f"{name}/{key}"
