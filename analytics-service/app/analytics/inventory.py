"""Phân tích tồn kho (Phase 2, bước 2.3; master prompt §13, quyết định D9).

Cho từng thuốc ở từng cửa hàng:

    Tồn hiện tại   = Σ số lượng các lô còn hạn (stock.sellable_stock)
    ADS            = số lượng bán SALES_LOOKBACK_DAYS ngày gần nhất / SALES_LOOKBACK_DAYS
    Số ngày tồn    = Tồn hiện tại / ADS          (ADS = 0: không tính được)
    Giá trị tồn    = Σ số lượng × giá nhập

Trạng thái, xét theo thứ tự (gặp điều kiện nào trước thì lấy):
    out_of_stock  hết hàng:  tồn = 0 nhưng 30 ngày qua có bán (đang mất doanh thu)
    dead          tồn chết:  còn tồn, 30 ngày không bán cái nào
    low           sắp hết:   tồn < min_stock hoặc số ngày tồn < LOW_STOCK_DAYS
    high          tồn cao:   tồn > max_stock hoặc số ngày tồn > HIGH_STOCK_DAYS
    normal        bình thường

min_stock > max_stock (danh mục gõ nhầm) thì bỏ cả hai mức, chỉ xét số ngày tồn.
"Sắp hết" xét trước "tồn cao": dưới mức tối thiểu chủ nhà thuốc đặt thì phải
nhập, dù tốc độ bán đang chậm. Tồn là hàng nằm ở từng cửa hàng, nên trạng
thái luôn tính theo cửa hàng; xem toàn chuỗi là xem mọi cửa hàng cùng lúc,
không cộng tồn CH01 với CH03 rồi kết luận "đủ hàng".
"""

from __future__ import annotations

import math
from typing import Literal

import pandas as pd

from app.config import HIGH_STOCK_DAYS, LOW_STOCK_DAYS, SALES_LOOKBACK_DAYS

from .periods import Window
from .stock import sellable_stock

Status = Literal["out_of_stock", "dead", "low", "high", "normal"]
STATUSES: tuple[Status, ...] = ("out_of_stock", "low", "dead", "high", "normal")  # thứ tự hiển thị: gấp trước
STATUS_LABELS = {
    "out_of_stock": "Hết hàng",
    "low": "Sắp hết",
    "dead": "Tồn chết",
    "high": "Tồn cao",
    "normal": "Bình thường",
}


def _clean(value, digits: int = 2):
    if value is None or (isinstance(value, float) and math.isnan(value)) or value is pd.NA:
        return None
    return round(float(value), digits)


def classify(stock: float, ads: float, cover: float | None, min_stock: float | None, max_stock: float | None) -> Status:
    """Một thuốc ở một cửa hàng thuộc trạng thái nào (docstring đầu tệp)."""
    if stock <= 0:
        return "out_of_stock"
    if ads <= 0:
        return "dead"
    if (min_stock is not None and stock < min_stock) or (cover is not None and cover < LOW_STOCK_DAYS):
        return "low"
    if (max_stock is not None and stock > max_stock) or (cover is not None and cover > HIGH_STOCK_DAYS):
        return "high"
    return "normal"


