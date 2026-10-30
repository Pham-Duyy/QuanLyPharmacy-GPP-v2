"""Kiểm thử phân tích sản phẩm (bước 2.2).

Dữ liệu tự dựng, đáp án tính tay ở chú thích từng dòng.
"""

from __future__ import annotations

import importlib.util
import random
from datetime import date, datetime
from pathlib import Path

import pandas as pd
import pytest

from app.analytics import prepare_sales, sellable_stock
from app.analytics.products import per_medicine, product_analysis

AS_OF = pd.Timestamp("2026-10-29 12:00")  # thứ Năm; tuần này từ thứ Hai 26/10

MEDICINES = pd.DataFrame(
    [
        {"medicine_code": "A", "medicine_name": "Thuốc A", "category": "Nhóm 1"},
        {"medicine_code": "B", "medicine_name": "Thuốc B", "category": "Nhóm 1"},
        {"medicine_code": "C", "medicine_name": "Thuốc C", "category": "Nhóm 2"},
        {"medicine_code": "D", "medicine_name": "Thuốc D", "category": "Nhóm 2"},
        {"medicine_code": "E", "medicine_name": "Thuốc E (chưa bán bao giờ)", "category": "Nhóm 2"},
    ]
)


def sale(sale_id, at, code, quantity, price, cost, store="CH01") -> dict:
    return {
        "sale_id": sale_id,
        "line_no": 1,
        "sale_datetime": pd.Timestamp(at),
        "store_code": store,
        "medicine_code": code,
        "quantity": float(quantity),
        "selling_price": float(price),
        "purchase_price": None if cost is None else float(cost),
    }


def build_sales() -> pd.DataFrame:
    rows = []
    # Tuần này (26–29/10): A 3 đơn × 10 × 1.000 = 30.000, giá vốn 600 → lợi nhuận 12.000, biên 40%.
    for day in (26, 27, 28):
        rows.append(sale(f"A{day}", f"2026-10-{day} 09:00", "A", 10, 1_000, 600))
    # B 4 đơn × 5 × 2.000 = 40.000, giá vốn 1.900 → lợi nhuận 2.000, biên 5%: doanh thu cao nhất, biên thấp nhất.
    for day in (26, 27, 28, 29):
        rows.append(sale(f"B{day}", f"2026-10-{day} 10:00", "B", 5, 2_000, 1_900))
    # C 1 đơn, không có giá vốn: không xét biên (chưa đủ 3 đơn) và lợi nhuận tính 0.
    rows.append(sale("C29", "2026-10-29 08:00", "C", 2, 5_000, None))
    # Tuần trước cùng độ dài (19/10 00:00 → 22/10 12:00): C 6 đơn × 2 × 5.000 = 60.000.
    for index, day in enumerate((19, 19, 20, 20, 21, 22)):
        rows.append(sale(f"C-prev{index}", f"2026-10-{day} 09:00", "C", 2, 5_000, 3_000))
    # D: tuần trước 5 đơn = 5.000; tuần này không bán → giảm 100%.
    for index, day in enumerate((19, 20, 20, 21, 21)):
        rows.append(sale(f"D-prev{index}", f"2026-10-{day} 11:00", "D", 1, 1_000, 500))
    # A tuần trước chỉ 2 đơn: dưới ngưỡng 5 đơn nên không vào danh sách giảm.
    rows.append(sale("A-prev1", "2026-10-19 09:00", "A", 50, 1_000, 600))
    rows.append(sale("A-prev2", "2026-10-20 09:00", "A", 50, 1_000, 600))
    # D bán lần cuối 22/10 (7 ngày trước); hóa đơn 22/10 ngoài cửa sổ tuần trước cùng độ dài (sau 12:00).
    rows.append(sale("D-last", "2026-10-22 15:00", "D", 1, 1_000, 500))
    # Cửa hàng khác: không được lẫn vào CH01.
    rows.append(sale("X1", "2026-10-28 09:00", "A", 100, 1_000, 600, store="CH02"))
    return prepare_sales(pd.DataFrame(rows), MEDICINES)


def lot(code, quantity, expiry, price=500.0, store="CH01") -> dict:
    return {
        "store_code": store,
        "medicine_code": code,
        "batch_code": f"{code}-{expiry}",
        "quantity": float(quantity),
        "expiry_date": pd.Timestamp(expiry),
        "purchase_price": price,
    }


INVENTORY = pd.DataFrame(
    [
        lot("A", 100, "2027-06-30"),
        lot("B", 40, "2027-06-30", price=1_900),
        lot("D", 30, "2027-01-31"),
        lot("D", 10, "2026-10-01"),  # đã hết hạn: không tính vào tồn
        lot("E", 8, "2027-12-31", price=10_000),  # có tồn, chưa bán bao giờ
        lot("C", 5, "2026-10-28"),  # chỉ có lô đã hết hạn hôm qua: C không còn tồn bán được
        lot("A", 999, "2027-06-30", store="CH02"),
    ]
)


@pytest.fixture
def analysis():
    return product_analysis(build_sales(), INVENTORY, MEDICINES, AS_OF, "CH01")


def codes(rows: list[dict]) -> list[str]:
    return [row["medicine_code"] for row in rows]


