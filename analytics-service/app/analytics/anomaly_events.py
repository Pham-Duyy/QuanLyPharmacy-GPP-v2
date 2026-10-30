"""Gộp bất thường thành sự kiện (Phase 3, bước 3.3).

1. Gộp bằng chứng: cùng cửa hàng, cùng thuốc, cùng ngày, cùng chiều (tụt/tăng) mà
   cả luật R1 lẫn Z-score cùng phát hiện thì là MỘT bất thường có hai bằng chứng.
2. Gộp thành đợt: các ngày bất thường cùng loại cách nhau ≤ EPISODE_GAP_DAYS ngày
   là một đợt (ví dụ CH03 sụt nhiều ngày liền), báo một lần kèm khoảng ngày.
"""

from __future__ import annotations

import pandas as pd

from app.config import EPISODE_GAP_DAYS

from .anomaly import rule_anomalies
from .anomaly_stats import product_spikes, revenue_z

# Loại sự kiện sau khi gộp: tụt doanh thu ngày đã trọn từ R1 và từ Z-score là cùng một loại.
DIRECTION = {
    "revenue_drop_day": "down",
    "revenue_drop_today": "down",
    "medicine_drop": "down",
    "revenue_spike": "up",
    "medicine_spike": "up",
    "stock_jump": "up",
}
SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def merge_evidence(items: list[dict]) -> list[dict]:
    """Một (loại, cửa hàng, thuốc, ngày) chỉ còn một bản ghi; bằng chứng các phương pháp nối lại."""
    merged: dict[tuple, dict] = {}
    for item in items:
        key = (item["kind"], item["store_code"], item["medicine_code"], item["date"])
        if key not in merged:
            merged[key] = {**item, "evidence": list(item["evidence"])}
            continue
        kept = merged[key]
        kept["evidence"] += item["evidence"]
        # Câu mô tả theo luật dễ đọc hơn; mức nghiêm trọng lấy mức cao hơn.
        if item["evidence"][0]["method"] == "rule":
            kept["message"], kept["expected"], kept["change_pct"] = item["message"], item["expected"], item["change_pct"]
        if SEVERITY_ORDER[item["severity"]] < SEVERITY_ORDER[kept["severity"]]:
            kept["severity"] = item["severity"]
    return list(merged.values())


def group_episodes(items: list[dict]) -> list[dict]:
    """Ngày bất thường cùng loại, cùng nơi, cách nhau ≤ EPISODE_GAP_DAYS ngày gộp thành một đợt."""
    groups: dict[tuple, list[dict]] = {}
    for item in items:
        groups.setdefault((item["kind"], item["store_code"], item["medicine_code"]), []).append(item)
    events = []
    for days in groups.values():
        days.sort(key=lambda item: item["date"])
        current: list[dict] = [days[0]]
        for item in days[1:]:
            gap = (pd.Timestamp(item["date"]) - pd.Timestamp(current[-1]["date"])).days
            if gap <= EPISODE_GAP_DAYS:
                current.append(item)
            else:
                events.append(_episode(current))
                current = [item]
        events.append(_episode(current))
    return sorted(events, key=lambda event: (event["end"], SEVERITY_ORDER[event["severity"]] * -1), reverse=True)


def _episode(days: list[dict]) -> dict:
    """Một đợt: ngày đầu, ngày cuối, ngày nặng nhất (lệch nhiều nhất) làm câu mô tả."""
    worst = max(days, key=lambda item: abs(item["change_pct"] or 0))
    methods = sorted({evidence["method"] for item in days for evidence in item["evidence"]})
    event = {
        **worst,
        "direction": DIRECTION[worst["kind"]],
        "start": days[0]["date"],
        "end": days[-1]["date"],
        "days": [item["date"] for item in days],
        "methods": methods,
        "severity": min((item["severity"] for item in days), key=SEVERITY_ORDER.__getitem__),
    }
    event["short"] = _short(event)
    if len(days) > 1:
        start, end = pd.Timestamp(event["start"]), pd.Timestamp(event["end"])
        event["message"] = (
            f"{worst['message']}. Đợt {len(days)} ngày bất thường từ {start:%d/%m} đến {end:%d/%m}"
        )
    return event


def _short(event: dict) -> str:
    """Nhãn ngắn cho khối Cảnh báo, ví dụ 'CH01 · doanh thu · 20/10 · −79%'."""
    # R2 xét cả một tuần (period_start → ngày ghi nhận): ghi đủ khoảng ngày đó.
    start = pd.Timestamp(event.get("period_start") or event["start"])
    end = pd.Timestamp(event["end"])
    when = f"{start:%d/%m}" if start == end else f"{start:%d/%m}–{end:%d/%m}"
    what = event["medicine_name"] or event["medicine_code"] or "doanh thu"
    where = "Toàn chuỗi" if event["store_code"] == "ALL" else event["store_code"]
    change = event["change_pct"]
    sign = "" if change is None else (f" {'+' if change > 0 else '−'}{abs(change):.0f}%")
    return f"{where} · {what} · {when}{sign}"


def detect_anomalies(
    sales: pd.DataFrame,
    as_of: pd.Timestamp,
    medicines: pd.DataFrame | None = None,
    **stock: object,
) -> list[dict]:
    """Toàn bộ bất thường (luật R1–R3 + Z-score), đã gộp bằng chứng và gộp đợt, mới nhất trước.

    `stock`: current_stock, previous_stock, saved_at, previous_saved_at cho luật R3.
    """
    past = sales[sales["sale_datetime"] < as_of]
    stores = sorted(past["store_code"].dropna().unique().tolist())
    found = rule_anomalies(sales, as_of, medicines, **stock)  # type: ignore[arg-type]
    found += revenue_z(past, as_of, stores)
    found += product_spikes(past, as_of, medicines)
    return group_episodes(merge_evidence(found))
