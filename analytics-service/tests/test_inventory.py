"""Kiểm thử phân tích tồn kho (bước 2.3).

ADS = số lượng bán 30 ngày / 30. Dữ liệu dựng để ADS là số tròn.
"""

from __future__ import annotations

import importlib.util
import random
from datetime import date, datetime
from pathlib import Path

import pandas as pd
import pytest

from app.analytics import inventory_analysis, prepare_sales
from app.analytics.inventory import classify

AS_OF = pd.Timestamp("2026-10-29 12:00")

MEDICINES = pd.DataFrame(
    [
        {"medicine_code": "LOW", "medicine_name": "Sắp hết", "category": "N", "unit": "Viên", "min_stock": 10, "max_stock": 1000},
        {"medicine_code": "MIN", "medicine_name": "Dưới tối thiểu", "category": "N", "unit": "Viên", "min_stock": 500, "max_stock": 5000},
        {"medicine_code": "OK", "medicine_name": "Bình thường", "category": "N", "unit": "Viên", "min_stock": 10, "max_stock": 1000},
        {"medicine_code": "HIGH", "medicine_name": "Tồn cao", "category": "N", "unit": "Viên", "min_stock": 10, "max_stock": 5000},
        {"medicine_code": "MAX", "medicine_name": "Vượt tối đa", "category": "N", "unit": "Viên", "min_stock": 1, "max_stock": 50},
        {"medicine_code": "DEAD", "medicine_name": "Không ai mua", "category": "N", "unit": "Cái", "min_stock": 1, "max_stock": 10},
        {"medicine_code": "OUT", "medicine_name": "Hết hàng", "category": "N", "unit": "Viên", "min_stock": 10, "max_stock": 1000},
        {"medicine_code": "BAD", "medicine_name": "Danh mục gõ nhầm", "category": "N", "unit": "Viên", "min_stock": 999_999, "max_stock": 100},
    ]
)


def sold(code: str, units_30d: float, store: str = "CH01") -> dict:
    """Một dòng bán 10 ngày trước, đủ số lượng 30 ngày cho ADS mong muốn."""
    return {
        "sale_id": f"{store}-{code}",
        "line_no": 1,
        "sale_datetime": AS_OF - pd.Timedelta(days=10),
        "store_code": store,
        "medicine_code": code,
        "quantity": float(units_30d),
        "selling_price": 1_000.0,
        "purchase_price": 600.0,
    }


def lot(code: str, quantity: float, expiry: str = "2027-12-31", price: float | None = 500.0, store: str = "CH01") -> dict:
    return {
        "store_code": store,
        "medicine_code": code,
        "batch_code": f"{code}-{expiry}",
        "quantity": float(quantity),
        "expiry_date": pd.Timestamp(expiry),
        "purchase_price": price,
    }


SALES = prepare_sales(
    pd.DataFrame(
        [
            sold("LOW", 300),  # ADS 10/ngày, tồn 50 → 5 ngày < 7: sắp hết
            sold("MIN", 300),  # ADS 10, tồn 300 → 30 ngày nhưng dưới tối thiểu 500: sắp hết
            sold("OK", 300),  # ADS 10, tồn 300 → 30 ngày: bình thường
            sold("HIGH", 30),  # ADS 1, tồn 200 → 200 ngày > 90: tồn cao
            sold("MAX", 300),  # ADS 10, tồn 100 → 10 ngày nhưng vượt tối đa 50: tồn cao
            sold("OUT", 600),  # ADS 20, không còn lô bán được: hết hàng
            sold("BAD", 300),  # ADS 10, tồn 300: tối thiểu 999.999 > tối đa 100 là gõ nhầm → bỏ, xét 30 ngày: bình thường
            sold("OK", 3_000, store="CH02"),  # CH02 bán rất chạy nhưng không có tồn ở CH02
            {**sold("DEAD", 1), "sale_datetime": AS_OF - pd.Timedelta(days=45)},  # bán lần cuối 45 ngày trước
        ]
    ),
    MEDICINES,
)

INVENTORY = pd.DataFrame(
    [
        lot("LOW", 50),
        lot("MIN", 300),
        lot("OK", 300),
        lot("HIGH", 200),
        lot("MAX", 100),
        lot("DEAD", 4, price=650_000),
        lot("OUT", 80, expiry="2026-10-20"),  # còn hàng nhưng đã hết hạn: không bán được
        lot("BAD", 300),
    ]
)


@pytest.fixture
def ch01():
    analysis = inventory_analysis(SALES, INVENTORY, MEDICINES, AS_OF, "CH01")
    return analysis, {item["medicine_code"]: item for item in analysis["items"]}


@pytest.mark.parametrize(
    ("stock", "ads", "cover", "low", "high", "expected"),
    [
        (0, 5, 0, 10, 100, "out_of_stock"),
        (10, 0, None, 1, 100, "dead"),
        (20, 5, 4, 10, 100, "low"),  # dưới 7 ngày
        (8, 0.1, 80, 10, 100, "low"),  # dưới tối thiểu dù còn 80 ngày
        (8, 0.1, 80, 10, 5, "low"),  # vừa dưới tối thiểu vừa vượt tối đa: sắp hết thắng
        (50, 0.5, 100, 1, 1000, "high"),  # trên 90 ngày
        (50, 10, 5, None, 20, "low"),  # vượt tối đa nhưng chỉ đủ 5 ngày: sắp hết thắng
        (50, 1, 50, None, None, "normal"),  # không có mức tối thiểu/tối đa: chỉ xét số ngày
        (70, 10, 7, None, None, "normal"),  # đúng 7 ngày: chưa "dưới 7"
    ],
)
def test_classify(stock, ads, cover, low, high, expected):
    assert classify(stock, ads, cover, low, high) == expected


