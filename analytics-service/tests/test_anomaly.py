"""Kiểm thử bất thường theo luật R1–R3 (bước 3.2).

Dữ liệu dựng đều đặn (không ngẫu nhiên) để biết trước đáp án; thêm một kiểm tra
trên dữ liệu mẫu với nhiều hạt giống ngẫu nhiên để đo báo động giả.
"""

from __future__ import annotations

import importlib.util
import math
import random
from datetime import date, datetime
from pathlib import Path

import pandas as pd
import pytest

from app.analytics import prepare_sales
from app.analytics.anomaly import medicine_drops, poisson_cdf, revenue_drops, rule_anomalies, stock_jumps
from app.pipeline import Pipeline
from app.store import AnalyticsStore

AS_OF = pd.Timestamp("2026-10-29 15:00")  # thứ Năm
START = pd.Timestamp("2026-08-01")


def build(days_orders, *, store="CH01", code="A", price=100_000.0, hours=(9, 11, 14, 16, 19), sale_type="retail") -> list[dict]:
    """days_orders: {ngày: số đơn}. Mỗi đơn 1 dòng, rải đều theo các giờ trong `hours`."""
    rows = []
    for day, orders in days_orders.items():
        for index in range(orders):
            hour = hours[index % len(hours)]
            rows.append(
                {
                    "sale_id": f"{store}-{day:%m%d}-{code}-{index}",
                    "line_no": 1,
                    "sale_datetime": day + pd.Timedelta(hours=hour, minutes=index % 50),
                    "sale_type": sale_type,
                    "store_code": store,
                    "medicine_code": code,
                    "quantity": 1.0,
                    "selling_price": price,
                    "purchase_price": None,
                }
            )
    return rows


def steady(orders: int = 20, *, until: pd.Timestamp = AS_OF, start: pd.Timestamp = START) -> dict:
    return {day: orders for day in pd.date_range(start, until.normalize())}


def sales_of(*groups: list[dict]) -> pd.DataFrame:
    frame = prepare_sales(pd.DataFrame([row for group in groups for row in group]), None)
    return frame[frame["sale_datetime"] < AS_OF]


def test_poisson_cdf():
    assert poisson_cdf(0, 2.0) == pytest.approx(math.exp(-2))
    assert poisson_cdf(5, 10.0) == pytest.approx(0.0671, abs=1e-4)  # 10 lần/tuần còn 5: khoảng 7% tuần như vậy
    assert poisson_cdf(2, 18.0) < 1e-5


# --- R1 -------------------------------------------------------------------------------


def test_r1_outage_day_is_found_with_numbers():
    orders = steady()
    orders[pd.Timestamp("2026-10-20")] = 5  # mất điện: 5 đơn thay vì 20
    found = revenue_drops(sales_of(build(orders)), AS_OF, ["CH01"])
    days = [(item["store_code"], item["date"], item["kind"]) for item in found]
    assert ("CH01", "2026-10-20", "revenue_drop_day") in days
    outage = next(item for item in found if item["store_code"] == "CH01")
    assert (outage["actual"], outage["expected"], outage["change_pct"]) == (500_000, 2_000_000, -75.0)
    assert outage["message"].startswith("CH01: doanh thu bán lẻ thứ Ba 20/10 chỉ 500.000 đ, thấp hơn 75%")
    assert outage["evidence"] == [{"method": "rule", "rule": "R1"}]


def test_r1_ignores_cheaper_orders_when_customers_are_normal():
    """Doanh thu tụt 50% nhưng vẫn đủ 20 khách (hôm đó toàn đơn rẻ): không phải sự cố."""
    orders = steady()
    del orders[pd.Timestamp("2026-10-20")]
    cheap = build({pd.Timestamp("2026-10-20"): 20}, price=50_000.0)
    assert revenue_drops(sales_of(build(orders), cheap), AS_OF, ["CH01"]) == []


def test_r1_compares_same_weekday():
    """Chủ nhật luôn đông gấp đôi: thứ Hai bình thường không bị coi là "tụt" so với hôm trước."""
    orders = {day: (40 if day.weekday() == 6 else 20) for day in steady()}
    assert revenue_drops(sales_of(build(orders)), AS_OF, ["CH01"]) == []


