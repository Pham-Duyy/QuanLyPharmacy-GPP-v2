"""Phân loại ABC–XYZ (Phase 5, bước 5.1; quyết định D20).

ABC: thuốc nào đem lại phần lớn doanh thu. Xếp thuốc theo doanh thu ABC_DAYS ngày gần nhất,
cộng dồn tỷ trọng: tới 80% là A, tới 95% là B, còn lại C. Thuốc có tồn mà không bán là C.

XYZ: nhu cầu đều hay thất thường. Hệ số biến thiên CV = độ lệch chuẩn / trung bình của số
lượng bán lẻ mỗi tuần (XYZ_WEEKS tuần trọn gần nhất). Bán buôn không tính: một đơn sỉ lớn làm
tuần đó vọt lên nhưng không nói gì về nhu cầu hằng ngày ở quầy. Tuần trước lần bán đầu tiên
không tính (giống series.py); ít hơn XYZ_MIN_WEEKS tuần thì chưa xếp.

Ma trận 9 ô quyết định mức phục vụ khi tính tồn an toàn (bước 5.2): hàng A ổn định cần hầu
như không bao giờ hết; hàng C thất thường giữ ít tồn để khỏi đọng vốn, hết hạn.
Mọi phép tính là pandas tất định, không gọi LLM.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from app.config import ABC_DAYS, ABC_SHARES, SERVICE_LEVELS, XYZ_LIMITS, XYZ_MIN_WEEKS, XYZ_WEEKS

from .series import last_complete_day

ABC_LABELS = {"A": "Nhóm A", "B": "Nhóm B", "C": "Nhóm C"}
XYZ_LABELS = {"X": "Ổn định", "Y": "Dao động", "Z": "Thất thường"}


def abc_class(cumulative_before: float) -> str:
    """Nhóm theo tỷ trọng cộng dồn TRƯỚC thuốc này: thuốc làm vượt ngưỡng vẫn thuộc nhóm trên."""
    if cumulative_before < ABC_SHARES[0]:
        return "A"
    if cumulative_before < ABC_SHARES[1]:
        return "B"
    return "C"


def xyz_class(cv: float | None) -> str | None:
    if cv is None:
        return None
    if cv <= XYZ_LIMITS[0]:
        return "X"
    if cv <= XYZ_LIMITS[1]:
        return "Y"
    return "Z"


def service_level(abc: str, xyz: str | None) -> float:
    return SERVICE_LEVELS[f"{abc}{xyz or 'Y'}"]


def weekly_units(sales: pd.DataFrame, as_of: pd.Timestamp) -> pd.DataFrame:
    """Số lượng bán lẻ mỗi tuần trọn: hàng = tuần (kết thúc hôm qua, lùi 7 ngày một), cột = thuốc.

    Ô trước tuần có lần bán đầu tiên của thuốc để trống (NaN).
    """
    end = last_complete_day(as_of) + pd.Timedelta(days=1)  # nửa đêm hôm nay
    start = end - pd.Timedelta(days=7 * XYZ_WEEKS)
    retail = sales[(sales["sale_type"] == "retail") & (sales["sale_datetime"] >= start) & (sales["sale_datetime"] < end)]
    if retail.empty:
        return pd.DataFrame()
    week = ((retail["sale_datetime"] - start).dt.days // 7).astype(int)
    table = (
        retail.assign(week=week, quantity=retail["quantity"].astype("float64"))
        .pivot_table(index="week", columns="medicine_code", values="quantity", aggfunc="sum", fill_value=0.0)
        .reindex(range(XYZ_WEEKS), fill_value=0.0)
    )
    first = retail.groupby("medicine_code")["sale_datetime"].min()
    first_week = ((first - start).dt.days // 7).astype(int)
    weeks = np.arange(XYZ_WEEKS)[:, None]
    return table.where(weeks >= first_week.reindex(table.columns).to_numpy()[None, :])


def variability(weekly: pd.DataFrame) -> pd.DataFrame:
    """Trung bình, CV, số tuần có dữ liệu cho từng thuốc."""
    if weekly.empty:
        return pd.DataFrame(columns=["weekly_mean", "cv", "weeks"])
    weeks = weekly.notna().sum()
    mean = weekly.mean()
    std = weekly.std(ddof=1)
    cv = (std / mean).where((weeks >= XYZ_MIN_WEEKS) & (mean > 0))
    return pd.DataFrame({"weekly_mean": mean, "cv": cv, "weeks": weeks})


def _round(value: float | None, digits: int = 2) -> float | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    return round(float(value), digits)


def classify(
    sales: pd.DataFrame,
    inventory: pd.DataFrame | None,
    medicines: pd.DataFrame | None,
    as_of: pd.Timestamp,
    store_code: str | None = None,
) -> dict:
    """Phân loại ABC–XYZ cho một cửa hàng (None = toàn chuỗi).

    Danh sách gồm thuốc có bán trong ABC_DAYS ngày và thuốc còn tồn ở phạm vi đó.
    """
    end = last_complete_day(as_of) + pd.Timedelta(days=1)
    start = end - pd.Timedelta(days=ABC_DAYS)
    scoped = sales if store_code is None else sales[sales["store_code"] == store_code]
    window = scoped[(scoped["sale_datetime"] >= start) & (scoped["sale_datetime"] < end)]
    revenue = window.groupby("medicine_code")["revenue"].sum()

    codes = set(revenue.index)
    if inventory is not None and not inventory.empty:
        stock = inventory if store_code is None else inventory[inventory["store_code"] == store_code]
        codes |= set(stock.loc[stock["quantity"] > 0, "medicine_code"])
    revenue = revenue.reindex(sorted(codes), fill_value=0.0).sort_values(ascending=False, kind="stable")
    total = float(revenue.sum())
    share = revenue / total if total > 0 else revenue * 0.0
    before = share.cumsum() - share
    stats = variability(weekly_units(scoped, as_of)).reindex(revenue.index)

    names = medicines.set_index("medicine_code") if medicines is not None else None
    items = []
    for code, value in revenue.items():
        abc = abc_class(float(before[code])) if value > 0 else "C"
        cv = _round(stats.at[code, "cv"]) if code in stats.index else None
        xyz = xyz_class(cv)
        items.append(
            {
                "medicine_code": code,
                "medicine_name": None if names is None or code not in names.index else names.at[code, "medicine_name"],
                "category": None if names is None or code not in names.index else names.at[code, "category"],
                "revenue": round(float(value)),
                "share_pct": round(float(share[code]) * 100, 2),
                "cumulative_pct": round(float(before[code] + share[code]) * 100, 2),
                "abc": abc,
                "weekly_mean": _round(stats.at[code, "weekly_mean"], 1),
                "cv": cv,
                "weeks": int(stats.at[code, "weeks"]) if not math.isnan(stats.at[code, "weeks"]) else 0,
                "xyz": xyz,
                "cell": f"{abc}{xyz}" if xyz else abc,
                "service_level": service_level(abc, xyz),
                "sold": bool(value > 0),
            }
        )

    summary = {}
    for group in ("A", "B", "C"):
        part = [item for item in items if item["abc"] == group]
        group_revenue = sum(item["revenue"] for item in part)
        summary[group] = {
            "label": ABC_LABELS[group],
            "count": len(part),
            "revenue": group_revenue,
            "share_pct": round(group_revenue / total * 100, 1) if total > 0 else 0.0,
        }
    matrix = {
        f"{abc}{xyz}": {
            "count": sum(1 for item in items if item["abc"] == abc and item["xyz"] == xyz),
            "revenue": sum(item["revenue"] for item in items if item["abc"] == abc and item["xyz"] == xyz),
            "service_level": SERVICE_LEVELS[f"{abc}{xyz}"],
        }
        for abc in ("A", "B", "C")
        for xyz in ("X", "Y", "Z")
    }
    return {
        "store": store_code or "ALL",
        "window": {"start": start.date().isoformat(), "end": (end - pd.Timedelta(days=1)).date().isoformat()},
        "weeks": XYZ_WEEKS,
        "thresholds": {"abc_shares": list(ABC_SHARES), "xyz_limits": list(XYZ_LIMITS)},
        "total_revenue": round(total),
        "summary": summary,
        "matrix": matrix,
        "unclassified_xyz": sum(1 for item in items if item["xyz"] is None),
        "items": items,
    }
