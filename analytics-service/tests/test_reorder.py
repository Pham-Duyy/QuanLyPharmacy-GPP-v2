"""Kiểm thử gợi ý đặt hàng theo dự báo (bước 5.2).

Dữ liệu tự dựng, đáp án tính tay ở chú thích. Chung: thuốc bán 10/ngày; mặc định chờ hàng 2 ngày,
đủ bán 7 ngày → kỳ P = 9 ngày, nhu cầu P = 90, nhu cầu 7 ngày = 70; ô AX → mức phục vụ 98%, z ≈ 2,0537.
"""

from __future__ import annotations

import math
from statistics import NormalDist

import pandas as pd
import pytest

from app.analytics import prepare_sales
from app.analytics.reorder import reorder_plan
from app.processor.service import process_folder

AS_OF = pd.Timestamp("2026-10-29 12:00")
TODAY = AS_OF.normalize()
Z98 = NormalDist().inv_cdf(0.98)


def medicines(**overrides) -> pd.DataFrame:
    rows = []
    for code in "ABCD":
        row = {
            "medicine_code": code,
            "medicine_name": f"Thuốc {code}",
            "category": "Nhóm",
            "unit": "Viên",
            "min_stock": None,
            "max_stock": None,
            "pack_size": None,
            "lead_time_days": None,
            "supplier": None,
        }
        row.update(overrides.get(code, {}))
        rows.append(row)
    return pd.DataFrame(rows)


def daily_sales(code: str, per_day: float, store: str = "CH01", days: int = 60) -> list[dict]:
    return [
        {
            "sale_id": f"{store}{code}{day}",
            "line_no": 1,
            "sale_datetime": TODAY - pd.Timedelta(days=day) + pd.Timedelta(hours=9),
            "sale_type": "retail",
            "store_code": store,
            "medicine_code": code,
            "quantity": float(per_day),
            "selling_price": 2_000.0,
            "purchase_price": 1_000.0,
        }
        for day in range(1, days + 1)
    ]


def lot(code, quantity, days_left=300, store="CH01", price=1_200.0, supplier="NCC Một", received=30, batch=None):
    return {
        "store_code": store,
        "medicine_code": code,
        "batch_code": batch or f"{code}-{days_left}",
        "quantity": float(quantity),
        "expiry_date": TODAY + pd.Timedelta(days=days_left),
        "purchase_price": price,
        "received_date": TODAY - pd.Timedelta(days=received),
        "supplier": supplier,
    }


def forecast(rows: dict[tuple[str, str], tuple[float, float | None]]) -> dict:
    """Dự báo phẳng: (cửa hàng, thuốc) → (số mỗi ngày, sai số tổng 7 ngày)."""
    return {
        "demand_points": [
            {"store_code": s, "medicine_code": m, "start": "2026-10-29", "values": [rate] * 30}
            for (s, m), (rate, _) in rows.items()
        ],
        "demand": [{"store_code": s, "medicine_code": m, "wape_total": error} for (s, m), (_, error) in rows.items()],
    }


def classes(cells: dict[tuple[str, str], str]) -> dict:
    stores: dict[str, dict] = {}
    for (store, code), cell in cells.items():
        stores.setdefault(store, {"items": []})["items"].append(
            {"medicine_code": code, "abc": cell[0], "xyz": cell[1] if len(cell) > 1 else None}
        )
    return stores


def plan(rows, inventory, meds=None, fc=None, cells=None, stockout=()):
    sales = prepare_sales(pd.DataFrame(rows), meds if meds is not None else medicines())
    return reorder_plan(
        sales,
        pd.DataFrame(inventory) if inventory is not None else None,
        meds if meds is not None else medicines(),
        AS_OF,
        fc,
        list(stockout),
        cells or classes({("CH01", "A"): "AX"}),
    )


def item(result, code, store="CH01"):
    return next(entry for entry in result["ALL"]["items"] if entry["medicine_code"] == code and entry["store_code"] == store)


