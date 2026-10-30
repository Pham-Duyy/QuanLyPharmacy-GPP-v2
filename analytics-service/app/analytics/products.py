"""Phân tích sản phẩm (Phase 2, bước 2.2; master prompt §12).

Theo kỳ (hôm nay / tuần này / tháng này):
- revenue:    top doanh thu
- profit:     top lợi nhuận gộp
- low_profit: biên lợi nhuận thấp nhất (chỉ thuốc có từ LOW_MARGIN_MIN_ORDERS đơn)
- declining:  giảm doanh thu mạnh nhất so với kỳ trước CÙNG ĐỘ DÀI
              (chỉ thuốc kỳ trước có từ DECLINE_MIN_ORDERS đơn)

Theo 30 ngày gần nhất, chỉ xét thuốc còn tồn (có tệp tồn kho) hoặc từng bán
ở phạm vi đó (chưa có tệp tồn kho):
- slow:       có bán nhưng doanh thu 30 ngày thấp nhất
- not_sold:   30 ngày không bán cái nào, kể cả chưa bán bao giờ

"Bán chậm" xếp theo tiền, không theo số lượng: 20 viên và 2 máy đo huyết áp
không so được với nhau. Mọi phép tính là pandas tất định, không gọi LLM.
"""

from __future__ import annotations

import math
from typing import Literal

import pandas as pd

from app.config import DECLINE_MIN_ORDERS, LOW_MARGIN_MIN_ORDERS, PRODUCT_TOP_N, SALES_LOOKBACK_DAYS

from .kpi import growth_pct
from .periods import PERIOD_LABELS, PeriodName, Window, period_windows
from .stock import sellable_stock

PeriodRanking = Literal["revenue", "profit", "low_profit", "declining"]
PERIOD_RANKINGS: tuple[PeriodRanking, ...] = ("revenue", "profit", "low_profit", "declining")
STOCK_RANKINGS = ("slow", "not_sold")

RANKING_LABELS = {
    "revenue": "Doanh thu cao nhất",
    "profit": "Lợi nhuận cao nhất",
    "low_profit": "Biên lợi nhuận thấp nhất",
    "declining": "Giảm doanh thu mạnh nhất",
    "slow": "Bán chậm (30 ngày)",
    "not_sold": "Không bán được trong 30 ngày",
}


def _clean(value: float | None, digits: int = 2) -> float | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    return round(float(value), digits)


def per_medicine(frame: pd.DataFrame) -> pd.DataFrame:
    """Gộp theo thuốc: doanh thu, giá vốn, lợi nhuận, biên, số lượng, số đơn.

    Lợi nhuận và biên chỉ tính trên các dòng có giá vốn, như KPI Engine.
    """
    columns = ["medicine_code", "medicine_name", "category", "revenue", "profit", "margin_pct", "units", "orders"]
    if frame.empty:
        return pd.DataFrame(columns=columns)
    with_cost = frame["cogs"].notna()
    work = frame.assign(
        revenue_with_cost=frame["revenue"].where(with_cost, 0.0),
        cogs_known=frame["cogs"].fillna(0.0),
    )
    grouped = work.groupby("medicine_code", as_index=False).agg(
        medicine_name=("medicine_name", "first"),
        category=("category", "first"),
        revenue=("revenue", "sum"),
        revenue_with_cost=("revenue_with_cost", "sum"),
        cogs=("cogs_known", "sum"),
        units=("quantity", "sum"),
        orders=("sale_id", "nunique"),
    )
    grouped["profit"] = grouped["revenue_with_cost"] - grouped["cogs"]
    grouped["margin_pct"] = (grouped["profit"] / grouped["revenue_with_cost"] * 100).where(grouped["revenue_with_cost"] > 0)
    return grouped[columns]


def _rows(table: pd.DataFrame, fields: tuple[str, ...]) -> list[dict]:
    rows = []
    for record in table.to_dict("records"):
        row = {"medicine_code": record["medicine_code"], "medicine_name": record.get("medicine_name"), "category": record.get("category")}
        for field in fields:
            value = record.get(field)
            row[field] = int(value) if field in ("orders", "previous_orders") and value is not None else _clean(value)
        rows.append(row)
    return rows


def _scope(frame: pd.DataFrame, store_code: str | None) -> pd.DataFrame:
    return frame if store_code is None else frame[frame["store_code"] == store_code]


def period_rankings(
    sales: pd.DataFrame, as_of: pd.Timestamp, period: PeriodName, *, limit: int = PRODUCT_TOP_N
) -> dict:
    """Bốn bảng xếp hạng của một kỳ. `sales` đã qua prepare_sales và đã lọc cửa hàng."""
    windows = period_windows(as_of, period)
    moments = sales["sale_datetime"]
    current = per_medicine(sales[windows.current.contains(moments)])
    previous = per_medicine(sales[windows.previous_same_span.contains(moments)])
    money = ("revenue", "profit", "margin_pct", "units", "orders")

    top_revenue = current.sort_values(["revenue", "medicine_code"], ascending=[False, True]).head(limit)
    top_profit = current.sort_values(["profit", "medicine_code"], ascending=[False, True]).head(limit)
    eligible = current[(current["orders"] >= LOW_MARGIN_MIN_ORDERS) & current["margin_pct"].notna()]
    low_profit = eligible.sort_values(["margin_pct", "medicine_code"]).head(limit)

    # Giảm mạnh: so với kỳ trước cùng độ dài; thuốc kỳ này không bán là giảm 100%.
    base = previous[previous["orders"] >= DECLINE_MIN_ORDERS][["medicine_code", "medicine_name", "category", "revenue", "orders"]]
    compare = base.rename(columns={"revenue": "previous_revenue", "orders": "previous_orders"}).merge(
        current[["medicine_code", "revenue", "orders"]], on="medicine_code", how="left"
    )
    compare[["revenue", "orders"]] = compare[["revenue", "orders"]].fillna(0)
    compare["growth_pct"] = [growth_pct(now, before) for now, before in zip(compare["revenue"], compare["previous_revenue"])]
    declining = compare[compare["growth_pct"] < 0].sort_values(["growth_pct", "medicine_code"]).head(limit)

    label, previous_label = PERIOD_LABELS[period]
    return {
        "period": period,
        "label": label,
        "previous_label": previous_label,
        "current_window": windows.current.to_dict(),
        "previous_window": windows.previous_same_span.to_dict(),
        "products_sold": int(len(current)),
        "revenue": _rows(top_revenue, money),
        "profit": _rows(top_profit, money),
        "low_profit": _rows(low_profit, money),
        "declining": _rows(declining, ("previous_revenue", "revenue", "growth_pct", "previous_orders", "orders")),
    }