def stock_table(
    sales: pd.DataFrame,
    inventory: pd.DataFrame,
    medicines: pd.DataFrame | None,
    as_of: pd.Timestamp,
) -> pd.DataFrame:
    """Bảng (cửa hàng, thuốc): tồn, giá trị, ADS, số ngày tồn, trạng thái.

    Gồm thuốc còn tồn bán được VÀ thuốc 30 ngày qua có bán (để bắt hết hàng).
    """
    lookback = Window(as_of - pd.Timedelta(days=SALES_LOOKBACK_DAYS), as_of)
    recent = sales[lookback.contains(sales["sale_datetime"])]
    sold = recent.groupby(["store_code", "medicine_code"], as_index=False).agg(units_30d=("quantity", "sum"))
    past = sales[sales["sale_datetime"] < as_of]
    last_sale = past.groupby(["store_code", "medicine_code"], as_index=False).agg(last_sale=("sale_datetime", "max"))

    table = sellable_stock(inventory, as_of).merge(sold, on=["store_code", "medicine_code"], how="outer")
    table = table.merge(last_sale, on=["store_code", "medicine_code"], how="left")
    table["stock_quantity"] = table["stock_quantity"].fillna(0.0)
    # Hết hàng thì giá trị tồn là 0, không phải "chưa biết".
    table["stock_value"] = table["stock_value"].astype("float64").where(table["stock_quantity"] > 0, 0.0)
    table["units_30d"] = table["units_30d"].fillna(0.0)
    table["ads"] = table["units_30d"] / SALES_LOOKBACK_DAYS
    table["days_of_cover"] = (table["stock_quantity"] / table["ads"]).where(table["ads"] > 0)

    if medicines is not None and not medicines.empty:
        catalog = medicines[["medicine_code", "medicine_name", "category", "unit", "min_stock", "max_stock"]]
        table = table.merge(catalog.drop_duplicates("medicine_code"), on="medicine_code", how="left")
    else:
        for column in ("medicine_name", "category", "unit", "min_stock", "max_stock"):
            table[column] = None

    # Tối thiểu > tối đa là dữ liệu danh mục sai (Processor đã cảnh báo min_above_max):
    # bỏ cả hai mức, chỉ xét số ngày tồn, để một ô gõ nhầm không sinh cảnh báo giả.
    conflicting = table["min_stock"].astype("float64") > table["max_stock"].astype("float64")
    table.loc[conflicting, ["min_stock", "max_stock"]] = None

    def optional(value):
        return None if value is None or pd.isna(value) else float(value)

    table["status"] = [
        classify(stock, ads, optional(cover), optional(low), optional(high))
        for stock, ads, cover, low, high in zip(
            table["stock_quantity"], table["ads"], table["days_of_cover"], table["min_stock"], table["max_stock"]
        )
    ]
    order = {status: index for index, status in enumerate(STATUSES)}
    table["_order"] = table["status"].map(order)
    # Gấp trước; trong cùng trạng thái, hết sớm nhất trước.
    return table.sort_values(["_order", "days_of_cover", "store_code", "medicine_code"], na_position="last").drop(columns="_order")


def _row(record: dict, as_of: pd.Timestamp) -> dict:
    last = record.get("last_sale")
    return {
        "store_code": record["store_code"],
        "medicine_code": record["medicine_code"],
        "medicine_name": record.get("medicine_name"),
        "category": record.get("category"),
        "unit": record.get("unit"),
        "status": record["status"],
        "stock_quantity": _clean(record["stock_quantity"]),
        "stock_value": _clean(record.get("stock_value")),
        "ads": _clean(record["ads"]),
        "days_of_cover": _clean(record["days_of_cover"], 1),
        "min_stock": _clean(record.get("min_stock")),
        "max_stock": _clean(record.get("max_stock")),
        "last_sale": None if last is None or pd.isna(last) else last.date().isoformat(),
        "days_since_sale": None if last is None or pd.isna(last) else int((as_of - last).days),
    }


def inventory_analysis(
    sales: pd.DataFrame,
    inventory: pd.DataFrame | None,
    medicines: pd.DataFrame | None,
    as_of: pd.Timestamp,
    store_code: str | None = None,
    *,
    stock_as_of: pd.Timestamp | None = None,
) -> dict:
    """Tình trạng tồn kho của một cửa hàng, hoặc mọi cửa hàng (store_code None).

    stock_as_of: lúc tệp tồn kho được lưu. Tồn trong tệp đúng tới lúc đó;
    hàng bán sau đó chưa trừ (quyết định D7).
    """
    if inventory is None or inventory.empty:
        return {"store": store_code or "ALL", "available": False}
    if store_code is not None:
        sales = sales[sales["store_code"] == store_code]
        inventory = inventory[inventory["store_code"] == store_code]
    table = stock_table(sales, inventory, medicines, as_of)

    summary = {}
    for status in STATUSES:
        part = table[table["status"] == status]
        values = part["stock_value"]
        summary[status] = {
            "label": STATUS_LABELS[status],
            "count": int(len(part)),
            # Giá trị chỉ cộng được khi mọi lô có giá nhập; thiếu thì để trống, không đoán.
            "stock_value": _clean(values.sum()) if values.notna().all() else None,
        }
    values = table["stock_value"]
    return {
        "store": store_code or "ALL",
        "available": True,
        "stock_as_of": None if stock_as_of is None else stock_as_of.isoformat(timespec="seconds"),
        "lookback_days": SALES_LOOKBACK_DAYS,
        "thresholds": {"low_days": LOW_STOCK_DAYS, "high_days": HIGH_STOCK_DAYS},
        "total_stock_value": _clean(values.sum()) if values.notna().all() else None,
        "value_known_pct": _clean(values.notna().mean() * 100, 1) if len(values) else None,
        "summary": summary,
        "items": [_row(record, as_of) for record in table.to_dict("records")],
    }