def test_safety_stock_and_order_from_forecast():
    result = plan(daily_sales("A", 10), [lot("A", 50)], fc=forecast({("CH01", "A"): (10, 0.10)}))
    row = item(result, "A")
    # Tồn an toàn = 2,0537 × 1,25 × 0,10 × 70 × √(9/7) ≈ 20,4; mức cần có 110,4; tồn 50 → đặt 61.
    safety = Z98 * 1.25 * 0.10 * 70 * math.sqrt(9 / 7)
    assert row["safety_stock"] == pytest.approx(safety, abs=0.1)
    assert row["demand_quantity"] == 90.0
    assert row["order_quantity"] == math.ceil(90 + safety - 50) == 61
    assert row["reason"] == "reorder" and row["forecast_method"] == "forecast"
    # Giá nhập lô gần nhất 1.200 đ → 73.200 đ.
    assert (row["unit_cost"], row["order_value"], row["supplier"]) == (1_200.0, 73_200, "NCC Một")
    assert result["ALL"]["order_value"] == 73_200 and result["CH01"]["lines"] == 1


def test_pack_size_rounds_up_and_lead_time_from_catalog():
    meds = medicines(A={"pack_size": 12, "lead_time_days": 5})
    row = item(plan(daily_sales("A", 10), [lot("A", 50)], meds, forecast({("CH01", "A"): (10, 0.10)})), "A")
    # P = 5 + 7 = 12: nhu cầu 120, tồn an toàn ≈ 23,1 → cần 93,1 → 8 hộp × 12 = 96.
    assert (row["lead_time_days"], row["demand_quantity"]) == (5, 120.0)
    assert (row["order_quantity"], row["order_packs"], row["pack_size"]) == (96, 8, 12)


def test_lots_expiring_before_they_sell_do_not_count():
    # Lô 30 viên còn 2 ngày: bán theo FEFO được ~20 trước hạn (10/ngày), ~10 sẽ hết hạn. Lô kia 20 viên.
    inventory = [lot("A", 30, days_left=2), lot("A", 20, days_left=300)]
    row = item(plan(daily_sales("A", 10), inventory, fc=forecast({("CH01", "A"): (10, 0.10)})), "A")
    assert (row["stock_quantity"], row["expiring_quantity"], row["usable_quantity"]) == (50.0, 10.0, 40.0)
    assert row["order_quantity"] == 71  # 110,4 − 40


def test_fallback_without_forecast_and_safety_cap():
    # Không có dự báo: tốc độ bán 30 ngày qua. Cửa sổ tính từ 12:00 nên lần bán 09:00 ngày thứ 30 nằm ngoài:
    # 29 × 10 / 30 ≈ 9,67/ngày → nhu cầu 9 ngày 87. Sai số mặc định 50% → tồn an toàn ≈ 98 > 87: chặn ở 87.
    row = item(plan(daily_sales("A", 10), [lot("A", 50)]), "A")
    assert row["forecast_method"] == "ads" and row["forecast_error"] is None
    assert (row["demand_quantity"], row["safety_stock"]) == (87.0, 87.0)
    assert row["order_quantity"] == 124  # 87 + 87 − 50


def test_reasons_and_urgency_order():
    rows = daily_sales("A", 10) + daily_sales("B", 10) + daily_sales("C", 10) + daily_sales("D", 10)
    meds = medicines(C={"min_stock": 200})
    inventory = [lot("A", 50), lot("C", 150), lot("D", 60)]  # B không còn lô nào: hết hàng
    cells = classes({("CH01", code): "AX" for code in "ABCD"})
    fc = forecast({("CH01", code): (10, 0.10) for code in "ABCD"})
    stockout = [{"store_code": "CH01", "medicine_code": "D", "stockout_date": "2026-10-30", "days_until_stockout": 2}]
    result = plan(rows, inventory, meds, fc, cells, stockout)
    reasons = {entry["medicine_code"]: entry["reason"] for entry in result["ALL"]["items"]}
    assert reasons == {"A": "reorder", "B": "out_of_stock", "C": "below_min", "D": "stockout_before_arrival"}
    # Gấp nhất trước: hết hàng, hết trước khi hàng về, dưới tối thiểu, bổ sung.
    assert [entry["medicine_code"] for entry in result["ALL"]["items"]] == ["B", "D", "C", "A"]
    assert result["ALL"]["by_reason"]["out_of_stock"]["lines"] == 1
    # B hết sạch ở CH01: giá nhập, nhà cung cấp lấy theo lô gần nhất của B ở cả chuỗi (không có) → giá vốn trong tệp bán.
    assert item(result, "B")["unit_cost"] == 1_000.0


