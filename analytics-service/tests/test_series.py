"""Kiểm thử chuỗi theo ngày (bước 3.1) và các bất thường cài trong dữ liệu mẫu."""

from __future__ import annotations

import importlib.util
import random
from datetime import date, datetime
from pathlib import Path

import pandas as pd
import pytest

from app.analytics import history_status, prepare_sales, revenue_series, units_table
from app.analytics.series import intraday_revenue, last_complete_day, same_weekday_history

AS_OF = pd.Timestamp("2026-10-29 15:00")  # thứ Năm


def sale(at: str, revenue: float, store: str = "CH01", code: str = "A", quantity: float = 1.0) -> dict:
    return {
        "sale_id": f"{store}-{at}-{code}",
        "line_no": 1,
        "sale_datetime": pd.Timestamp(at),
        "store_code": store,
        "medicine_code": code,
        "quantity": quantity,
        "selling_price": revenue / quantity,
        "purchase_price": None,
    }


SALES = prepare_sales(
    pd.DataFrame(
        [
            sale("2026-10-20 09:00", 100),
            sale("2026-10-22 10:00", 50),
            sale("2026-10-22 18:00", 70, code="B", quantity=7),
            sale("2026-10-28 20:00", 30),
            sale("2026-10-29 08:00", 999),  # hôm nay: chưa trọn, không vào chuỗi
            sale("2026-10-25 09:00", 40, store="CH02"),  # CH02 mở cửa 25/10
        ]
    ),
    None,
)


def test_revenue_series_fills_gaps_and_stops_yesterday():
    series = revenue_series(SALES, AS_OF, "CH01")
    assert series.index[0] == pd.Timestamp("2026-10-20")  # từ ngày bán đầu tiên
    assert series.index[-1] == pd.Timestamp("2026-10-28") == last_complete_day(AS_OF)
    assert series.to_dict() == {
        pd.Timestamp("2026-10-20"): 100,
        pd.Timestamp("2026-10-21"): 0,
        pd.Timestamp("2026-10-22"): 120,
        pd.Timestamp("2026-10-23"): 0,
        pd.Timestamp("2026-10-24"): 0,
        pd.Timestamp("2026-10-25"): 0,
        pd.Timestamp("2026-10-26"): 0,
        pd.Timestamp("2026-10-27"): 0,
        pd.Timestamp("2026-10-28"): 30,
    }


def test_store_series_starts_at_its_own_first_sale():
    """CH02 mở cửa 25/10: các ngày trước đó không phải "bán được 0"."""
    assert revenue_series(SALES, AS_OF, "CH02").index[0] == pd.Timestamp("2026-10-25")
    chain = revenue_series(SALES, AS_OF)
    assert chain[pd.Timestamp("2026-10-25")] == 40
    assert chain.sum() == 290


def test_units_table_blank_before_first_sale():
    table = units_table(SALES, AS_OF)
    assert table.loc["2026-10-22", ("CH01", "B")] == 7
    assert pd.isna(table.loc["2026-10-21", ("CH01", "B")])  # chưa có thuốc B
    assert table.loc["2026-10-23", ("CH01", "B")] == 0  # có rồi mà không bán: 0
    assert pd.isna(table.loc["2026-10-20", ("CH02", "A")])
    assert table.index[-1] == pd.Timestamp("2026-10-28")


def test_max_days_keeps_series_short():
    assert len(revenue_series(SALES, AS_OF, "CH01", max_days=3)) == 3


def test_intraday_revenue_same_clock_time():
    assert intraday_revenue(SALES, pd.Timestamp("2026-10-22"), pd.Timedelta(hours=15), "CH01") == 50  # 18:00 chưa tới
    assert intraday_revenue(SALES, pd.Timestamp("2026-10-22"), pd.Timedelta(hours=24), "CH01") == 120


def test_history_status():
    assert history_status(revenue_series(SALES, AS_OF, "CH01")) == {
        "ok": False,
        "days": 9,
        "message": "Chưa đủ dữ liệu: mới có 9 ngày bán hàng đã trọn, cần ít nhất 28 ngày (4 tuần).",
    }
    assert history_status(pd.Series([1.0] * 28))["ok"] is True


def test_same_weekday_history():
    series = pd.Series(range(30), index=pd.date_range("2026-10-01", periods=30), dtype="float64")
    # 29/10 là thứ Năm: các thứ Năm trước là 22, 15, 8, 1/10.
    assert list(same_weekday_history(series, pd.Timestamp("2026-10-29"), 8)) == [21, 14, 7, 0]


# --- Bất thường cài trong dữ liệu mẫu ----------------------------------------------------


@pytest.fixture(scope="module")
def sample():
    path = Path(__file__).resolve().parent.parent / "scripts" / "generate_sample_data.py"
    spec = importlib.util.spec_from_file_location("generate_sample_data", path)
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    rng = random.Random(7)
    end = date(2026, 10, 30)
    medicines = generator.build_medicines(rng)
    raw = generator.build_sales(rng, 90, end, datetime(2026, 10, 30, 23, 59))
    sales = prepare_sales(raw.assign(sale_datetime=pd.to_datetime(raw["sale_datetime"])), medicines)
    return sales, pd.Timestamp("2026-10-30 23:00")


def test_sample_outage_day(sample):
    sales, as_of = sample
    series = revenue_series(sales, as_of, "CH01")
    outage = pd.Timestamp("2026-10-20")  # 10 ngày trước ngày cuối
    usual = same_weekday_history(series, outage, 8).median()
    assert series[outage] < 0.55 * usual


def test_sample_mask_spike_and_amoxicillin_stop(sample):
    sales, as_of = sample
    table = units_table(sales, as_of)
    masks = table[("CH02", "TB001")]
    spike = masks.loc["2026-10-24":"2026-10-26"].sum()
    usual = masks.loc["2026-09-01":"2026-10-20"].mean() * 3
    assert spike > 3 * usual
    # Ngừng bán 7 ngày cuối; 6 ngày đã trọn (hôm nay chưa trọn) đều bằng 0, trước đó vẫn bán.
    amoxicillin = table[("CH02", "KS001")]
    assert amoxicillin.loc["2026-10-24":].sum() == 0
    assert amoxicillin.loc["2026-09-24":"2026-10-23"].sum() > 0


def test_sample_has_enough_history(sample):
    sales, as_of = sample
    assert history_status(revenue_series(sales, as_of))["ok"] is True
