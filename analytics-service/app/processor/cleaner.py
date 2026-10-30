"""Làm sạch và chuẩn hóa giá trị thô về đúng kiểu.

Cleaner không quyết định dòng nào đúng sai: nó chỉ đổi kiểu và đánh dấu ô
nào "có giá trị nhưng không đọc được" (parse failed) để validator báo lỗi.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import date, datetime

import pandas as pd

from .loader import ROW_COLUMN, is_blank
from .schemas import ColumnSpec, DatasetSchema
from .text import normalize_text

_CURRENCY = re.compile(r"(vnđ|vnd|đồng|đ|₫)", re.IGNORECASE)
_VN_THOUSANDS = re.compile(r"^-?\d{1,3}(\.\d{3})+(,\d+)?$")  # 1.234.567,5
_INTL_THOUSANDS = re.compile(r"^-?\d{1,3}(,\d{3})+(\.\d+)?$")  # 1,234,567.5
_COMMA_DECIMAL = re.compile(r"^-?\d+,\d+$")  # 12,5
_PLAIN = re.compile(r"^-?\d+(\.\d+)?$")  # 1234.5

_DATE_FORMATS = (
    "%d/%m/%Y %H:%M:%S",
    "%d/%m/%Y %H:%M",
    "%d/%m/%Y",
    "%d-%m-%Y %H:%M",
    "%d-%m-%Y",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d",
)

_TRUE = {"y", "yes", "co", "true", "1", "x"}
_FALSE = {"n", "no", "khong", "false", "0"}

# Giá trị trả về khi ô không đọc được; khác None (ô trống) để validator phân biệt.
INVALID = object()


def parse_number(value: object) -> float | None | object:
    """'1.234.567 đ' -> 1234567.0; ô trống -> None; 'abc' -> INVALID.

    Dấu chấm theo sau đúng 3 chữ số được hiểu là phân cách nghìn kiểu Việt Nam,
    nên '1.500' là một nghìn năm trăm (giá thuốc không có lẻ phần nghìn đồng).
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return INVALID
    if isinstance(value, (int, float)):
        return None if isinstance(value, float) and math.isnan(value) else float(value)
    text = _CURRENCY.sub("", str(value)).replace(" ", "").replace(" ", "")
    if text == "":
        return None
    if _VN_THOUSANDS.match(text):
        text = text.replace(".", "").replace(",", ".")
    elif _INTL_THOUSANDS.match(text):
        text = text.replace(",", "")
    elif _COMMA_DECIMAL.match(text):
        text = text.replace(",", ".")
    elif not _PLAIN.match(text):
        return INVALID
    return float(text)


def parse_datetime(value: object) -> pd.Timestamp | None | object:
    """Ô ngày của Excel, số ngày kiểu Excel, hoặc chuỗi dd/mm/yyyy [HH:MM]."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if isinstance(value, pd.Timestamp):
        return None if pd.isna(value) else value
    if isinstance(value, (datetime, date)):
        return pd.Timestamp(value)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        # Ô ngày bị định dạng thành số: Excel đếm ngày từ 30/12/1899.
        if 20_000 <= value <= 80_000:
            return pd.Timestamp("1899-12-30") + pd.to_timedelta(float(value), unit="D")
        return INVALID
    text = str(value).strip()
    if text == "":
        return None
    for fmt in _DATE_FORMATS:
        try:
            return pd.Timestamp(datetime.strptime(text, fmt))
        except ValueError:
            continue
    return INVALID


def parse_bool(value: object) -> bool | None | object:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if isinstance(value, bool):
        return value
    text = normalize_text(value)
    if text == "":
        return None
    if text in _TRUE:
        return True
    if text in _FALSE:
        return False
    return INVALID


def parse_code(value: object) -> str | None:
    """Mã: bỏ khoảng trắng thừa, viết hoa ('th 001 ' -> 'TH 001'). Số 101 đọc thành '101'."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    text = re.sub(r"\s+", " ", str(value)).strip().upper()
    return text or None


def parse_text(value: object) -> str | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text or None


def _choice_parser(column: ColumnSpec):
    lookup = {normalize_text(alias): key for key, aliases in column.choices.items() for alias in aliases}

    def parse(value: object) -> str | None | object:
        if value is None or (isinstance(value, float) and math.isnan(value)):
            return None
        text = normalize_text(value)
        if text == "":
            return None
        return lookup.get(text, INVALID)

    return parse


@dataclass
class CleanResult:
    data: pd.DataFrame
    # Theo từng cột: dòng nào có giá trị nhưng không đọc được.
    invalid: dict[str, pd.Series]
    # Giá trị thô ban đầu, để báo lỗi cho người dùng thấy đúng cái họ đã gõ.
    raw: pd.DataFrame


def clean_dataset(frame: pd.DataFrame, schema: DatasetSchema) -> CleanResult:
    cleaned = pd.DataFrame({ROW_COLUMN: frame[ROW_COLUMN]})
    invalid: dict[str, pd.Series] = {}

    for column in schema.columns:
        # Đưa NaN về None trước để các hàm parse chỉ phải xử lý một kiểu "trống".
        values = frame[column.name].astype(object).where(~is_blank(frame[column.name]), None)
        if column.type in ("int", "number"):
            parsed = values.map(parse_number)
        elif column.type == "datetime":
            parsed = values.map(parse_datetime)
        elif column.type == "bool":
            parsed = values.map(parse_bool)
        elif column.type == "choice":
            parsed = values.map(_choice_parser(column))
        elif column.type == "code":
            parsed = values.map(parse_code)
        else:
            parsed = values.map(parse_text)

        bad = parsed.map(lambda item: item is INVALID)
        invalid[column.name] = bad.astype(bool)
        parsed = parsed.where(~bad, None)

        if column.type in ("int", "number"):
            cleaned[column.name] = pd.to_numeric(parsed, errors="coerce").astype("float64")
        elif column.type == "datetime":
            cleaned[column.name] = pd.to_datetime(parsed, errors="coerce")
        elif column.type == "bool":
            cleaned[column.name] = parsed.astype("boolean")
        else:
            cleaned[column.name] = parsed.astype(object)

    return CleanResult(data=cleaned, invalid=invalid, raw=frame)