def test_r1_today_compares_same_clock_time():
    orders = steady()
    orders[AS_OF.normalize()] = 4  # đơn lúc 9h, 11h, 14h, 16h: tới 15:00 mới 3 đơn; ngày thường tới 15:00 đã 12
    found = [item for item in revenue_drops(sales_of(build(orders)), AS_OF, ["CH01"]) if item["kind"] == "revenue_drop_today"]
    assert [(item["store_code"], item["actual"], item["expected"]) for item in found] == [
        ("ALL", 300_000, 1_200_000),
        ("CH01", 300_000, 1_200_000),
    ]
    assert "đến 15:00" in found[1]["message"]


def test_r1_needs_four_same_weekdays():
    """Cửa hàng mới mở 3 tuần: chưa đủ nền, không kết luận."""
    orders = steady(start=pd.Timestamp("2026-10-08"))
    orders[pd.Timestamp("2026-10-27")] = 2
    assert revenue_drops(sales_of(build(orders)), AS_OF, ["CH01"]) == []


# --- R2 -------------------------------------------------------------------------------


def daily_lines(code: str, per_day: int, *, store: str = "CH01", quiet_from: pd.Timestamp | None = None, quiet: int = 0) -> list[dict]:
    plan = {day: (quiet if quiet_from is not None and day >= quiet_from else per_day) for day in steady()}
    return build(plan, store=store, code=code, price=10_000.0)


def test_r2_stopped_medicine_is_found():
    sales = sales_of(daily_lines("STOP", 3, quiet_from=pd.Timestamp("2026-10-22")), daily_lines("OK", 3))
    found = medicine_drops(sales, AS_OF)
    assert [(item["medicine_code"], item["actual"], item["expected"]) for item in found] == [("STOP", 0, 21)]
    assert found[0]["message"].endswith("hết hàng hay ngừng bán?")
    assert found[0]["evidence"] == [{"method": "rule", "rule": "R2"}]


def test_r2_small_dip_of_a_slow_seller_is_not_reported():
    """Thường 10 lần/tuần (~1,4/ngày), tuần này 5: giảm 50% nhưng 7% số tuần vẫn tự nhiên như vậy."""
    slow = {day: (2 if day.day_of_year % 7 in (0, 2, 4) else 1) for day in steady()}  # 10 lần/tuần
    recent = pd.Timestamp("2026-10-22")
    for day in slow:
        if day >= recent:
            slow[day] = 1 if day.day_of_year % 7 in (0, 2, 4, 6, 1) else 0  # 5 lần/tuần
    assert medicine_drops(sales_of(build(slow, code="SLOW", price=10_000.0), daily_lines("OK", 3)), AS_OF) == []


def test_r2_store_wide_drop_is_left_to_r1():
    """Cả cửa hàng giảm 60% thì mọi thuốc giảm theo: R1 báo cửa hàng, R2 không báo từng thuốc."""
    since = pd.Timestamp("2026-10-22")
    sales = sales_of(
        daily_lines("A", 5, quiet_from=since, quiet=2),
        daily_lines("B", 5, quiet_from=since, quiet=2),
        daily_lines("C", 5, quiet_from=since, quiet=2),
    )
    assert medicine_drops(sales, AS_OF) == []


def test_r2_ignores_wholesale_lumps():
    """Một đơn bán buôn 500 hộp trong tuần nền không được làm "mức thường" cao vọt."""
    lump = build({pd.Timestamp("2026-10-01"): 1}, code="A", price=10_000.0, sale_type="wholesale")
    lump[0]["quantity"] = 500.0
    assert medicine_drops(sales_of(daily_lines("A", 3), lump), AS_OF) == []


# --- R3 -------------------------------------------------------------------------------


def stock(rows: list[tuple[str, str, float]]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=["store_code", "medicine_code", "quantity"])


