"""Kiểm tra dữ liệu đã làm sạch theo luật nghiệp vụ nhà thuốc.

Mỗi luật là một phép so sánh trên cả cột (vectorized: pandas xử lý cả cột một
lần thay vì vòng lặp từng dòng), nên 100.000 dòng vẫn kiểm tra trong chớp mắt.
Dòng phạm luật mức "error" bị loại; mức "warning" vẫn giữ.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import pandas as pd

from .cleaner import CleanResult
from .issues import DataIssue, Severity
from .loader import ROW_COLUMN
from .schemas import DatasetSchema

# Mã thuốc, mã cửa hàng: chữ hoa, số, gạch ngang, gạch dưới, chấm; 2–20 ký tự.
CODE_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9._-]{1,19}$")
# Số lô in trên vỏ hộp đa dạng hơn: cho phép thêm "/" và dài tới 30 ký tự.
BATCH_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9./_-]{1,29}$")
EARLIEST_SALE = pd.Timestamp("2000-01-01")


@dataclass
class ValidationResult:
    valid: pd.DataFrame
    issues: list[DataIssue]
    rejected_rows: int


class _Collector:
    """Gom lỗi và đánh dấu dòng bị loại."""

    def __init__(self, result: CleanResult, schema: DatasetSchema):
        self.data = result.data
        self.raw = result.raw
        self.invalid = result.invalid
        self.schema = schema
        self.issues: list[DataIssue] = []
        self.rejected = pd.Series(False, index=self.data.index)

    def flag(self, mask: pd.Series, column: str | None, code: str, severity: Severity, message: str) -> None:
        mask = mask.fillna(False).astype(bool)
        if not mask.any():
            return
        if severity == "error":
            self.rejected |= mask
        for index in self.data.index[mask]:
            value = self.raw.at[index, column] if column in self.raw.columns else None
            if value is not None and pd.isna(value):
                value = None
            self.issues.append(
                DataIssue(self.schema.name, int(self.data.at[index, ROW_COLUMN]), column, code, severity, message, value)
            )


def _common_rules(check: _Collector) -> None:
    """Luật chung: bắt buộc phải có, phải đọc được, mã đúng định dạng, không trùng khóa."""
    data = check.data
    for column in check.schema.columns:
        bad = check.invalid[column.name]
        check.flag(
            bad,
            column.name,
            "invalid_value",
            "error" if column.required else "warning",
            f"Không đọc được giá trị của {column.name} ({column.description})",
        )
        if column.required:
            check.flag(data[column.name].isna() & ~bad, column.name, "missing_required", "error", f"Thiếu {column.description}")

    for name in ("medicine_code", "store_code"):
        if name in data.columns:
            present = data[name].notna()
            wrong = present & ~data[name].astype(str).str.fullmatch(CODE_PATTERN.pattern)
            check.flag(wrong, name, "invalid_code", "error", "Mã sai định dạng (chữ, số, - _ . ; 2–20 ký tự)")

    key = list(check.schema.key)
    complete = data[key].notna().all(axis=1)
    duplicated = complete & data[key].duplicated(keep="first")
    check.flag(duplicated, key[0], "duplicate_row", "error", f"Trùng {' + '.join(key)} với một dòng phía trên (nhập trùng)")


def _medicine_rules(check: _Collector) -> None:
    data = check.data
    for name in ("min_stock", "max_stock"):
        check.flag(data[name] < 0, name, "negative_value", "error", "Tồn kho tối thiểu/tối đa không được âm")
    check.flag(data["min_stock"] > data["max_stock"], "min_stock", "min_above_max", "warning", "Tồn tối thiểu lớn hơn tồn tối đa")


def _sales_rules(check: _Collector, catalog_codes: set[str] | None, now: pd.Timestamp) -> None:
    data = check.data
    check.flag(data["quantity"] <= 0, "quantity", "non_positive_quantity", "error", "Số lượng phải lớn hơn 0 (hàng trả lại ghi ở phiếu trả)")
    check.flag(
        (data["quantity"] > 0) & (data["quantity"] % 1 != 0),
        "quantity",
        "fractional_quantity",
        "warning",
        "Số lượng có phần lẻ: kiểm tra lại đơn vị tính",
    )
    check.flag(data["selling_price"] < 0, "selling_price", "negative_price", "error", "Giá bán không được âm")
    check.flag(data["selling_price"] == 0, "selling_price", "zero_price", "warning", "Giá bán bằng 0 (hàng tặng?)")
    check.flag(data["purchase_price"] < 0, "purchase_price", "negative_price", "error", "Giá vốn không được âm")
    check.flag(
        (data["selling_price"] > 0) & (data["selling_price"] < data["purchase_price"]),
        "selling_price",
        "below_cost",
        "warning",
        "Bán dưới giá vốn",
    )
    check.flag(data["line_no"] < 1, "line_no", "invalid_line_no", "error", "Số thứ tự dòng phải từ 1")

    check.flag(data["sale_datetime"] > now, "sale_datetime", "future_date", "error", "Ngày bán ở tương lai")
    check.flag(data["sale_datetime"] < EARLIEST_SALE, "sale_datetime", "date_too_old", "error", "Ngày bán trước năm 2000")

    batch = data["batch_code"]
    wrong_batch = batch.notna() & ~batch.astype(str).str.fullmatch(BATCH_PATTERN.pattern)
    check.flag(wrong_batch, "batch_code", "invalid_batch", "warning", "Số lô có ký tự lạ hoặc quá dài")

    if catalog_codes is not None:
        unknown = data["medicine_code"].notna() & ~data["medicine_code"].isin(catalog_codes)
        check.flag(unknown, "medicine_code", "unknown_medicine", "error", "Mã thuốc không có trong danh mục medicines")


def validate_dataset(
    result: CleanResult,
    schema: DatasetSchema,
    *,
    catalog_codes: set[str] | None = None,
    now: pd.Timestamp,
) -> ValidationResult:
    check = _Collector(result, schema)
    _common_rules(check)
    if schema.name == "medicines":
        _medicine_rules(check)
    elif schema.name == "sales":
        _sales_rules(check, catalog_codes, now)

    valid = result.data[~check.rejected].reset_index(drop=True)
    # Sắp lỗi theo dòng để báo cáo dễ đọc; lỗi mức tệp (row=None) lên đầu.
    issues = sorted(check.issues, key=lambda issue: (issue.row or 0, issue.column or ""))
    return ValidationResult(valid=valid, issues=issues, rejected_rows=int(check.rejected.sum()))
