"""Kiểm thử phân loại ABC–XYZ (bước 5.1).

Dữ liệu tự dựng, đáp án tính tay ở chú thích từng dòng.
"""

from __future__ import annotations

import pandas as pd
import pytest

from app.analytics import prepare_sales
from app.analytics.classify import abc_class, classify, service_level, weekly_units, xyz_class

# Thứ Năm. Ngày trọn cuối là 28/10; 12 tuần XYZ: 06/08 00:00 → 29/10 00:00; 90 ngày ABC: 31/07 → 28/10.
AS_OF = pd.Timestamp("2026-10-29 12:00")
WEEK0 = pd.Timestamp("2026-08-06")

MEDICINES = pd.DataFrame(
    [{"medicine_code": code, "medicine_name": f"Thuốc {code}", "category": "Nhóm"} for code in "ABCDEFGH"]
)

_counter = iter(range(1, 1_000_000))


def sale(at, code, quantity, price=1_000, store="CH01", sale_type="retail") -> dict:
    return {
        "sale_id": f"S{next(_counter)}",
        "line_no": 1,
        "sale_datetime": pd.Timestamp(at),
        "sale_type": sale_type,
        "store_code": store,
        "medicine_code": code,
        "quantity": float(quantity),
        "selling_price": float(price),
        "purchase_price": None,
    }


def weekly(code, quantities, price=1_000, store="CH01", first_week=0) -> list[dict]:
    """Một lần bán mỗi tuần (thứ Hai của tuần đó), số lượng theo danh sách."""
    return [
        sale(WEEK0 + pd.Timedelta(days=7 * (first_week + index) + 1), code, quantity, price, store)
        for index, quantity in enumerate(quantities)
        if quantity > 0
    ]


def frame(rows) -> pd.DataFrame:
    return prepare_sales(pd.DataFrame(rows), MEDICINES)


def test_abc_boundaries_keep_the_item_that_crosses_the_threshold():
    assert abc_class(0.0) == "A"
    assert abc_class(0.79) == "A"  # cộng dồn 79% → 85%: vẫn A
    assert abc_class(0.80) == "B"
    assert abc_class(0.949) == "B"
    assert abc_class(0.95) == "C"


def test_xyz_limits_and_service_levels():
    assert [xyz_class(value) for value in (None, 0.0, 0.5, 0.51, 1.0, 1.01)] == [None, "X", "X", "Y", "Y", "Z"]
    assert service_level("A", "X") == 0.98
    assert service_level("C", "Z") == 0.90
    assert service_level("B", None) == service_level("B", "Y")  # chưa xếp XYZ thì dùng cột Y


def test_abc_by_cumulative_revenue_share():
    # Doanh thu 12 tuần: A 50%, B 30%, C 10%, D 6%, E 4% (mỗi tuần như nhau).
    rows = []
    for code, units in (("A", 50), ("B", 30), ("C", 10), ("D", 6), ("E", 4)):
        rows += weekly(code, [units] * 12)
    result = classify(frame(rows), None, MEDICINES, AS_OF)
    by_code = {item["medicine_code"]: item for item in result["items"]}
    # Cộng dồn TRƯỚC: A 0%, B 50%, C 80%, D 90%, E 96%.
    assert [by_code[code]["abc"] for code in "ABCDE"] == ["A", "A", "B", "B", "C"]
    assert [item["medicine_code"] for item in result["items"]] == list("ABCDE")
    assert by_code["C"]["cumulative_pct"] == 90.0
    assert result["summary"]["A"] == {"label": "Nhóm A", "count": 2, "revenue": 960_000, "share_pct": 80.0}  # (50 + 30) × 12 tuần × 1.000
    assert result["summary"]["C"]["count"] == 1
    assert sum(cell["count"] for cell in result["matrix"].values()) == 5
    assert result["window"] == {"start": "2026-07-31", "end": "2026-10-28"}


def test_xyz_from_weekly_retail_units():
    rows = (
        weekly("A", [10] * 12)  # đều: CV 0 → X
        + weekly("B", [5, 15] * 6)  # trung bình 10, độ lệch chuẩn ≈ 5,2 → CV 0,52 → Y
        + weekly("C", [0, 0, 0, 40] * 3)  # tính từ tuần bán đầu (tuần 3): 9 tuần, TB 13,3, độ lệch 20 → CV 1,5 → Z
        + weekly("D", [10, 10], first_week=10)  # mới bán 2 tuần: chưa xếp
    )
    # Đơn sỉ lớn không làm A thành thất thường.
    rows.append(sale(WEEK0 + pd.Timedelta(days=30), "A", 500, sale_type="wholesale"))
    result = classify(frame(rows), None, MEDICINES, AS_OF)
    by_code = {item["medicine_code"]: item for item in result["items"]}
    assert by_code["A"]["xyz"] == "X" and by_code["A"]["cv"] == 0.0
    assert by_code["B"]["xyz"] == "Y" and by_code["B"]["cv"] == pytest.approx(0.52, abs=0.01)
    assert by_code["C"]["xyz"] == "Z" and by_code["C"]["cv"] == pytest.approx(1.5, abs=0.01)
    assert by_code["D"]["xyz"] is None and by_code["D"]["weeks"] == 2
    assert by_code["D"]["cell"] == by_code["D"]["abc"]
    assert result["unclassified_xyz"] == 1


def test_weeks_before_first_sale_are_not_zero_demand():
    # Bán đều từ tuần 4: 8 tuần × 10. Tính cả 4 tuần trước là 0 thì CV ≈ 0,74 (Y); đúng phải là 0 (X).
    weeks = weekly_units(frame(weekly("A", [10] * 8, first_week=4)), AS_OF)
    assert weeks["A"].notna().sum() == 8
    result = classify(frame(weekly("A", [10] * 8, first_week=4)), None, MEDICINES, AS_OF)
    assert result["items"][0]["xyz"] == "X"


def test_stock_without_sales_is_c_and_store_scope():
    rows = weekly("A", [10] * 12, store="CH01") + weekly("B", [10] * 12, store="CH02")
    inventory = pd.DataFrame(
        [
            {"store_code": "CH01", "medicine_code": "F", "quantity": 5},  # còn tồn, không bán
            {"store_code": "CH01", "medicine_code": "G", "quantity": 0},  # hết sạch: không xét
            {"store_code": "CH02", "medicine_code": "H", "quantity": 3},
        ]
    )
    result = classify(frame(rows), inventory, MEDICINES, AS_OF, "CH01")
    assert [(item["medicine_code"], item["abc"], item["sold"], item["xyz"]) for item in result["items"]] == [
        ("A", "A", True, "X"),
        ("F", "C", False, None),
    ]
    chain = classify(frame(rows), inventory, MEDICINES, AS_OF)
    assert sorted(item["medicine_code"] for item in chain["items"]) == ["A", "B", "F", "H"]


def test_sales_outside_the_window_are_ignored():
    rows = weekly("A", [10] * 12) + [sale("2026-05-01 09:00", "B", 1_000), sale("2026-10-29 09:00", "C", 1_000)]
    result = classify(frame(rows), None, MEDICINES, AS_OF)
    # B bán trước 90 ngày, C bán hôm nay (chưa trọn ngày): không có trong danh sách.
    assert [item["medicine_code"] for item in result["items"]] == ["A"]


def test_empty_sales():
    result = classify(frame([sale("2026-01-01", "A", 1)]), None, MEDICINES, AS_OF)
    assert result["items"] == [] and result["total_revenue"] == 0