def test_class_c_cap_max_stock_and_nothing_to_order():
    rows = daily_sales("A", 10) + daily_sales("B", 10) + daily_sales("C", 10)
    meds = medicines(A={"lead_time_days": 30}, B={"max_stock": 60})
    cells = classes({("CH01", "A"): "CZ", ("CH01", "B"): "AX", ("CH01", "C"): "AX"})
    fc = forecast({("CH01", code): (10, 0.10) for code in "ABC"})
    result = plan(rows, [lot("A", 0.0 + 10), lot("B", 10), lot("C", 500)], meds, fc, cells)
    # A nhóm C chờ 30 ngày: P = 37, nhu cầu 370 + an toàn > 30 ngày bán (300) → mức cần có 300, đặt 290.
    assert item(result, "A")["target_quantity"] == 300.0 and item(result, "A")["order_quantity"] == 290
    # B có tồn tối đa 60: đặt tới 60.
    assert item(result, "B")["order_quantity"] == 50
    # C còn 500 > 110: không đặt.
    assert all(entry["medicine_code"] != "C" for entry in result["ALL"]["items"])


def test_catalog_supplier_first_then_chain_lots():
    rows = daily_sales("A", 10) + daily_sales("A", 10, store="CH02") + daily_sales("B", 10)
    meds = medicines(B={"supplier": "NCC Danh mục"})
    inventory = [lot("A", 5, store="CH02", supplier="NCC Hai", price=900.0), lot("B", 5, supplier="NCC Lô")]
    cells = classes({("CH01", "A"): "AX", ("CH01", "B"): "AX", ("CH02", "A"): "AX"})
    result = plan(rows, inventory, meds, None, cells)
    # A hết ở CH01: lấy lô gần nhất của A ở cả chuỗi (CH02).
    assert (item(result, "A")["supplier"], item(result, "A")["unit_cost"]) == ("NCC Hai", 900.0)
    # B: danh mục ghi nhà cung cấp thì dùng danh mục.
    assert item(result, "B")["supplier"] == "NCC Danh mục"
    assert [entry["supplier"] for entry in result["ALL"]["by_supplier"]] == ["NCC Hai", "NCC Danh mục"]
    assert set(result) == {"ALL", "CH01", "CH02"}
    assert {entry["store_code"] for entry in result["CH02"]["items"]} == {"CH02"}


def test_no_inventory_file():
    assert plan(daily_sales("A", 10), None) == {"ALL": {"available": False, "items": []}}


def test_catalog_warnings_for_new_columns(tmp_path):
    pd.DataFrame(
        [
            {"Mã thuốc": "A1", "Tên thuốc": "A", "Nhóm": "N", "ĐVT": "Viên", "Quy cách": 0, "Thời gian chờ": 3},
            {"Mã thuốc": "B1", "Tên thuốc": "B", "Nhóm": "N", "ĐVT": "Viên", "Quy cách": 10, "Thời gian chờ": 90},
        ]
    ).to_csv(tmp_path / "medicines.csv", index=False)
    pd.DataFrame(
        [
            {
                "sale_id": "S1", "line_no": 1, "sale_datetime": "2026-10-01 09:00", "sale_type": "retail",
                "store_code": "CH01", "medicine_code": "A1", "quantity": 1, "selling_price": 1000,
            }
        ]
    ).to_csv(tmp_path / "sales.csv", index=False)
    result = process_folder(tmp_path, now=AS_OF)["medicines"]
    assert result.rows_valid == 2  # chỉ cảnh báo, không loại dòng
    assert sorted(issue.code for issue in result.issues) == ["invalid_pack_size", "lead_time_out_of_range"]
    assert result.data.set_index("medicine_code").at["B1", "pack_size"] == 10
