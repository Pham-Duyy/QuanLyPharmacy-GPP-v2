"""Kiểm thử dự báo Level 1 và backtest (bước 3.4)."""

from __future__ import annotations

import importlib.util
import random
from datetime import date, datetime
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from app.analytics import prepare_sales
from app.analytics.forecast import (
    _with_wholesale,
    backtest,
    choose_model,
    flat_mean,
    forecast_demand,
    forecast_revenue,
    forecast_series,
    naive,
    wape,
    weekday_mean,
)

# Tuần mẫu: thứ Hai..Chủ nhật. Chuỗi bắt đầu thứ Hai 07/09/2026.
WEEK = np.array([10, 10, 11, 11, 12, 15, 20], dtype=float)
START = pd.Timestamp("2026-09-07")


def weekly(weeks: int, *, trend: float = 0.0) -> pd.Series:
    values = np.concatenate([WEEK + trend * week for week in range(weeks)])
    return pd.Series(values, index=pd.date_range(START, periods=len(values), freq="D"))


def test_models_keep_the_weekday():
    history = weekly(4).to_numpy()  # kết thúc Chủ nhật: ngày tới là thứ Hai
    assert naive(history, 8).tolist() == [10, 10, 11, 11, 12, 15, 20, 10]
    assert weekday_mean(history, 7).tolist() == WEEK.tolist()
    assert flat_mean(history, 2).tolist() == [WEEK.mean()] * 2


def test_weekday_mean_averages_four_same_weekdays():
    history = weekly(4, trend=1.0).to_numpy()  # mỗi tuần cao hơn 1
    # Thứ Hai: 10, 11, 12, 13 → 11,5
    assert weekday_mean(history, 1)[0] == pytest.approx(11.5)


def test_wape():
    assert wape(np.array([10.0, 10.0]), np.array([12.0, 8.0])) == pytest.approx(0.2)
    assert wape(np.array([0.0, 0.0]), np.array([1.0, 1.0])) is None


def test_backtest_on_a_perfectly_repeating_week():
    values = weekly(8).to_numpy()  # 56 ngày: đủ 4 lần thử (mỗi lần còn ≥ 28 ngày phía trước)
    result = backtest(values, naive)
    assert (result["folds"], result["wape"], result["bias"], result["wape_total"]) == (4, 0.0, 0.0, 0.0)
    assert len(result["errors"]) == 28
    assert backtest(weekly(5).to_numpy(), naive)["folds"] == 1  # 35 ngày: chỉ một lần thử
    assert backtest(weekly(4).to_numpy(), naive) is None  # 28 ngày: chưa thử được


def test_backtest_error_numbers():
    """Chuỗi tăng đều 1/tuần: lặp lại tuần trước luôn thấp hơn thật đúng 1 mỗi ngày."""
    values = weekly(8, trend=1.0).to_numpy()
    result = backtest(values, naive)
    actual = values[-28:]
    assert result["wape"] == pytest.approx(round(28 / actual.sum(), 4))
    assert result["bias"] == pytest.approx(round(-28 / actual.sum(), 4))  # âm: dự báo thấp hơn thật
    assert set(result["errors"]) == {-1.0}


def test_daily_and_weekly_total_errors_differ():
    """Sai từng ngày nhưng tổng tuần đúng: WAPE ngày lớn, WAPE tổng 7 ngày = 0."""
    values = weekly(8).to_numpy()
    result = backtest(values, flat_mean)
    assert result["wape"] > 0.1
    assert result["wape_total"] == 0.0


