"""Kiểm thử bất thường Level 2 (Z-score bền vững) và gộp sự kiện (bước 3.3)."""

from __future__ import annotations

import importlib.util
import random
from datetime import date, datetime
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from app.analytics import prepare_sales
from app.analytics.anomaly_events import detect_anomalies, group_episodes, merge_evidence
from app.analytics.anomaly_stats import poisson_sf, product_spikes, revenue_z, robust_z
from tests.test_anomaly import AS_OF, build, sales_of, steady


def test_robust_z_ignores_one_outlier_in_the_sample():
    """Mẫu có sẵn một ngày mất điện (2): trung vị/MAD gần như không đổi, z của 20 vẫn rất lớn."""
    sample = np.array([10, 11, 9, 10, 2, 10, 11, 9], dtype=float)
    assert robust_z(10.0, sample) == pytest.approx(0.0)
    assert robust_z(20.0, sample) == pytest.approx((20 - 10) / (1.4826 * 1.0))
    assert robust_z(10.0, np.array([10.0, 10.0]), floor=0.5) == 0  # MAD = 0: dùng sàn, không chia cho 0
    assert robust_z(1.0, np.array([])) is None


def test_poisson_sf():
    assert poisson_sf(0, 3.0) == 1.0
    assert poisson_sf(1, 3.0) == pytest.approx(1 - np.exp(-3))
    assert poisson_sf(20, 3.9) < 1e-7  # khẩu trang thường 3,9 lần/ngày mà bán 20 lần


# --- Doanh thu ----------------------------------------------------------------------------


def test_revenue_z_finds_outage_and_real_spike_only():
    orders = steady()
    orders[pd.Timestamp("2026-10-20")] = 5  # mất điện
    orders[pd.Timestamp("2026-10-23")] = 34  # thứ Sáu đông bất thường: +70%, nhiều khách hơn hẳn
    found = {(item["kind"], item["date"]) for item in revenue_z(sales_of(build(orders)), AS_OF, ["CH01"]) if item["store_code"] == "CH01"}
    assert found == {("revenue_drop_day", "2026-10-20"), ("revenue_spike", "2026-10-23")}


def test_revenue_z_needs_size_not_only_rarity():
    """Mẫu đều tăm tắp thì +20% cũng ra z rất lớn; dưới 30% không báo."""
    orders = steady()
    orders[pd.Timestamp("2026-10-23")] = 24
    assert revenue_z(sales_of(build(orders)), AS_OF, ["CH01"]) == []


def test_revenue_z_needs_more_customers():
    """Doanh thu +80% nhờ vài đơn giá trị lớn, lượng khách như thường: không phải bất thường."""
    orders = steady()
    del orders[pd.Timestamp("2026-10-23")]
    rich = build({pd.Timestamp("2026-10-23"): 20}, price=180_000.0)
    assert revenue_z(sales_of(build(orders), rich), AS_OF, ["CH01"]) == []


# --- Từng thuốc ---------------------------------------------------------------------------


def test_product_spike_needs_many_more_sales_not_one_big_order():
    base = {day: 3 for day in steady()}
    spike = dict(base)
    spike[pd.Timestamp("2026-10-24")] = 20  # 20 lần bán thay vì 3
    lump = dict(base)
    lump[pd.Timestamp("2026-10-24")] = 4  # 4 lần, nhưng có 1 đơn 300 hộp
    lump_rows = build(lump, code="LUMP", price=10_000.0)
    lump_rows[-1]["quantity"] = 300.0
    sales = sales_of(build(spike, code="MASK", price=1_000.0), lump_rows)
    found = product_spikes(sales, AS_OF)
    assert [(item["medicine_code"], item["date"], item["actual"]) for item in found] == [("MASK", "2026-10-24", 20)]
    assert found[0]["evidence"][0]["method"] == "robust_z"
    assert found[0]["message"] == "CH01: MASK bán 20 ngày 24/10 (20 lần), gấp 6,7 lần mức thường (3/ngày)"


# --- Gộp ----------------------------------------------------------------------------------


def item(kind: str, day: str, method: str, *, store: str = "CH01", change: float = -50.0, severity: str = "medium") -> dict:
    return {
        "kind": kind,
        "severity": severity,
        "store_code": store,
        "medicine_code": None,
        "medicine_name": None,
        "date": day,
        "change_pct": change,
        "expected": 100.0,
        "evidence": [{"method": method}],
        "message": f"{method} {day}",
    }


def test_merge_evidence_keeps_one_record_with_both_methods():
    merged = merge_evidence([item("revenue_drop_day", "2026-10-20", "robust_z"), item("revenue_drop_day", "2026-10-20", "rule")])
    assert len(merged) == 1
    assert [evidence["method"] for evidence in merged[0]["evidence"]] == ["robust_z", "rule"]
    assert merged[0]["message"] == "rule 2026-10-20"  # câu theo luật dễ đọc hơn


def test_group_episodes():
    days = [
        item("revenue_drop_day", "2026-10-20", "rule", change=-40),
        item("revenue_drop_day", "2026-10-21", "rule", change=-60),
        item("revenue_drop_day", "2026-10-23", "rule", change=-35),  # cách 2 ngày: cùng đợt
        item("revenue_drop_day", "2026-10-27", "rule", change=-45),  # cách 4 ngày: đợt mới
        item("revenue_drop_day", "2026-10-21", "rule", store="CH02"),  # cửa hàng khác: riêng
    ]
    events = group_episodes(days)
    found = sorted((event["store_code"], event["start"], event["end"], len(event["days"])) for event in events)
    assert found == [
        ("CH01", "2026-10-20", "2026-10-23", 3),
        ("CH01", "2026-10-27", "2026-10-27", 1),
        ("CH02", "2026-10-21", "2026-10-21", 1),
    ]
    episode = next(event for event in events if event["start"] == "2026-10-20")
    assert episode["change_pct"] == -60  # ngày nặng nhất làm đại diện
    assert episode["message"] == "rule 2026-10-21. Đợt 3 ngày bất thường từ 20/10 đến 23/10"
    assert episode["short"] == "CH01 · doanh thu · 20/10–23/10 −60%"
    assert episode["direction"] == "down"


# --- Dữ liệu mẫu ----------------------------------------------------------------------------


@pytest.mark.parametrize("seed", [2026, 11, 14])
def test_sample_stories(seed):
    path = Path(__file__).resolve().parent.parent / "scripts" / "generate_sample_data.py"
    spec = importlib.util.spec_from_file_location("generate_sample_data", path)
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    rng = random.Random(seed)
    end = date(2026, 10, 30)
    medicines = generator.build_medicines(rng)
    raw = generator.build_sales(rng, 90, end, datetime(2026, 10, 30, 23, 59))
    sales = prepare_sales(raw.assign(sale_datetime=pd.to_datetime(raw["sale_datetime"])), medicines)
    events = detect_anomalies(sales, pd.Timestamp("2026-10-30 18:00"), medicines)

    outside_ch03 = sorted((event["kind"], event["store_code"], event["medicine_code"]) for event in events if event["store_code"] not in ("CH03", "ALL"))
    assert outside_ch03 == [
        ("medicine_drop", "CH02", "KS001"),  # Amoxicillin ngừng bán (R2)
        ("medicine_spike", "CH02", "TB001"),  # khẩu trang tăng vọt (Z-score)
        ("revenue_drop_day", "CH01", None),  # mất điện (R1, thường kèm Z-score)
    ]
    outage = next(event for event in events if event["store_code"] == "CH01")
    assert outage["start"] == "2026-10-20"
