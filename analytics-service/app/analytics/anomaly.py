"""Phát hiện bất thường, Level 1: luật (Phase 3, bước 3.2; master prompt §16, quyết định D10, D13).

R1  Doanh thu giảm > R1_DROP_PCT % so với trung bình R1_WEEKS cùng thứ trước.
    - Hôm nay: so "từ 0 giờ đến giờ này" với các cùng thứ trước CÙNG GIỜ.
    - ANOMALY_LOOKBACK_DAYS ngày đã trọn gần nhất: so cả ngày.
    Mức nền phải có từ R1_MIN_ORDERS đơn (cùng giờ): sáng sớm vài đơn thì % vô nghĩa.
    Số đơn cũng phải thấp tới mức ngẫu nhiên khó gây ra (Poisson < R1_MAX_P): sự cố thật
    luôn đi kèm ít khách hơn hẳn; chỉ doanh thu thấp thì có thể chỉ là hôm đó ít đơn giá trị lớn.
    So DOANH THU BÁN LẺ: một đơn bán buôn (10 máy đo huyết áp = 8 triệu) bằng cả ngày bán lẻ,
    rơi vào tuần nền là "trung bình" đội lên và ngày bình thường trông như tụt. Doanh thu
    tổng vẫn hiện đủ trên thẻ KPI; bất thường đo nhịp bán hằng ngày của khách lẻ.

R2  Số lượng bán R2_RECENT_DAYS ngày gần nhất của một thuốc ở một cửa hàng giảm
    > R2_DROP_PCT % so với trung bình một tuần của R2_BASE_DAYS ngày trước đó.
    Chỉ xét thuốc đã bán từ đầu khoảng nền và trung bình có từ R2_MIN_WEEKLY_LINES dòng bán/tuần.
    Thêm điều kiện chống báo giả: số LẦN bán 7 ngày qua thấp tới mức dao động ngẫu nhiên
    khó gây ra (xác suất Poisson < R2_MAX_P), so với mức kỳ vọng đã điều chỉnh theo mức
    chung của cửa hàng. Không có điều kiện này, ~180 cặp (cửa hàng, thuốc) bán lẻ tẻ sinh
    hàng chục báo động giả mỗi tuần, và cửa hàng đang sụt (R1 đã báo) kéo theo mọi thuốc.
    Chỉ tính BÁN LẺ: một đơn bán buôn (số lượng gấp chục lần) trong khoảng nền đủ làm
    "mức thường" cao vọt và mọi tuần sau trông như tụt; bán buôn là đơn lớn thất thường
    giữa các nhà thuốc, không phản ánh nhu cầu khách lẻ.

R3  Giữa hai lần lưu tệp tồn kho, tồn một thuốc tăng hơn R3_RATIO lần lượng bán
    30 ngày và tăng ít nhất bằng min_stock. Chưa có phiếu nhập (Phase 5) nên chưa
    phân biệt được nhập nhiều hợp lệ với nhập sai: chỉ báo "cần xem lại".

Mọi so sánh dùng TRUNG BÌNH cùng thứ để đúng §16; bước 3.3 thêm Z-score bền vững.
Không gọi LLM: câu mô tả là khuôn cố định, số lấy từ phép tính.
"""

from __future__ import annotations

import math

import pandas as pd

from app.config import (
    ANOMALY_LOOKBACK_DAYS,
    R1_DROP_PCT,
    R1_MAX_P,
    R1_MIN_ORDERS,
    R1_WEEKS,
    R2_BASE_DAYS,
    R2_DROP_PCT,
    R2_MAX_P,
    R2_MIN_WEEKLY_LINES,
    R2_RECENT_DAYS,
    R3_RATIO,
    SALES_LOOKBACK_DAYS,
)

from .series import last_complete_day

WEEKDAYS = ["thứ Hai", "thứ Ba", "thứ Tư", "thứ Năm", "thứ Sáu", "thứ Bảy", "Chủ nhật"]


def _money(value: float) -> str:
    if abs(value) >= 1_000_000:
        return f"{value / 1_000_000:,.1f} triệu đ".replace(",", "_").replace(".", ",").replace("_", ".")
    return f"{value:,.0f} đ".replace(",", ".")


def _number(value: float) -> str:
    return f"{value:,.0f}".replace(",", ".")


def _pct(value: float) -> str:
    return f"{abs(value):.0f}%"


