"""Kiểm thử Data Processor (bước 1.2).

Mỗi test tự tạo tệp nhỏ trong thư mục tạm (tmp_path) để biết trước đáp án,
không phụ thuộc dữ liệu mẫu lớn.
"""

from __future__ import annotations

import importlib.util
import random
from datetime import date, datetime
from pathlib import Path

import pandas as pd
import pytest

from app.processor import MEDICINES, SALES, LoadError, process_file, process_folder
from app.processor.cleaner import INVALID, detect_number_style, parse_bool, parse_datetime, parse_number

NOW = pd.Timestamp("2026-10-30 12:00")

MEDICINE_ROWS = [
    {"medicine_code": "GD001", "medicine_name": "Paracetamol 500mg", "category": "Giảm đau", "unit": "Viên"},
    {"medicine_code": "KS001", "medicine_name": "Amoxicillin 500mg", "category": "Kháng sinh", "unit": "Viên"},
]


def sale(**overrides) -> dict:
    """Một dòng bán hàng hợp lệ; truyền tham số để làm sai từng cột."""
    row = {
        "sale_id": "HD001",
        "line_no": 1,
        "sale_datetime": datetime(2026, 10, 29, 9, 30),
        "sale_type": "retail",
        "store_code": "CH01",
        "medicine_code": "GD001",
        "batch_code": "PA2601",
        "quantity": 10,
        "selling_price": 1_200,
        "purchase_price": 800,
        "customer_id": None,
        "payment_method": "cash",
    }
    row.update(overrides)
    return row


def write_xlsx(path: Path, rows: list[dict]) -> Path:
    pd.DataFrame(rows).to_excel(path, index=False)
    return path


def issues_by_code(result) -> dict[str, list[int | None]]:
    found: dict[str, list[int | None]] = {}
    for issue in result.issues:
        found.setdefault(issue.code, []).append(issue.row)
    return found


# --- Đọc giá trị ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (1200, 1200.0),
        ("1.234.567", 1_234_567.0),
        ("1.234.567,5 đ", 1_234_567.5),
        ("1,234,567.5", 1_234_567.5),
        ("12,5", 12.5),
        ("1.500", 1_500.0),
        ("1.5", 1.5),
        ("-5.000", -5_000.0),
        ("  ", None),
        (None, None),
    ],
)
def test_parse_number(raw, expected):
    assert parse_number(raw) == expected


@pytest.mark.parametrize(
    ("values", "style"),
    [
        (["1.500", "2.250", "1.234.567"], "vn"),  # chỉ có dạng nghìn kiểu Việt Nam
        (["12,5", "1.500"], "vn"),
        (["1289.31", "599.765"], "intl"),  # có ô thập phân rõ ràng: cả cột là thập phân
        (["1,234,567", "800"], "intl"),  # "1,234" một mình mơ hồ (người Việt đọc là 1,234)
        ([1200, None, "800"], "vn"),  # ô số thật của Excel không quyết định gì
    ],
)
def test_detect_number_style_per_column(values, style):
    assert detect_number_style(pd.Series(values, dtype=object)) == style


def test_three_decimal_cost_is_not_read_as_thousands(tmp_path):
    """Lỗi thật gặp khi chạy thử: giá vốn '599.765' trong CSV bị đọc thành 599.765 đồng."""
    path = tmp_path / "sales.csv"
    path.write_text(
        "sale_id,line_no,sale_datetime,sale_type,store_code,medicine_code,quantity,selling_price,purchase_price\n"
        "HD1,1,29/10/2026 10:00,retail,CH01,GD001,2,800.0,599.765\n"
        "HD2,1,29/10/2026 11:00,retail,CH01,GD001,1,1300.0,1289.31\n",
        encoding="utf-8",
    )
    result = process_file(path, SALES, now=NOW)

    assert list(result.data["purchase_price"]) == [599.765, 1289.31]
    assert result.issues == []  # trước khi sửa: cảnh báo "bán dưới giá vốn" sai


