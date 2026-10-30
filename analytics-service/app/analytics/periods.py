"""Khoảng thời gian của các kỳ báo cáo: hôm nay, tuần này, tháng này.

Mọi mốc là giờ Việt Nam "tường" (không gắn múi giờ), cùng kiểu với cột
sale_datetime trong Excel. Khoảng là nửa mở [start, end): gồm start, không gồm end.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import pandas as pd

PeriodName = Literal["day", "week", "month"]

PERIOD_LABELS: dict[PeriodName, tuple[str, str]] = {
    "day": ("Hôm nay", "Hôm qua"),
    "week": ("Tuần này", "Tuần trước"),
    "month": ("Tháng này", "Tháng trước"),
}


@dataclass(frozen=True)
class Window:
    start: pd.Timestamp
    end: pd.Timestamp

    def contains(self, moments: pd.Series) -> pd.Series:
        return (moments >= self.start) & (moments < self.end)

    def to_dict(self) -> dict[str, str]:
        return {"start": self.start.isoformat(), "end": self.end.isoformat()}


@dataclass(frozen=True)
class PeriodWindows:
    name: PeriodName
    # Kỳ hiện tại: từ đầu kỳ tới thời điểm tính.
    current: Window
    # Kỳ trước, cùng độ dài đã trôi qua: dùng để tính tăng trưởng cho công bằng.
    previous_same_span: Window
    # Kỳ trước trọn vẹn: để hiển thị "cả tuần trước bán được bao nhiêu".
    previous_full: Window


def period_start(moment: pd.Timestamp, name: PeriodName) -> pd.Timestamp:
    day = moment.normalize()
    if name == "day":
        return day
    if name == "week":
        return day - pd.Timedelta(days=day.weekday())  # tuần bắt đầu thứ Hai
    return day.replace(day=1)


def _shift_back(moment: pd.Timestamp, name: PeriodName) -> pd.Timestamp:
    """Lùi đúng một kỳ. Tháng: 31/10 lùi về 30/9 (pandas tự kẹp vào ngày cuối tháng)."""
    if name == "day":
        return moment - pd.Timedelta(days=1)
    if name == "week":
        return moment - pd.Timedelta(weeks=1)
    return moment - pd.DateOffset(months=1)


def period_windows(as_of: pd.Timestamp, name: PeriodName) -> PeriodWindows:
    """Ví dụ as_of = thứ Năm 30/10/2026 15:00, name = "week":
    - current:            thứ Hai 27/10 00:00 → 30/10 15:00
    - previous_same_span: thứ Hai 20/10 00:00 → 23/10 15:00
    - previous_full:      thứ Hai 20/10 00:00 → 27/10 00:00
    """
    start = period_start(as_of, name)
    previous_start = _shift_back(start, name)
    elapsed = as_of - start
    same_span_end = previous_start + elapsed
    if name == "month":
        # Tháng trước có thể ngắn hơn (30/9 so với 31/10): không vượt quá hết tháng trước.
        same_span_end = min(same_span_end, start)
    return PeriodWindows(
        name=name,
        current=Window(start, as_of),
        previous_same_span=Window(previous_start, same_span_end),
        previous_full=Window(previous_start, start),
    )