def poisson_cdf(k: int, mean: float) -> float:
    """P(X ≤ k) với X ~ Poisson(mean): xác suất bán ≤ k lần khi bình thường bán trung bình `mean` lần."""
    term = math.exp(-mean)
    total = term
    for i in range(1, k + 1):
        term *= mean / i
        total += term
    return min(total, 1.0)


def _change(actual: float, expected: float) -> float:
    return round((actual - expected) / expected * 100, 1)


def _day_totals(sales: pd.DataFrame, until: pd.Timedelta | None = None) -> pd.DataFrame:
    """Doanh thu và số đơn theo (cửa hàng, ngày); `until`: chỉ tính từ 0 giờ đến giờ đó mỗi ngày."""
    frame = sales
    if until is not None:
        elapsed = frame["sale_datetime"] - frame["sale_datetime"].dt.normalize()
        frame = frame[elapsed < until]
    frame = frame.assign(day=frame["sale_datetime"].dt.normalize())
    return frame.groupby(["store_code", "day"]).agg(revenue=("revenue", "sum"), orders=("sale_id", "nunique"))


def _first_days(sales: pd.DataFrame) -> pd.Series:
    return sales.groupby("store_code")["sale_datetime"].min().dt.normalize()


def _revenue_rule(
    totals: pd.Series, orders: pd.Series, day: pd.Timestamp, opened: pd.Timestamp
) -> tuple[float, float, int] | None:
    """(thực, nền, số tuần nền) nếu ngày `day` giảm quá ngưỡng so với các cùng thứ trước; không thì None."""
    weeks = [day - pd.Timedelta(weeks=week) for week in range(1, R1_WEEKS + 1)]
    weeks = [week for week in weeks if week >= opened]
    if len(weeks) < R1_WEEKS:
        return None  # chưa đủ R1_WEEKS cùng thứ để làm nền
    expected = float(totals.reindex(weeks, fill_value=0.0).mean())
    base_orders = float(orders.reindex(weeks, fill_value=0).mean())
    if base_orders < R1_MIN_ORDERS or expected <= 0:
        return None
    actual = float(totals.get(day, 0.0))
    if _change(actual, expected) > -R1_DROP_PCT:
        return None
    # Ít khách hơn hẳn mới là sự cố; doanh thu thấp mà lượng khách bình thường là dao động giá trị đơn.
    if poisson_cdf(int(orders.get(day, 0)), base_orders) >= R1_MAX_P:
        return None
    return actual, expected, len(weeks)


def _retail(sales: pd.DataFrame) -> pd.DataFrame:
    return sales[sales["sale_type"] != "wholesale"] if "sale_type" in sales.columns else sales


def revenue_drops(sales: pd.DataFrame, as_of: pd.Timestamp, stores: list[str]) -> list[dict]:
    """Luật R1 cho từng cửa hàng và toàn chuỗi (ALL), trên doanh thu bán lẻ."""
    sales = _retail(sales)
    today = as_of.normalize()
    until = as_of - today
    chain = sales.assign(store_code="ALL")
    frame = pd.concat([sales, chain])
    full = _day_totals(frame[frame["sale_datetime"] < today])
    partial = _day_totals(frame[frame["sale_datetime"] < as_of], until)
    opened = _first_days(frame)
    found = []
    for store in ["ALL", *stores]:
        if store not in opened.index:
            continue
        # Hôm nay đến giờ này, so với các cùng thứ cùng giờ.
        if store in partial.index.get_level_values(0):
            part = partial.loc[store]
            hit = _revenue_rule(part["revenue"], part["orders"], today, opened[store])
            if hit:
                actual, expected, weeks = hit
                found.append(
                    _record(
                        "revenue_drop_today",
                        "medium",
                        store,
                        today,
                        actual,
                        expected,
                        f"{_label(store)}: doanh thu bán lẻ hôm nay đến {as_of:%H:%M} mới {_money(actual)}, thấp hơn "
                        f"{_pct(_change(actual, expected))} so với trung bình {weeks} {WEEKDAYS[today.weekday()]} trước "
                        f"cùng giờ ({_money(expected)})",
                    )
                )
        # Các ngày đã trọn gần nhất.
        if store not in full.index.get_level_values(0):
            continue
        whole = full.loc[store]
        for back in range(1, ANOMALY_LOOKBACK_DAYS + 1):
            day = today - pd.Timedelta(days=back)
            if day < opened[store]:
                break
            hit = _revenue_rule(whole["revenue"], whole["orders"], day, opened[store])
            if hit:
                actual, expected, weeks = hit
                found.append(
                    _record(
                        "revenue_drop_day",
                        "medium",
                        store,
                        day,
                        actual,
                        expected,
                        f"{_label(store)}: doanh thu bán lẻ {WEEKDAYS[day.weekday()]} {day:%d/%m} chỉ {_money(actual)}, thấp hơn "
                        f"{_pct(_change(actual, expected))} so với trung bình {weeks} {WEEKDAYS[day.weekday()]} trước "
                        f"({_money(expected)})",
                    )
                )
    return found