def test_parse_number_rejects_text():
    assert parse_number("mười") is INVALID
    assert parse_number(True) is INVALID


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("29/10/2026", "2026-10-29 00:00"),
        ("29/10/2026 08:15", "2026-10-29 08:15"),
        ("2026-10-29 08:15:00", "2026-10-29 08:15"),
        (datetime(2026, 10, 29, 8, 15), "2026-10-29 08:15"),
        (46324, "2026-10-29 00:00"),  # ô ngày bị định dạng thành số kiểu Excel
    ],
)
def test_parse_datetime(raw, expected):
    assert parse_datetime(raw).strftime("%Y-%m-%d %H:%M") == expected


def test_parse_datetime_rejects_impossible_date():
    assert parse_datetime("31/02/2026") is INVALID
    assert parse_datetime("hôm qua") is INVALID


def test_parse_bool():
    assert parse_bool("Có") is True
    assert parse_bool("N") is False
    assert parse_bool("có lẽ") is INVALID


# --- Đọc tệp -----------------------------------------------------------------------


def test_vietnamese_headers_and_empty_rows(tmp_path):
    """Tiêu đề tiếng Việt vẫn đọc được; dòng trống bị bỏ; cột lạ chỉ là cảnh báo."""
    frame = pd.DataFrame(
        [
            {"Mã thuốc": "gd001 ", "Tên thuốc": "Paracetamol", "Nhóm thuốc": "Giảm đau", "Đơn vị tính": "Viên", "Ghi chú": "x"},
            {"Mã thuốc": None, "Tên thuốc": None, "Nhóm thuốc": None, "Đơn vị tính": None, "Ghi chú": None},
        ]
    )
    path = tmp_path / "medicines.xlsx"
    frame.to_excel(path, index=False)

    result = process_file(path, MEDICINES, now=NOW)

    assert result.rows_read == 1
    assert result.data.at[0, "medicine_code"] == "GD001"
    assert issues_by_code(result) == {"unknown_column": [None]}


def test_missing_required_column_stops_processing(tmp_path):
    path = write_xlsx(tmp_path / "sales.xlsx", [{key: value for key, value in sale().items() if key != "quantity"}])
    with pytest.raises(LoadError, match="quantity"):
        process_file(path, SALES, now=NOW)


def test_csv_with_semicolon_bom_and_vietnamese_values(tmp_path):
    path = tmp_path / "sales.csv"
    path.write_text(
        "﻿sale_id;line_no;sale_datetime;sale_type;store_code;medicine_code;quantity;selling_price;payment_method\n"
        "HD9;1;29/10/2026 10:00;Bán lẻ;ch01;GD001;2;1.500;Chuyển khoản\n",
        encoding="utf-8",
    )
    result = process_file(path, SALES, now=NOW)

    row = result.data.iloc[0]
    assert result.rows_valid == 1
    assert (row["sale_type"], row["store_code"], row["selling_price"], row["payment_method"]) == (
        "retail",
        "CH01",
        1500.0,
        "transfer",
    )


def test_unsupported_file_type(tmp_path):
    path = tmp_path / "sales.xls"
    path.write_bytes(b"old excel")
    with pytest.raises(LoadError, match=".xlsx"):
        process_file(path, SALES, now=NOW)


# --- Luật kiểm tra -------------------------------------------------------------------