def stock_rankings(
    sales: pd.DataFrame,
    inventory: pd.DataFrame | None,
    medicines: pd.DataFrame | None,
    as_of: pd.Timestamp,
    store_code: str | None,
    *,
    limit: int = PRODUCT_TOP_N,
) -> dict:
    """Bán chậm và không bán được trong SALES_LOOKBACK_DAYS ngày.

    Có tệp tồn kho: chỉ xét thuốc còn tồn bán được (đáng lo vì đang đọng vốn).
    Chưa có: xét thuốc từng bán ở phạm vi này (ít nhất biết thuốc nào "im" đi).
    """
    lookback = Window(as_of - pd.Timedelta(days=SALES_LOOKBACK_DAYS), as_of)
    past = sales[sales["sale_datetime"] < as_of]
    recent = per_medicine(past[lookback.contains(past["sale_datetime"])])
    last_sale = past.groupby("medicine_code")["sale_datetime"].max()

    if inventory is not None and not inventory.empty:
        basis = "inventory"
        stock = sellable_stock(_scope(inventory, store_code), as_of)
        candidates = stock.groupby("medicine_code", as_index=False).agg(
            stock_quantity=("stock_quantity", "sum"),
            stock_value=("stock_value", lambda values: values.sum(min_count=len(values))),
        )
        candidates = candidates[candidates["stock_quantity"] > 0]
    else:
        basis = "sales_history"
        candidates = pd.DataFrame({"medicine_code": last_sale.index, "stock_quantity": None, "stock_value": None})

    names = _catalog_names(sales, medicines)
    table = candidates.merge(recent[["medicine_code", "revenue", "units", "orders"]], on="medicine_code", how="left")
    table = table.merge(names, on="medicine_code", how="left")
    table[["revenue", "units", "orders"]] = table[["revenue", "units", "orders"]].fillna(0)
    # reindex thay vì map: map lỗi khi kiểu ngày gặp bảng rỗng (pandas ép về float).
    table["last_sale"] = last_sale.reindex(table["medicine_code"]).to_numpy()
    table["days_since_sale"] = ((as_of - table["last_sale"]).dt.days).astype("Int64")

    sold = table[table["orders"] > 0]
    slow = sold.sort_values(["revenue", "medicine_code"]).head(limit)
    # Chưa bán bao giờ (không có ngày bán) xếp đầu, sau đó lâu nhất trước.
    idle = table[table["orders"] == 0].assign(never=lambda data: data["last_sale"].isna())
    not_sold = idle.sort_values(["never", "days_since_sale", "medicine_code"], ascending=[False, False, True]).head(limit)

    def stock_rows(data: pd.DataFrame, fields: tuple[str, ...]) -> list[dict]:
        rows = _rows(data, ("stock_quantity", "stock_value", *fields))
        for row, record in zip(rows, data.to_dict("records")):
            last = record["last_sale"]
            row["last_sale"] = None if pd.isna(last) else last.date().isoformat()
            row["days_since_sale"] = None if pd.isna(record["days_since_sale"]) else int(record["days_since_sale"])
        return rows

    return {
        "basis": basis,
        "lookback_days": SALES_LOOKBACK_DAYS,
        "window": lookback.to_dict(),
        "slow": stock_rows(slow, ("revenue", "units", "orders")),
        "not_sold": stock_rows(not_sold, ()),
        "not_sold_total": int(len(idle)),
    }


def _catalog_names(sales: pd.DataFrame, medicines: pd.DataFrame | None) -> pd.DataFrame:
    """Tên và nhóm thuốc: ưu tiên danh mục (có cả thuốc chưa bán lần nào)."""
    if medicines is not None and not medicines.empty:
        source = medicines[["medicine_code", "medicine_name", "category"]]
    else:
        source = sales[["medicine_code", "medicine_name", "category"]]
    return source.drop_duplicates("medicine_code")


def product_analysis(
    sales: pd.DataFrame,
    inventory: pd.DataFrame | None,
    medicines: pd.DataFrame | None,
    as_of: pd.Timestamp,
    store_code: str | None = None,
    *,
    limit: int = PRODUCT_TOP_N,
) -> dict:
    """Toàn bộ phân tích sản phẩm cho một phạm vi (None = toàn chuỗi)."""
    scoped = _scope(sales, store_code)
    return {
        "store": store_code or "ALL",
        "periods": {period: period_rankings(scoped, as_of, period, limit=limit) for period in ("day", "week", "month")},
        "stock": stock_rankings(scoped, inventory, medicines, as_of, store_code, limit=limit),
    }