def test_r3_stock_jump():
    sales = sales_of(daily_lines("A", 1))  # 30 ngày bán 30
    medicines = pd.DataFrame([{"medicine_code": "A", "medicine_name": "Thuốc A", "min_stock": 10}, {"medicine_code": "B", "medicine_name": "Thuốc B", "min_stock": 50}])
    previous = stock([("CH01", "A", 40), ("CH01", "B", 10), ("CH01", "C", 0)])
    current = stock([("CH01", "A", 200), ("CH01", "B", 50), ("CH01", "C", 3)])
    found = stock_jumps(current, previous, sales, AS_OF, medicines, saved_at="2026-10-29T08:00:00", previous_saved_at="2026-10-28T08:00:00")
    # A tăng 160 > 3 × 30: báo. B tăng 40 < min_stock 50: bỏ. C tăng 3, không bán: bỏ vì dưới mức tối thiểu 1? → 3 ≥ 1 nên báo.
    assert [(item["medicine_code"], item["expected"], item["actual"]) for item in found] == [("A", 40, 200), ("C", 0, 3)]
    assert "gấp 5 lần lượng bán 30 ngày (30)" in found[0]["message"]
    assert "không bán được cái nào" in found[1]["message"]
    assert found[0]["evidence"] == [{"method": "rule", "rule": "R3"}]
    assert found[0]["previous_saved_at"] == "2026-10-28T08:00:00"


def test_r3_needs_previous_version():
    sales = sales_of(daily_lines("A", 1))
    assert stock_jumps(stock([("CH01", "A", 999)]), None, sales, AS_OF) == []


def test_pipeline_records_each_inventory_version_once(tmp_path):
    folder = tmp_path / "inbox"
    folder.mkdir()
    pd.DataFrame([{"medicine_code": "TA01", "medicine_name": "Thuốc A", "category": "N", "unit": "Viên"}]).to_excel(folder / "medicines.xlsx", index=False)
    pd.DataFrame(build({pd.Timestamp("2026-10-28"): 2}, code="TA01")).drop(columns=["purchase_price"]).to_excel(folder / "sales.xlsx", index=False)
    # Mã thuốc phải 2–20 ký tự (luật invalid_code của Processor): dùng TA01 thay vì "A".
    lot = {"store_code": "CH01", "medicine_code": "TA01", "batch_code": "L1", "quantity": 10, "expiry_date": datetime(2027, 1, 1)}
    pd.DataFrame([lot, {**lot, "batch_code": "L2", "quantity": 5}]).to_excel(folder / "inventory.xlsx", index=False)
    store = AnalyticsStore(tmp_path / "analytics.db")
    pipeline = Pipeline(folder, store)
    pipeline.run(as_of=AS_OF)
    pipeline.run(as_of=AS_OF, force=True)  # đọc lại cùng nội dung: không ghi thêm
    assert [version["rows"] for version in store.stock_versions(5)] == [[{"store_code": "CH01", "medicine_code": "TA01", "quantity": 15.0}]]

    pd.DataFrame([{**lot, "quantity": 100}]).to_excel(folder / "inventory.xlsx", index=False)
    pipeline.run(as_of=AS_OF + pd.Timedelta(minutes=1))
    versions = store.stock_versions(5)
    assert [version["rows"][0]["quantity"] for version in versions] == [100.0, 15.0]  # mới trước


# --- Dữ liệu mẫu: bắt đúng câu chuyện, không báo giả -----------------------------------


def _generator():
    path = Path(__file__).resolve().parent.parent / "scripts" / "generate_sample_data.py"
    spec = importlib.util.spec_from_file_location("generate_sample_data", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("seed", [2026, 11, 13])
def test_sample_stories_without_false_alarms(seed):
    generator = _generator()
    rng = random.Random(seed)
    end = date(2026, 10, 30)
    medicines = generator.build_medicines(rng)
    raw = generator.build_sales(rng, 90, end, datetime(2026, 10, 30, 23, 59))
    sales = prepare_sales(raw.assign(sale_datetime=pd.to_datetime(raw["sale_datetime"])), medicines)
    found = rule_anomalies(sales, pd.Timestamp("2026-10-30 18:00"), medicines)

    ch01 = [(item["kind"], item["date"]) for item in found if item["store_code"] == "CH01"]
    assert ch01 == [("revenue_drop_day", "2026-10-20")]  # đúng ngày mất điện, không gì khác
    drops = [(item["store_code"], item["medicine_code"]) for item in found if item["kind"] == "medicine_drop"]
    assert drops == [("CH02", "KS001")]  # đúng Amoxicillin ngừng bán, không thuốc nào khác