def test_top_revenue_and_profit(analysis):
    week = analysis["periods"]["week"]
    assert codes(week["revenue"]) == ["B", "A", "C"]
    assert week["revenue"][0] == {
        "medicine_code": "B",
        "medicine_name": "Thuốc B",
        "category": "Nhóm 1",
        "revenue": 40_000,
        "profit": 2_000,
        "margin_pct": 5.0,
        "units": 20,
        "orders": 4,
    }
    assert codes(week["profit"]) == ["A", "B", "C"]
    assert week["profit"][0]["profit"] == 12_000
    assert week["products_sold"] == 3


def test_low_margin_needs_enough_orders_and_known_cost(analysis):
    week = analysis["periods"]["week"]
    # C chỉ 1 đơn và không có giá vốn: không đủ căn cứ để nói biên thấp.
    assert [(row["medicine_code"], row["margin_pct"]) for row in week["low_profit"]] == [("B", 5.0), ("A", 40.0)]


def test_declining_compares_same_span_and_ignores_small_bases(analysis):
    week = analysis["periods"]["week"]
    assert [(row["medicine_code"], row["previous_revenue"], row["revenue"], row["growth_pct"]) for row in week["declining"]] == [
        ("D", 5_000, 0, -100.0),  # không bán tuần này
        ("C", 60_000, 10_000, -83.3),  # tăng trưởng làm tròn 1 chữ số như thẻ KPI
    ]
    assert week["previous_window"] == {"start": "2026-10-19T00:00:00", "end": "2026-10-22T12:00:00"}


def test_slow_and_not_sold_use_sellable_stock(analysis):
    stock = analysis["stock"]
    assert stock["basis"] == "inventory"
    # Còn tồn và có bán trong 30 ngày, doanh thu thấp trước: D 6.000 < B 40.000 < A 130.000. C hết tồn bán được.
    assert codes(stock["slow"]) == ["D", "B", "A"]
    assert stock["slow"][0]["stock_quantity"] == 30  # lô hết hạn 01/10 không tính
    assert stock["slow"][0]["last_sale"] == "2026-10-22"
    assert stock["not_sold"] == [
        {
            "medicine_code": "E",
            "medicine_name": "Thuốc E (chưa bán bao giờ)",
            "category": "Nhóm 2",
            "stock_quantity": 8,
            "stock_value": 80_000,
            "last_sale": None,
            "days_since_sale": None,
        }
    ]


def test_long_idle_product_is_listed_with_days_since_sale():
    sales = build_sales()
    old = prepare_sales(pd.DataFrame([sale("OLD", "2026-09-10 09:00", "E", 1, 1_000, 500)]), MEDICINES)
    stock = product_analysis(pd.concat([sales, old]), INVENTORY, MEDICINES, AS_OF, "CH01")["stock"]
    assert [(row["medicine_code"], row["last_sale"], row["days_since_sale"]) for row in stock["not_sold"]] == [
        ("E", "2026-09-10", 49)
    ]


def test_chain_scope_adds_up_stores():
    chain = product_analysis(build_sales(), INVENTORY, MEDICINES, AS_OF)
    week = chain["periods"]["week"]
    assert chain["store"] == "ALL"
    assert codes(week["revenue"])[0] == "A"  # 30.000 ở CH01 + 100.000 ở CH02
    assert week["revenue"][0]["revenue"] == 130_000
    a_stock = next(row for row in chain["stock"]["slow"] if row["medicine_code"] == "A")
    assert a_stock["stock_quantity"] == 1_099


def test_without_inventory_file_uses_sales_history():
    stock = product_analysis(build_sales(), None, MEDICINES, AS_OF, "CH01")["stock"]
    assert stock["basis"] == "sales_history"
    assert set(codes(stock["slow"])) == {"A", "B", "C", "D"}
    assert stock["not_sold"] == []  # E chưa bán bao giờ: không có căn cứ để biết cửa hàng có bán thuốc này
    assert stock["slow"][0]["stock_quantity"] is None


def test_sellable_stock_keeps_lot_expiring_today_and_flags_missing_price():
    inventory = pd.DataFrame(
        [
            lot("A", 10, "2026-10-29"),  # hạn đúng hôm nay: vẫn bán được
            lot("A", 5, "2026-10-28"),  # hết hạn hôm qua
            lot("B", 3, "2027-01-01", price=None),
        ]
    )
    stock = sellable_stock(inventory, AS_OF).set_index("medicine_code")
    assert stock.loc["A", "stock_quantity"] == 10
    assert stock.loc["A", "stock_value"] == 5_000
    assert pd.isna(stock.loc["B", "stock_value"])  # thiếu giá nhập: không đoán là 0


def test_profit_ignores_lines_without_cost():
    frame = prepare_sales(
        pd.DataFrame([sale("1", "2026-10-29 08:00", "A", 1, 1_000, 600), sale("2", "2026-10-29 09:00", "A", 1, 1_000, None)]),
        MEDICINES,
    )
    row = per_medicine(frame).iloc[0]
    assert (row["revenue"], row["profit"], row["margin_pct"]) == (2_000, 400, 40.0)


def test_sample_data_dead_stock_is_found():
    """Máy xông TB010 trong dữ liệu mẫu có tồn ở cả ba cửa hàng mà không ai mua."""
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

    for store in ("CH01", "CH02", "CH03"):
        stock = product_analysis(sales, inventory, medicines, pd.Timestamp("2026-10-30 23:00"), store)["stock"]
        assert "TB010" in codes(stock["not_sold"]), store
