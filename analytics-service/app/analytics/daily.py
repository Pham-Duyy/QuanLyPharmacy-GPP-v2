"""Gộp chỉ số theo ngày (bảng kpi_daily) thành chuỗi theo ngày/tuần/tháng.

Đọc từ kpi_daily thay vì tính lại từ tệp: API trả lời mọi khoảng thời gian,
mọi cửa hàng mà không phải đọc tệp Excel.
"""

from __future__ import annotations

from datetime import date, timedelta

import pandas as pd

from .breakdown import Grain, bucket_start


def align_start(start: date, grain: Grain) -> date:
    """Lùi về đầu kỳ (thứ Hai, ngày 1): kỳ đầu tiên trên biểu đồ luôn đủ ngày,
    không bị thấp giả vì chỉ có vài ngày cuối kỳ."""
    return bucket_start(pd.Series([pd.Timestamp(start)]), grain).iloc[0].date()


def trend_from_daily(rows: list[dict], grain: Grain, start: date, end: date, as_of: date | None = None) -> list[dict]:
    """rows: [{date, revenue, cogs, profit, orders, units}] theo ngày.
    Trả mỗi kỳ trong [start, end] một điểm; kỳ không bán gì vẫn có, giá trị 0.
    Biên lợi nhuận tính lại từ tổng của kỳ, không lấy trung bình các ngày.
    partial=True: kỳ chứa ngày as_of, chưa kết thúc (Dashboard vẽ khác đi cho khỏi hiểu nhầm là sụt).
    """
    columns = ["revenue", "cogs", "profit", "orders", "units"]
    frame = pd.DataFrame(rows, columns=["date", *columns])
    frame["date"] = pd.to_datetime(frame["date"])
    frame["bucket"] = bucket_start(frame["date"], grain)
    totals = frame.groupby("bucket")[columns].sum()

    first = bucket_start(pd.Series([pd.Timestamp(start)]), grain).iloc[0]
    frequency = {"day": "D", "week": "W-MON", "month": "MS"}[grain]
    points = []
    current = bucket_start(pd.Series([pd.Timestamp(as_of)]), grain).iloc[0] if as_of else None
    for bucket in pd.date_range(first, pd.Timestamp(end), freq=frequency):
        row = totals.loc[bucket] if bucket in totals.index else None
        revenue = float(row["revenue"]) if row is not None else 0.0
        profit = float(row["profit"]) if row is not None else 0.0
        cogs = float(row["cogs"]) if row is not None else 0.0
        points.append(
            {
                "period_start": bucket.date().isoformat(),
                "revenue": round(revenue, 2),
                "cogs": round(cogs, 2),
                "profit": round(profit, 2),
                # Doanh thu có giá vốn = lợi nhuận + giá vốn: biên tính đúng cả khi thiếu giá vốn.
                "margin_pct": round(profit / (profit + cogs) * 100, 2) if profit + cogs else None,
                "orders": int(row["orders"]) if row is not None else 0,
                "units": round(float(row["units"]), 2) if row is not None else 0.0,
                "partial": current is not None and bucket == current,
            }
        )
    return points


def default_range(grain: Grain, today: date) -> tuple[date, date]:
    """Khoảng mặc định vừa một biểu đồ: 30 ngày, 12 tuần, 12 tháng gần nhất."""
    if grain == "day":
        return today - timedelta(days=29), today
    if grain == "week":
        return today - timedelta(weeks=11), today
    first_of_month = today.replace(day=1)
    return (pd.Timestamp(first_of_month) - pd.DateOffset(months=11)).date(), today
