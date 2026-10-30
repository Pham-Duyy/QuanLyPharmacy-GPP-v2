"""Kiểm thử hạn dùng 5 mức và FEFO (bước 2.4)."""

from __future__ import annotations

import importlib.util
import random
from datetime import date, datetime
from pathlib import Path

import pandas as pd
import pytest

from app.analytics import expiry_analysis, prepare_sales
from app.analytics.expiry import fefo_plan, level_of

AS_OF = pd.Timestamp("2026-10-29 15:00")
TODAY = pd.Timestamp("2026-10-29")


def sold(code: str, units_30d: float, store: str = "CH01") -> dict:
    return {
        "sale_id": f"{store}-{code}",
        "line_no": 1,
        "sale_datetime": AS_OF - pd.Timedelta(days=3),
        "store_code": store,
        "medicine_code": code,
        "quantity": float(units_30d),
        "selling_price": 1_000.0,
        "purchase_price": 600.0,
    }


def lot(code: str, batch: str, quantity: float, days_left: int, price: float | None = 500.0, store: str = "CH01") -> dict:
    return {
        "store_code": store,
        "medicine_code": code,
        "batch_code": batch,
        "quantity": float(quantity),
        "expiry_date": TODAY + pd.Timedelta(days=days_left),
        "purchase_price": price,
    }


@pytest.mark.parametrize(
    ("days_left", "level"),
    [(-1, "expired"), (0, "critical"), (7, "critical"), (8, "warning"), (30, "warning"), (31, "monitor"), (90, "monitor"), (91, "normal")],
)
def test_five_levels(days_left, level):
    assert level_of(days_left) == level


def test_fefo_example_from_design():
    """ADS 10: lô A 50 còn 7 ngày bán kịp; lô B 200 còn 12 ngày chỉ bán được 70, 130 có nguy cơ."""
    lots = pd.DataFrame(
        [
            {"batch_code": "B", "quantity": 200.0, "days_left": 12},  # cố ý đặt trước: hàm phải tự xếp theo hạn
            {"batch_code": "A", "quantity": 50.0, "days_left": 7},
        ]
    )
    plan = fefo_plan(lots, ads=10.0).set_index("batch_code")
    assert plan.loc["A", "fefo_rank"] == 1
    assert plan.loc["A", "at_risk_quantity"] == 0
    assert plan.loc["B", "fefo_rank"] == 2
    assert plan.loc["B", "sell_start_day"] == 5  # lô A bán hết sau 5 ngày
    assert plan.loc["B", "sellable_before_expiry"] == 70
    assert plan.loc["B", "at_risk_quantity"] == 130


def test_fefo_skips_expired_lots_and_does_not_judge_far_lots():
    lots = pd.DataFrame(
        [
            {"batch_code": "OLD", "quantity": 30.0, "days_left": -3},  # hết hạn: không bán, không chiếm thời gian
            {"batch_code": "NEAR", "quantity": 40.0, "days_left": 2},  # ADS 10 → 2 ngày bán 20, nguy cơ 20
            {"batch_code": "FAR", "quantity": 9_000.0, "days_left": 400},  # quá 90 ngày: không kết luận
        ]
    )
    plan = fefo_plan(lots, ads=10.0).set_index("batch_code")
    assert pd.isna(plan.loc["OLD", "fefo_rank"])
    assert plan.loc["NEAR", "fefo_rank"] == 1
    assert plan.loc["NEAR", "at_risk_quantity"] == 20
    assert pd.isna(plan.loc["FAR", "at_risk_quantity"])


def test_nothing_sold_means_whole_near_lot_is_at_risk():
    plan = fefo_plan(pd.DataFrame([{"batch_code": "X", "quantity": 12.0, "days_left": 20}]), ads=0.0)
    assert plan.iloc[0]["at_risk_quantity"] == 12


SALES = prepare_sales(
    pd.DataFrame([sold("P", 300), sold("S", 300), sold("P", 30, store="CH02")]),  # CH01 bán P, S 10/ngày; CH02 bán P 1/ngày
    None,
)
INVENTORY = pd.DataFrame(
    [
        lot("P", "P-A", 50, 7),  # bán kịp
        lot("P", "P-B", 200, 12, price=1_000),  # 130 nguy cơ = 130.000 đ
        lot("P", "P-C", 500, 300),  # bình thường
        lot("S", "S-OLD", 25, -10, price=2_000),  # đã hết hạn 10 ngày: 50.000 đ
        lot("S", "S-NOW", 20, 0),  # hạn đúng hôm nay: nguy cấp, chưa hết hạn
        lot("S", "S-M", 100, 60),  # theo dõi, bán kịp
        lot("P", "P2", 50, 20, store="CH02"),  # CH02 bán chậm: 20 ngày × 1 = 20, nguy cơ 30
    ]
)


