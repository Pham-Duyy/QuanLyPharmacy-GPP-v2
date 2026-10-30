"""Chuỗi thời gian và cơ cấu doanh thu cho biểu đồ.

- sales_trend: doanh thu theo ngày/tuần/tháng (biểu đồ đường). Kỳ không có
  giao dịch vẫn có mặt với giá trị 0, để biểu đồ không "nhảy cóc".
- sales_breakdown: doanh thu theo nhóm thuốc, loại bán, cửa hàng, thuốc
  (biểu đồ cột, tròn).
"""

from __future__ import annotations

from typing import Literal

import pandas as pd

from .kpi import compute_kpis
from .periods import Window

Grain = Literal["day", "week", "month"]
Dimension = Literal["category", "sale_type", "store_code", "medicine_code", "payment_method"]

SALE_TYPE_LABELS = {"retail": "Bán lẻ", "wholesale": "Bán buôn"}
PAYMENT_LABELS = {"cash": "Tiền mặt", "transfer": "Chuyển khoản", "card": "Thẻ", "debt": "Công nợ"}


def bucket_start(moments: pd.Series, grain: Grain) -> pd.Series:
    """Đầu kỳ chứa mỗi thời điểm: ngày 00:00, thứ Hai đầu tuần, ngày 1 đầu tháng."""
    days = moments.dt.normalize()
    if grain == "day":
        return days
    if grain == "week":
        return days - pd.to_timedelta(days.dt.day_of_week, unit="D")
    return days - pd.to_timedelta(days.dt.day - 1, unit="D")


def _all_buckets(window: Window, grain: Grain) -> pd.DatetimeIndex:
    first = bucket_start(pd.Series([window.start]), grain).iloc[0]
    last = bucket_start(pd.Series([window.end - pd.Timedelta(microseconds=1)]), grain).iloc[0]
    frequency = {"day": "D", "week": "W-MON", "month": "MS"}[grain]
    return pd.date_range(first, last, freq=frequency)


def sales_trend(frame: pd.DataFrame, window: Window, grain: Grain) -> list[dict]:
    """Mỗi kỳ một điểm: doanh thu, lợi nhuận, số đơn, số lượng."""
    scoped = frame[window.contains(frame["sale_datetime"])]
    keys = bucket_start(scoped["sale_datetime"], grain)
    groups = {key: compute_kpis(group) for key, group in scoped.groupby(keys)}
    points = []
    for bucket in _all_buckets(window, grain):
        kpi = groups.get(bucket)
        points.append(
            {
                "period_start": bucket.date().isoformat(),
                "revenue": kpi.revenue if kpi else 0.0,
                "profit": kpi.profit if kpi else 0.0,
                "orders": kpi.orders if kpi else 0,
                "units": kpi.units if kpi else 0.0,
            }
        )
    return points


def sales_breakdown(frame: pd.DataFrame, window: Window, by: Dimension, limit: int | None = None) -> list[dict]:
    """Doanh thu theo một chiều, xếp từ lớn tới nhỏ, kèm tỷ trọng %."""
    scoped = frame[window.contains(frame["sale_datetime"])]
    total = scoped["revenue"].sum()
    rows = []
    for key, group in scoped.groupby(by, dropna=False):
        kpi = compute_kpis(group)
        label = key
        if by == "sale_type":
            label = SALE_TYPE_LABELS.get(key, key)
        elif by == "payment_method":
            label = PAYMENT_LABELS.get(key, "Khác") if pd.notna(key) else "Không ghi"
        elif by == "medicine_code":
            names = group["medicine_name"].dropna()
            label = names.iloc[0] if len(names) else key
        rows.append(
            {
                "key": None if pd.isna(key) else key,
                "label": label,
                "revenue": kpi.revenue,
                "profit": kpi.profit,
                "margin_pct": kpi.margin_pct,
                "orders": kpi.orders,
                "units": kpi.units,
                "share_pct": round(kpi.revenue / total * 100, 1) if total else None,
            }
        )
    rows.sort(key=lambda row: row["revenue"], reverse=True)
    return rows[:limit] if limit else rows