def test_sales_rules(tmp_path):
    """Mỗi dòng sai một kiểu; lỗi bị loại, cảnh báo vẫn giữ. Dòng Excel = vị trí + 2."""
    rows = [
        sale(),  # dòng 2: hợp lệ
        sale(sale_id="HD002", quantity=0),  # 3: số lượng 0
        sale(sale_id="HD003", selling_price=-1),  # 4: giá âm
        sale(sale_id="HD004", sale_datetime=datetime(2026, 11, 2)),  # 5: tương lai
        sale(sale_id="HD005", medicine_code="ZZ999"),  # 6: thuốc lạ
        sale(sale_id="HD006", sale_type="bán thử"),  # 7: loại bán sai
        sale(),  # 8: trùng dòng 2
        sale(sale_id="HD007", selling_price=500),  # 9: dưới giá vốn -> cảnh báo
        sale(sale_id="HD008", quantity=1.5),  # 10: số lượng lẻ -> cảnh báo
        sale(sale_id="HD009", store_code=None),  # 11: thiếu cửa hàng
        sale(sale_id="HD010", medicine_code="G D/1"),  # 12: mã sai định dạng
    ]
    path = write_xlsx(tmp_path / "sales.xlsx", rows)

    result = process_file(path, SALES, catalog_codes={"GD001", "KS001"}, now=NOW)

    found = issues_by_code(result)
    assert found["non_positive_quantity"] == [3]
    assert found["negative_price"] == [4]
    assert found["future_date"] == [5]
    assert found["unknown_medicine"] == [6, 12]
    assert found["invalid_value"] == [7]
    assert found["duplicate_row"] == [8]
    assert found["below_cost"] == [9]
    assert found["fractional_quantity"] == [10]
    assert found["missing_required"] == [11]
    assert found["invalid_code"] == [12]
    # Giữ: dòng 2 (hợp lệ), 9 và 10 (chỉ cảnh báo).
    assert result.rows_valid == 3
    assert sorted(result.data["_row"]) == [2, 9, 10]
    assert result.rows_rejected == 8


def test_medicine_rules(tmp_path):
    rows = [
        *MEDICINE_ROWS,
        {**MEDICINE_ROWS[0], "medicine_name": "Trùng mã"},
        {"medicine_code": "TM001", "medicine_name": "Amlodipin", "category": "Tim mạch", "unit": "Viên", "min_stock": 50, "max_stock": 10},
        {"medicine_code": "TM002", "medicine_name": "Losartan", "category": "Tim mạch", "unit": "Viên", "min_stock": -1},
    ]
    result = process_file(write_xlsx(tmp_path / "medicines.xlsx", rows), MEDICINES, now=NOW)

    found = issues_by_code(result)
    assert found == {"duplicate_row": [4], "min_above_max": [5], "negative_value": [6]}
    assert list(result.data["medicine_code"]) == ["GD001", "KS001", "TM001"]


def test_process_folder_checks_sales_against_catalog(tmp_path):
    write_xlsx(tmp_path / "medicines.xlsx", MEDICINE_ROWS)
    write_xlsx(tmp_path / "sales.xlsx", [sale(), sale(sale_id="HD2", medicine_code="KS999")])

    results = process_folder(tmp_path, now=NOW)

    assert results["medicines"].rows_valid == 2
    assert issues_by_code(results["sales"]) == {"unknown_medicine": [3]}


# --- Dữ liệu mẫu ---------------------------------------------------------------------


def _generator():
    path = Path(__file__).resolve().parent.parent / "scripts" / "generate_sample_data.py"
    spec = importlib.util.spec_from_file_location("generate_sample_data", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_sample_data_errors_are_all_caught(tmp_path):
    """Dữ liệu mẫu chèn đúng 12 lỗi bán hàng + 2 lỗi danh mục: Processor phải bắt đủ."""
    generator = _generator()
    rng = random.Random(7)
    end = date(2026, 10, 30)
    medicines = generator.build_medicines(rng)
    sales = generator.build_sales(rng, 12, end, datetime(2026, 10, 30, 23, 59))
    sales, medicines = generator.inject_errors(sales, medicines, end)
    medicines.to_excel(tmp_path / "medicines.xlsx", index=False)
    sales.to_excel(tmp_path / "sales.xlsx", index=False)

    results = process_folder(tmp_path, now=pd.Timestamp("2026-10-31"))

    assert results["medicines"].issue_summary() == {"min_above_max": 1, "duplicate_row": 1}
    assert results["sales"].issue_summary() == {
        "missing_required": 2,
        "non_positive_quantity": 2,
        "invalid_value": 2,
        "unknown_medicine": 1,
        "negative_price": 1,
        "future_date": 1,
        "below_cost": 1,
        "invalid_batch": 1,
        "duplicate_row": 1,
    }
    assert results["sales"].rows_rejected == 10