@pytest.fixture
def chain():
    return expiry_analysis(SALES, INVENTORY, None, AS_OF)


def test_level_summary(chain):
    assert {level: (part["lots"], part["quantity"]) for level, part in chain["levels"].items()} == {
        "expired": (1, 25),
        "critical": (2, 70),  # P-A (7 ngày), S-NOW (0 ngày)
        "warning": (2, 250),  # P-B (12), P2 (20)
        "monitor": (1, 100),
        "normal": (1, 500),
    }
    assert chain["levels"]["expired"]["value"] == 50_000


def test_risk_lots_sorted_by_money(chain):
    assert [(row["store_code"], row["batch_code"], row["at_risk_quantity"], row["at_risk_value"]) for row in chain["risk_lots"]] == [
        ("CH01", "P-B", 130, 130_000),
        ("CH02", "P2", 30, 15_000),
        ("CH01", "S-NOW", 20, 10_000),
    ]
    assert chain["at_risk"] == {"lots": 3, "quantity": 180, "value": 155_000}


def test_lot_rows(chain):
    rows = {row["batch_code"]: row for row in chain["lots"]}
    assert "P-C" not in rows  # bình thường chỉ được đếm, không liệt kê
    assert rows["S-NOW"]["level"] == "critical"
    # Hạn đúng hôm nay: còn 0 ngày để bán, cả lô tính là nguy cơ (tính thận trọng, báo sớm hơn báo muộn).
    assert rows["S-NOW"]["at_risk_quantity"] == 20
    assert rows["S-OLD"] == {
        "store_code": "CH01",
        "medicine_code": "S",
        "medicine_name": None,
        "unit": None,
        "batch_code": "S-OLD",
        "expiry_date": "2026-10-19",
        "days_left": -10,
        "level": "expired",
        "quantity": 25,
        "purchase_price": 2_000,
        "value": 50_000,
        "ads": 10,
        "days_to_sell": 2.5,
        "fefo_rank": None,
        "sellable_before_expiry": 0,
        "at_risk_quantity": None,
        "at_risk_value": None,
    }
    # Danh sách xếp theo số ngày còn lại: hết hạn lên đầu.
    assert [row["batch_code"] for row in chain["lots"]] == ["S-OLD", "S-NOW", "P-A", "P-B", "P2", "S-M"]


def test_store_filter_and_missing_inventory():
    ch02 = expiry_analysis(SALES, INVENTORY, None, AS_OF, "CH02")
    assert [row["batch_code"] for row in ch02["risk_lots"]] == ["P2"]
    assert expiry_analysis(SALES, None, None, AS_OF) == {"store": "ALL", "available": False}
    empty = expiry_analysis(SALES, INVENTORY, None, AS_OF, "CH09")
    assert (empty["available"], empty["lots"]) == (True, [])


def test_sample_data_stories():
    """Lô Prospan CH02, Acetylcystein CH03 có nguy cơ; Paracetamol CH01 sắp hết hạn nhưng bán kịp."""
    path = Path(__file__).resolve().parent.parent / "scripts" / "generate_sample_data.py"
    spec = importlib.util.spec_from_file_location("generate_sample_data", path)
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    rng = random.Random(7)
    end = date(2026, 10, 30)
    medicines = generator.build_medicines(rng)
    raw_sales = generator.build_sales(rng, 40, end, datetime(2026, 10, 30, 23, 59))
    inventory = generator.build_inventory(random.Random(8), raw_sales, end)
    inventory["expiry_date"] = pd.to_datetime(inventory["expiry_date"])
    sales = prepare_sales(raw_sales.assign(sale_datetime=pd.to_datetime(raw_sales["sale_datetime"])), medicines)

    analysis = expiry_analysis(sales, inventory, medicines, pd.Timestamp("2026-10-30 18:00"))
    risky = {(row["store_code"], row["medicine_code"]) for row in analysis["risk_lots"]}
    assert {("CH02", "HH001"), ("CH03", "HH002")} <= risky
    assert ("CH01", "GD001") not in risky
    expired = {(row["store_code"], row["medicine_code"]) for row in analysis["lots"] if row["level"] == "expired"}
    assert expired == {("CH01", "KS007"), ("CH03", "TH005")}
