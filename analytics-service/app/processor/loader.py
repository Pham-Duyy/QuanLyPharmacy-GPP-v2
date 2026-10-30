"""Đọc tệp Excel/CSV thành DataFrame với tên cột chuẩn.

Loader chỉ lo "đọc cho đúng": tìm sheet, đổi tiêu đề về tên chuẩn theo
schema, giữ nguyên giá trị thô. Việc đổi kiểu và kiểm tra để cho cleaner và
validator.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from .issues import DataIssue
from .schemas import DatasetSchema
from .text import normalize_text

SUPPORTED_SUFFIXES = {".xlsx", ".csv"}

try:  # calamine (viết bằng Rust) đọc .xlsx nhanh hơn openpyxl khoảng 7 lần
    import python_calamine  # noqa: F401

    EXCEL_ENGINE = "calamine"
except ImportError:
    EXCEL_ENGINE = "openpyxl"

# Cột "số dòng Excel" thêm vào để báo lỗi đúng vị trí người dùng nhìn thấy.
ROW_COLUMN = "_row"


class LoadError(Exception):
    """Tệp không đọc được (hỏng, sai định dạng, thiếu cột bắt buộc)."""


def _read_raw(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        raise LoadError(f"Chỉ nhận .xlsx hoặc .csv, không nhận {suffix or 'tệp không đuôi'}")
    try:
        if suffix == ".csv":
            # sep=None: tự nhận dấu phẩy hay chấm phẩy; utf-8-sig bỏ BOM của Excel.
            return pd.read_csv(path, dtype=str, sep=None, engine="python", encoding="utf-8-sig", keep_default_na=False)
        # dtype=object giữ nguyên kiểu ô Excel: số là số, ngày là datetime, chữ là chữ.
        return pd.read_excel(path, sheet_name=0, dtype=object, engine=EXCEL_ENGINE)
    except FileNotFoundError:
        raise
    except Exception as error:  # openpyxl/pandas ném nhiều loại lỗi khác nhau khi tệp hỏng
        raise LoadError(f"Không đọc được {path.name}: {error}") from error


def load_dataset(path: Path, schema: DatasetSchema) -> tuple[pd.DataFrame, list[DataIssue]]:
    """Đọc tệp, trả về (bảng có tên cột chuẩn + cột _row, danh sách lỗi mức tệp).

    Thiếu cột bắt buộc thì ném LoadError: không có cột đó thì không phân tích được gì.
    """
    raw = _read_raw(Path(path))
    issues: list[DataIssue] = []

    # Mỗi cột trong tệp được khớp với cột chuẩn qua tên chuẩn hoặc alias.
    lookup: dict[str, str] = {}
    for column in schema.columns:
        for name in (column.name, *column.aliases):
            lookup[normalize_text(name)] = column.name

    rename: dict[str, str] = {}
    for header in raw.columns:
        target = lookup.get(normalize_text(header))
        if target is None:
            if not str(header).startswith("Unnamed"):
                issues.append(
                    DataIssue(schema.name, None, str(header), "unknown_column", "warning", "Cột không có trong schema, bỏ qua", header)
                )
            continue
        if target in rename.values():
            issues.append(
                DataIssue(schema.name, None, str(header), "duplicate_column", "warning", f"Cột trùng nghĩa với {target}, bỏ qua", header)
            )
            continue
        rename[header] = target

    missing = [column.name for column in schema.columns if column.required and column.name not in rename.values()]
    if missing:
        raise LoadError(f"{Path(path).name} thiếu cột bắt buộc: {', '.join(missing)}")

    frame = raw[list(rename)].rename(columns=rename)
    # Cột tùy chọn không có trong tệp: thêm vào với giá trị trống cho các bước sau đơn giản.
    for column in schema.columns:
        if column.name not in frame.columns:
            frame[column.name] = None
    frame = frame[[column.name for column in schema.columns]]

    # Dòng 1 trong Excel là tiêu đề, nên dòng dữ liệu đầu tiên là dòng 2.
    frame.insert(0, ROW_COLUMN, range(2, len(frame) + 2))
    # Bỏ dòng trống hoàn toàn (Excel hay để lại dòng định dạng ở cuối).
    values = frame.drop(columns=ROW_COLUMN)
    empty = pd.concat([is_blank(values[name]) for name in values.columns], axis=1).all(axis=1)
    return frame[~empty].reset_index(drop=True), issues


def frame_to_dataset(frame: pd.DataFrame, schema: DatasetSchema) -> pd.DataFrame:
    """Bảng đọc từ nguồn khác tệp (PostgreSQL, bước 5.5) đã có tên cột chuẩn: đưa về đúng dạng
    load_dataset trả ra (đủ cột theo schema, cột _row), để làm sạch và kiểm tra như tệp.

    Số dạng Decimal của PostgreSQL đổi sang float; dòng đánh số từ 1 (dòng thứ mấy trong view).
    """
    from decimal import Decimal

    frame = frame.copy()
    for column in schema.columns:
        if column.name not in frame.columns:
            frame[column.name] = None
        elif frame[column.name].map(lambda value: isinstance(value, Decimal)).any():
            frame[column.name] = frame[column.name].map(lambda value: float(value) if isinstance(value, Decimal) else value)
    frame = frame[[column.name for column in schema.columns]]
    frame.insert(0, ROW_COLUMN, range(1, len(frame) + 1))
    return frame.reset_index(drop=True)


def is_blank(series: pd.Series) -> pd.Series:
    """Ô trống: không có giá trị hoặc chỉ có khoảng trắng."""
    return series.isna() | series.astype(str).str.strip().eq("")
