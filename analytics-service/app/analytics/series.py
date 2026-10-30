"""Chuỗi theo ngày cho bất thường và dự báo (Phase 3, bước 3.1).

Hai nguyên tắc:
1. Chỉ lấy NGÀY ĐÃ TRỌN (đến hết hôm qua). Hôm nay chưa xong, đưa vào sẽ kéo
   trung bình và dự báo xuống. Riêng "hôm nay đến giờ này" có hàm riêng.
2. Ngày không bán vẫn có mặt với giá trị 0, nhưng chuỗi bắt đầu từ ngày bán
   ĐẦU TIÊN của cửa hàng / thuốc đó: những ngày trước khi mở cửa hàng hay
   trước khi có thuốc không phải "bán được 0", không được tính vào trung bình.
"""

from __future__ import annotations

import pandas as pd

from app.config import MIN_HISTORY_DAYS, SERIES_MAX_DAYS


def last_complete_day(as_of: pd.Timestamp) -> pd.Timestamp:
    """Ngày đã trọn gần nhất: hôm qua."""
    return as_of.normalize() - pd.Timedelta(days=1)


def _daily(frame: pd.DataFrame, column: str, start: pd.Timestamp, end: pd.Timestamp) -> pd.Series:
    """Tổng `column` theo ngày từ start đến end (gồm cả hai), ngày trống = 0."""
    days = pd.date_range(start, end, freq="D")
    if len(days) == 0:
        return pd.Series(dtype="float64")
    totals = frame.groupby(frame["sale_datetime"].dt.normalize())[column].sum()
    return totals.reindex(days, fill_value=0.0).astype("float64").rename_axis("date")


def _complete(frame: pd.DataFrame, as_of: pd.Timestamp) -> pd.DataFrame:
    return frame[frame["sale_datetime"] < as_of.normalize()]


def revenue_series(
    sales: pd.DataFrame, as_of: pd.Timestamp, store_code: str | None = None, *, max_days: int = SERIES_MAX_DAYS
) -> pd.Series:
    """Doanh thu từng ngày đã trọn của một cửa hàng (None = toàn chuỗi)."""
    frame = _complete(sales if store_code is None else sales[sales["store_code"] == store_code], as_of)
    end = last_complete_day(as_of)
    if frame.empty:
        return pd.Series(dtype="float64")
    start = max(frame["sale_datetime"].min().normalize(), end - pd.Timedelta(days=max_days - 1))
    return _daily(frame, "revenue", start, end)


def units_table(sales: pd.DataFrame, as_of: pd.Timestamp, *, max_days: int = SERIES_MAX_DAYS) -> pd.DataFrame:
    """Số lượng bán từng ngày đã trọn: hàng = ngày, cột = (cửa hàng, thuốc).

    Ô trước ngày bán đầu tiên của cặp (cửa hàng, thuốc) để trống (NaN), không phải 0.
    """
    frame = _complete(sales, as_of)
    end = last_complete_day(as_of)
    if frame.empty:
        return pd.DataFrame()
    start = max(frame["sale_datetime"].min().normalize(), end - pd.Timedelta(days=max_days - 1))
    frame = frame[frame["sale_datetime"] >= start].astype({"quantity": "float64"})
    table = frame.pivot_table(
        index=frame["sale_datetime"].dt.normalize(),
        columns=["store_code", "medicine_code"],
        values="quantity",
        aggfunc="sum",
        fill_value=0.0,
    )
    table = table.reindex(pd.date_range(start, end, freq="D"), fill_value=0.0).rename_axis("date")
    first_sale = frame.groupby(["store_code", "medicine_code"])["sale_datetime"].min().dt.normalize()
    for key, first in first_sale.items():
        table.loc[table.index < first, key] = float("nan")
    return table.astype("float64")


def intraday_revenue(sales: pd.DataFrame, day: pd.Timestamp, until: pd.Timedelta, store_code: str | None = None) -> float:
    """Doanh thu của `day` từ 00:00 đến 00:00 + until. Dùng để so "hôm nay đến giờ này" với các ngày trước cùng giờ."""
    frame = sales if store_code is None else sales[sales["store_code"] == store_code]
    start = day.normalize()
    moments = frame["sale_datetime"]
    return float(frame.loc[(moments >= start) & (moments < start + until), "revenue"].sum())


def history_status(series: pd.Series, *, min_days: int = MIN_HISTORY_DAYS) -> dict:
    """Đủ lịch sử để phân tích chưa. Chưa đủ thì kèm câu giải thích, không đoán."""
    days = int(series.notna().sum())
    if days >= min_days:
        return {"ok": True, "days": days}
    return {
        "ok": False,
        "days": days,
        "message": f"Chưa đủ dữ liệu: mới có {days} ngày bán hàng đã trọn, cần ít nhất {min_days} ngày (4 tuần).",
    }


def same_weekday_history(series: pd.Series, day: pd.Timestamp, weeks: int) -> pd.Series:
    """Giá trị của `weeks` cùng thứ TRƯỚC `day` (ví dụ 8 thứ Hai trước một thứ Hai), bỏ ô trống."""
    dates = [day - pd.Timedelta(weeks=week) for week in range(1, weeks + 1)]
    return series.reindex(dates).dropna()