def medicine_drops(sales: pd.DataFrame, as_of: pd.Timestamp, medicines: pd.DataFrame | None = None) -> list[dict]:
    """Luật R2: lượng bán 7 ngày gần nhất của một thuốc tụt hơn một nửa so với trung bình tuần trước đó."""
    end = last_complete_day(as_of) + pd.Timedelta(days=1)  # hết hôm qua
    sales = _retail(sales)
    recent_start = end - pd.Timedelta(days=R2_RECENT_DAYS)
    base_start = recent_start - pd.Timedelta(days=R2_BASE_DAYS)
    moments = sales["sale_datetime"]
    keys = ["store_code", "medicine_code"]
    first = sales.groupby(keys)["sale_datetime"].min()
    base = sales[(moments >= base_start) & (moments < recent_start)].groupby(keys).agg(
        units=("quantity", "sum"), lines=("sale_id", "count")
    )
    recent_rows = sales[(moments >= recent_start) & (moments < end)].groupby(keys)
    recent = recent_rows["quantity"].sum()
    recent_lines = recent_rows["sale_id"].count()
    weeks = R2_BASE_DAYS / 7
    names = _names(sales, medicines)
    # Mức chung của từng cửa hàng: số dòng bán 7 ngày qua so với trung bình một tuần nền.
    store_base = base.groupby(level="store_code")["lines"].sum() / weeks * (R2_RECENT_DAYS / 7)
    store_recent = recent_lines.groupby(level="store_code").sum()
    store_factor = (store_recent / store_base).reindex(store_base.index).fillna(0.0)

    found = []
    for (store, code), row in base.iterrows():
        if first[(store, code)] >= base_start + pd.Timedelta(days=7):
            continue  # thuốc mới, chưa có đủ khoảng nền
        if row["lines"] / weeks < R2_MIN_WEEKLY_LINES:
            continue
        expected = row["units"] / weeks * (R2_RECENT_DAYS / 7)
        actual = float(recent.get((store, code), 0.0))
        change = _change(actual, expected)
        expected_lines = row["lines"] / weeks * (R2_RECENT_DAYS / 7) * float(store_factor.get(store, 1.0))
        chance = poisson_cdf(int(recent_lines.get((store, code), 0)), expected_lines)
        if change <= -R2_DROP_PCT and chance < R2_MAX_P:
            name = names.get(code, code)
            found.append(
                _record(
                    "medicine_drop",
                    "medium",
                    store,
                    end - pd.Timedelta(days=1),
                    actual,
                    expected,
                    f"{store}: {name} bán {_number(actual)} trong {R2_RECENT_DAYS} ngày qua, thấp hơn {_pct(change)} so với "
                    f"mức thường ({_number(expected)}/{R2_RECENT_DAYS} ngày)"
                    + (": hết hàng hay ngừng bán?" if actual == 0 else ""),
                    medicine_code=code,
                    medicine_name=name,
                    period_start=recent_start,
                    extra={"lines": int(recent_lines.get((store, code), 0)), "expected_lines": round(expected_lines, 1), "chance": round(chance, 5)},
                )
            )
    return found