def test_each_item_gets_expected_status(ch01):
    _, items = ch01
    assert {code: item["status"] for code, item in items.items()} == {
        "LOW": "low",
        "MIN": "low",
        "OK": "normal",
        "HIGH": "high",
        "MAX": "high",
        "DEAD": "dead",
        "OUT": "out_of_stock",
        "BAD": "normal",
    }


def test_numbers_of_one_item(ch01):
    _, items = ch01
    assert items["LOW"] == {
        "store_code": "CH01",
        "medicine_code": "LOW",
        "medicine_name": "Sắp hết",
        "category": "N",
        "unit": "Viên",
        "status": "low",
        "stock_quantity": 50,
        "stock_value": 25_000,
        "ads": 10,
        "days_of_cover": 5.0,
        "min_stock": 10,
        "max_stock": 1000,
        "last_sale": "2026-10-19",
        "days_since_sale": 10,
    }
    assert items["OUT"]["stock_quantity"] == 0  # lô hết hạn không tính
    assert items["OUT"]["stock_value"] == 0
    assert items["BAD"]["min_stock"] is None  # mức mâu thuẫn đã bị bỏ
    assert items["DEAD"]["days_of_cover"] is None
    assert items["DEAD"]["days_since_sale"] == 45


def test_urgent_items_come_first(ch01):
    analysis, _ = ch01
    statuses = [item["status"] for item in analysis["items"]]
    assert statuses == ["out_of_stock", "low", "low", "dead", "high", "high", "normal", "normal"]
    lows = [item["medicine_code"] for item in analysis["items"] if item["status"] == "low"]
    assert lows == ["LOW", "MIN"]  # hết sớm hơn (5 ngày) đứng trước (30 ngày)


def test_summary_counts_and_values(ch01):
    analysis, _ = ch01
    summary = analysis["summary"]
    assert {status: part["count"] for status, part in summary.items()} == {
        "out_of_stock": 1,
        "low": 2,
        "dead": 1,
        "high": 2,
        "normal": 2,
    }
    assert summary["dead"]["stock_value"] == 2_600_000  # 4 máy × 650.000: vốn đang đọng
    # 50+300+300+200+100+300 = 1.250 viên × 500 + 2.600.000
    assert analysis["total_stock_value"] == 3_225_000
    assert analysis["available"] is True


def test_every_store_is_judged_on_its_own():
    """Toàn chuỗi = mọi cửa hàng, không cộng tồn: CH02 hết OK dù CH01 còn 300."""
    chain = inventory_analysis(SALES, INVENTORY, MEDICINES, AS_OF)
    found = {(item["store_code"], item["medicine_code"]): item["status"] for item in chain["items"]}
    assert found[("CH02", "OK")] == "out_of_stock"
    assert found[("CH01", "OK")] == "normal"
    assert chain["summary"]["out_of_stock"]["count"] == 2


def test_missing_purchase_price_leaves_value_unknown():
    inventory = pd.concat([INVENTORY, pd.DataFrame([lot("OK", 10, expiry="2028-01-31", price=None)])])
    analysis = inventory_analysis(SALES, inventory, MEDICINES, AS_OF, "CH01")
    assert analysis["total_stock_value"] is None
    assert analysis["summary"]["normal"]["stock_value"] is None
    assert analysis["summary"]["dead"]["stock_value"] == 2_600_000  # phần còn lại vẫn biết


def test_without_inventory_file():
    assert inventory_analysis(SALES, None, MEDICINES, AS_OF) == {"store": "ALL", "available": False}


def test_sample_data_stories():
    """Các tình huống cài trong dữ liệu mẫu (bước 2.1) phải được phát hiện đúng."""
    path = Path(__file__).resolve().parent.parent / "scripts" / "generate_sample_data.py"
    spec = importlib.util.spec_from_file_location("generate_sample_data", path)
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    rng = random.Random(7)
    end = date(2026, 10, 30)
    medicines = generator.build_medicines(rng)
    raw_sales = generator.build_sales(rng, 40, end, datetime(2026, 10, 30, 23, 59))
    inventory = generator.build_inventory(random.Random(8), raw_sales, end)
    medicines = generator.set_stock_limits(medicines, raw_sales, end)
    inventory["expiry_date"] = pd.to_datetime(inventory["expiry_date"])
    sales = prepare_sales(raw_sales.assign(sale_datetime=pd.to_datetime(raw_sales["sale_datetime"])), medicines)

    analysis = inventory_analysis(sales, inventory, medicines, pd.Timestamp("2026-10-30 23:00"))
    found = {(item["store_code"], item["medicine_code"]): item["status"] for item in analysis["items"]}
    assert found[("CH02", "GD001")] == "low"
    assert found[("CH01", "TM001")] == "low"
    assert found[("CH03", "VT001")] == "out_of_stock"
    assert found[("CH01", "VT004")] == "high"
    assert all(found[(store, "TB010")] == "dead" for store in ("CH01", "CH02", "CH03"))
    # Ngoài các tình huống cài sẵn, phần lớn là bình thường.
    assert analysis["summary"]["normal"]["count"] > 0.85 * len(analysis["items"])