def test_choose_model_prefers_lower_error_then_simpler():
    choice = choose_model(weekly(8).to_numpy())
    assert choice["model"] == "naive"  # naive và weekday_mean cùng 0: chọn cái đứng trước
    assert choice["measured"] is True
    noisy = weekly(8).to_numpy() + np.tile([5.0, -5.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4)
    assert choose_model(noisy)["model"] == "weekday_mean"  # trung bình 4 tuần khử được dao động


def test_forecast_series_output():
    result = forecast_series(weekly(8, trend=1.0), horizon=7)
    assert result["status"] == "ok"
    assert [point["date"] for point in result["points"]][:2] == ["2026-11-02", "2026-11-03"]
    assert result["last_7_days"] == pytest.approx(WEEK.sum() + 7 * 7)
    assert result["scores"]["naive"]["folds"] == 4
    assert result["accuracy_measured"] is True


def test_forecast_never_negative_and_needs_history():
    falling = pd.Series(np.linspace(50, -10, 60), index=pd.date_range(START, periods=60, freq="D")).clip(lower=0)
    assert min(point["value"] for point in forecast_series(falling)["points"]) >= 0
    short = forecast_series(weekly(3))
    assert short == {
        "status": "insufficient_data",
        "message": "Chưa đủ dữ liệu để dự báo: mới có 21 ngày đã trọn, cần ít nhất 28 ngày.",
    }


def test_forecast_without_backtest_says_accuracy_unknown():
    result = forecast_series(weekly(4))  # đủ 28 ngày để dự báo nhưng chưa đủ để thử lại
    assert (result["status"], result["model"], result["accuracy_measured"], result["wape"]) == ("ok", "weekday_mean", False, None)


def test_with_wholesale_adds_daily_average_but_compares_retail_only():
    retail = forecast_series(weekly(8))
    index = weekly(8).index
    lumps = pd.Series(0.0, index=index)
    lumps.iloc[-20] = 280.0  # một đơn bán buôn trong 28 ngày → trung bình 10/ngày
    result = _with_wholesale(retail, lumps, index, float(WEEK.sum()))
    assert result["wholesale_per_day"] == 10.0
    assert result["points"][0]["value"] == retail["points"][0]["value"] + 10
    assert result["change_vs_last_7_pct"] == retail["change_vs_last_7_pct"] == 0.0  # tuần qua không có bán buôn: vẫn 0%
    assert result["accuracy_scope"] == "retail"


# --- Trên dữ liệu bán hàng ---------------------------------------------------------------


def sale(day: pd.Timestamp, code: str, quantity: float, sale_type: str = "retail", store: str = "CH01") -> dict:
    return {
        "sale_id": f"{store}-{day:%m%d}-{code}-{sale_type}",
        "line_no": 1,
        "sale_datetime": day + pd.Timedelta(hours=10),
        "sale_type": sale_type,
        "store_code": store,
        "medicine_code": code,
        "quantity": quantity,
        "selling_price": 1_000.0,
        "purchase_price": None,
    }


def test_forecast_revenue_and_demand_split_wholesale():
    days = weekly(8).index
    rows = [sale(day, "AA", WEEK[day.weekday()]) for day in days]
    rows.append(sale(days[-10], "AA", 280.0, "wholesale"))
    sales = prepare_sales(pd.DataFrame(rows), None)
    as_of = days[-1] + pd.Timedelta(days=1, hours=9)

    revenue = forecast_revenue(sales, as_of)
    assert revenue["wape"] == 0.0  # phần bán lẻ lặp đúng từng tuần
    assert revenue["wholesale_per_day"] == 10_000.0
    assert revenue["points"][0]["value"] == 10 * 1_000 + 10_000  # thứ Hai: 10 hộp bán lẻ + bán buôn bình quân

    demand = forecast_demand(sales, as_of)
    assert [(row["store_code"], row["medicine_code"], row["total"]) for row in demand] == [("CH01", "AA", WEEK.sum() + 70)]
    assert demand[0]["metric"] == "wape_total"


@pytest.fixture(scope="module")
def sample():
    path = Path(__file__).resolve().parent.parent / "scripts" / "generate_sample_data.py"
    spec = importlib.util.spec_from_file_location("generate_sample_data", path)
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    rng = random.Random(2026)
    medicines = generator.build_medicines(rng)
    raw = generator.build_sales(rng, 90, date(2026, 10, 30), datetime(2026, 10, 30, 23, 59))
    return prepare_sales(raw.assign(sale_datetime=pd.to_datetime(raw["sale_datetime"])), medicines), pd.Timestamp("2026-10-30 18:00")


def test_sample_chain_revenue_accuracy(sample):
    sales, as_of = sample
    chain = forecast_revenue(sales, as_of)
    assert chain["wape"] < 0.15  # bán lẻ toàn chuỗi sai số dưới 15%
    assert chain["points"][2]["value"] > chain["points"][4]["value"]  # Chủ nhật 01/11 đông hơn thứ Ba 03/11


def test_sample_declining_store_is_overestimated_by_level_1(sample):
    """CH03 đang sụt 35%: mô hình trung bình (Level 1) dự báo cao hơn thật. Holt-Winters (3.5) phải sửa."""
    sales, as_of = sample
    ch03 = forecast_revenue(sales, as_of, "CH03")
    assert all(score["bias"] > 0.1 for score in ch03["scores"].values() if score)