def stock_jumps(
    current: pd.DataFrame,
    previous: pd.DataFrame | None,
    sales: pd.DataFrame,
    as_of: pd.Timestamp,
    medicines: pd.DataFrame | None = None,
    *,
    saved_at: str | None = None,
    previous_saved_at: str | None = None,
) -> list[dict]:
    """Luật R3. current/previous: tổng tồn theo (store_code, medicine_code, quantity) của hai lần lưu tệp."""
    if previous is None or previous.empty or current.empty:
        return []
    keys = ["store_code", "medicine_code"]
    merged = current.groupby(keys)["quantity"].sum().to_frame("now").join(
        previous.groupby(keys)["quantity"].sum().to_frame("before"), how="left"
    ).fillna({"before": 0.0})
    window = sales[(sales["sale_datetime"] >= as_of - pd.Timedelta(days=SALES_LOOKBACK_DAYS)) & (sales["sale_datetime"] < as_of)]
    sold = window.groupby(keys)["quantity"].sum()
    minimum = {} if medicines is None else medicines.set_index("medicine_code")["min_stock"].dropna().to_dict()
    names = _names(sales, medicines)

    found = []
    for (store, code), row in merged.iterrows():
        increase = row["now"] - row["before"]
        sold_30 = float(sold.get((store, code), 0.0))
        if increase <= 0 or increase < max(float(minimum.get(code, 1.0)), 1.0):
            continue
        if increase > R3_RATIO * sold_30:
            name = names.get(code, code)
            found.append(
                _record(
                    "stock_jump",
                    "low",
                    store,
                    as_of.normalize(),
                    float(row["now"]),
                    float(row["before"]),
                    f"{store}: tồn {name} tăng từ {_number(row['before'])} lên {_number(row['now'])} giữa hai lần lưu tệp, "
                    f"gấp {increase / sold_30:.0f} lần lượng bán 30 ngày ({_number(sold_30)}): kiểm tra lại số nhập"
                    if sold_30
                    else f"{store}: tồn {name} tăng từ {_number(row['before'])} lên {_number(row['now'])} giữa hai lần lưu tệp "
                    f"trong khi 30 ngày qua không bán được cái nào: kiểm tra lại số nhập",
                    medicine_code=code,
                    medicine_name=name,
                    extra={"saved_at": saved_at, "previous_saved_at": previous_saved_at, "sold_30d": sold_30},
                )
            )
    return found


def _names(sales: pd.DataFrame, medicines: pd.DataFrame | None) -> dict[str, str]:
    source = medicines if medicines is not None and not medicines.empty else sales
    if "medicine_name" not in source.columns:
        return {}
    return source.dropna(subset=["medicine_name"]).drop_duplicates("medicine_code").set_index("medicine_code")["medicine_name"].to_dict()


def _label(store: str) -> str:
    return "Toàn chuỗi" if store == "ALL" else store


def _record(
    kind: str,
    severity: str,
    store: str,
    day: pd.Timestamp,
    actual: float,
    expected: float,
    message: str,
    *,
    medicine_code: str | None = None,
    medicine_name: str | None = None,
    period_start: pd.Timestamp | None = None,
    extra: dict | None = None,
) -> dict:
    return {
        "kind": kind,
        "severity": severity,
        "store_code": store,
        "medicine_code": medicine_code,
        "medicine_name": medicine_name,
        "date": day.date().isoformat(),
        "period_start": None if period_start is None else period_start.date().isoformat(),
        "actual": round(float(actual), 2),
        "expected": round(float(expected), 2),
        "change_pct": _change(actual, expected) if expected else None,
        # Cách phát hiện: luật nào (bước 3.3 thêm "robust_z").
        "evidence": [{"method": "rule", "rule": {"revenue_drop_today": "R1", "revenue_drop_day": "R1", "medicine_drop": "R2", "stock_jump": "R3"}[kind]}],
        "message": message,
        **(extra or {}),
    }


def rule_anomalies(
    sales: pd.DataFrame,
    as_of: pd.Timestamp,
    medicines: pd.DataFrame | None = None,
    *,
    current_stock: pd.DataFrame | None = None,
    previous_stock: pd.DataFrame | None = None,
    saved_at: str | None = None,
    previous_saved_at: str | None = None,
) -> list[dict]:
    """Mọi bất thường theo luật R1–R3, mới nhất trước."""
    past = sales[sales["sale_datetime"] < as_of]
    stores = sorted(past["store_code"].dropna().unique().tolist())
    found = revenue_drops(past, as_of, stores) + medicine_drops(past, as_of, medicines)
    if current_stock is not None:
        found += stock_jumps(
            current_stock, previous_stock, past, as_of, medicines, saved_at=saved_at, previous_saved_at=previous_saved_at
        )
    return sorted(found, key=lambda item: (item["date"], item["store_code"]), reverse=True)
