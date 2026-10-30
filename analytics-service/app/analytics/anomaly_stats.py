"""Phát hiện bất thường, Level 2: Z-score bền vững (Phase 3, bước 3.3; quyết định D10).

    z = (giá trị − trung vị) / (1,4826 × MAD),   MAD = trung vị của |mẫu − trung vị|

Z-score cho biết một con số cách "mức bình thường" bao nhiêu lần độ lệch thông
thường. Dùng trung vị và MAD (không dùng trung bình, độ lệch chuẩn) vì một ngày
mất điện nằm trong mẫu sẽ kéo trung bình lệch và che các bất thường khác; trung
vị gần như không bị ảnh hưởng. 1,4826 đưa MAD về cùng thang với độ lệch chuẩn.

- Doanh thu bán lẻ mỗi cửa hàng: so với Z_WEEKS cùng thứ trước (thứ Hai với thứ Hai).
  Bắt cả tụt (z âm) và tăng vọt (z dương). Ngoài |z| > Z_THRESHOLD còn cần lệch ≥ R1_DROP_PCT %
  (đủ LỚN để đáng quan tâm, không chỉ hiếm) và số đơn cũng lệch bất thường (Poisson < R1_MAX_P),
  như luật R1: tuần nào mẫu ít phân tán thì lệch 20% cũng ra z = 4.
- Từng thuốc ở từng cửa hàng: số lượng bán lẻ mỗi ngày so với Z_PRODUCT_BASE_DAYS
  ngày trước; chỉ xét TĂNG VỌT (tụt của từng thuốc đã có R2 theo tuần, ổn định hơn).
  Thêm điều kiện số lần bán cao tới mức ngẫu nhiên khó gây ra (Poisson), vì ~180 cặp
  × 14 ngày là hơn 2.500 phép kiểm mỗi lần chạy.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from app.config import (
    ANOMALY_LOOKBACK_DAYS,
    R1_DROP_PCT,
    R1_MAX_P,
    R1_WEEKS,
    Z_PRODUCT_BASE_DAYS,
    Z_PRODUCT_MAX_P,
    Z_THRESHOLD,
    Z_WEEKS,
)

from .anomaly import WEEKDAYS, _label, _money, _names, _number, _record, _retail, poisson_cdf
from .series import last_complete_day

MAD_SCALE = 1.4826


def _decimal(value: float, *, signed: bool = False) -> str:
    """Một chữ số thập phân kiểu Việt Nam: 6,2 và +4,3."""
    return f"{value:{'+' if signed else ''}.1f}".replace(".", ",")


def robust_z(value: float, sample: np.ndarray, *, floor: float = 0.0) -> float | None:
    """Z-score bền vững của `value` so với `sample`. `floor`: độ lệch tối thiểu (tránh chia cho ~0)."""
    sample = np.asarray(sample, dtype="float64")
    sample = sample[~np.isnan(sample)]
    if len(sample) == 0:
        return None
    median = float(np.median(sample))
    scale = max(MAD_SCALE * float(np.median(np.abs(sample - median))), floor)
    if scale <= 0:
        return None
    return (value - median) / scale


def poisson_sf(k: int, mean: float) -> float:
    """P(X ≥ k) với X ~ Poisson(mean): xác suất bán từ k lần trở lên khi thường bán `mean` lần."""
    if k <= 0:
        return 1.0
    term = math.exp(-mean)
    below = term
    for i in range(1, k):
        term *= mean / i
        below += term
    return max(0.0, 1.0 - below)


def revenue_z(sales: pd.DataFrame, as_of: pd.Timestamp, stores: list[str]) -> list[dict]:
    """Ngày đã trọn trong ANOMALY_LOOKBACK_DAYS ngày có doanh thu bán lẻ lệch |z| > Z_THRESHOLD so với cùng thứ."""
    retail = _retail(sales[sales["sale_datetime"] < as_of.normalize()])
    frame = pd.concat([retail, retail.assign(store_code="ALL")])
    frame = frame.assign(day=frame["sale_datetime"].dt.normalize())
    grouped = frame.groupby(["store_code", "day"])
    totals = grouped["revenue"].sum()
    all_orders = grouped["sale_id"].nunique()
    end = last_complete_day(as_of)
    found = []
    for store in ["ALL", *stores]:
        if store not in totals.index.get_level_values(0):
            continue
        series = totals.loc[store]
        opened = series.index.min()
        days = pd.date_range(opened, end, freq="D")
        series = series.reindex(days, fill_value=0.0)
        orders = all_orders.loc[store].reindex(days, fill_value=0)
        for back in range(ANOMALY_LOOKBACK_DAYS):
            day = end - pd.Timedelta(days=back)
            if day < opened:
                break
            weeks = [day - pd.Timedelta(weeks=week) for week in range(1, Z_WEEKS + 1)]
            sample = series.reindex([week for week in weeks if week >= opened]).dropna().to_numpy()
            if len(sample) < R1_WEEKS:
                continue
            median = float(np.median(sample))
            # Sàn 5% trung vị: tránh MAD ~0 làm một chênh lệch nhỏ thành "bất thường".
            z = robust_z(float(series[day]), sample, floor=0.05 * median)
            if z is None or abs(z) <= Z_THRESHOLD or median <= 0:
                continue
            actual = float(series[day])
            up = z > 0
            change = (actual - median) / median * 100
            if abs(change) < R1_DROP_PCT:
                continue  # hiếm nhưng không đủ lớn để đáng báo
            usual_orders = float(np.median(orders.reindex([week for week in weeks if week >= opened]).to_numpy()))
            count = int(orders[day])
            chance = poisson_sf(count, usual_orders) if up else poisson_cdf(count, usual_orders)
            if chance >= R1_MAX_P:
                continue  # lượng khách bình thường: chỉ là hôm đó đơn giá trị lớn/nhỏ
            found.append(
                _record(
                    "revenue_spike" if up else "revenue_drop_day",
                    "low" if up else "medium",
                    store,
                    day,
                    actual,
                    median,
                    f"{_label(store)}: doanh thu bán lẻ {WEEKDAYS[day.weekday()]} {day:%d/%m} {_money(actual)}, "
                    f"{'cao' if up else 'thấp'} hơn {abs(change):.0f}% so với mức thường của {len(sample)} "
                    f"{WEEKDAYS[day.weekday()]} trước ({_money(median)}), z = {_decimal(z, signed=True)}",
                    evidence=[{"method": "robust_z", "z": round(z, 2), "weeks": len(sample)}],
                )
            )
    return found


def product_spikes(sales: pd.DataFrame, as_of: pd.Timestamp, medicines: pd.DataFrame | None = None) -> list[dict]:
    """Thuốc bán lẻ tăng vọt trong một ngày đã trọn (ANOMALY_LOOKBACK_DAYS ngày gần nhất)."""
    end = last_complete_day(as_of)
    first_day = end - pd.Timedelta(days=ANOMALY_LOOKBACK_DAYS + Z_PRODUCT_BASE_DAYS - 1)
    retail = _retail(sales)
    retail = retail[(retail["sale_datetime"] >= first_day) & (retail["sale_datetime"] < end + pd.Timedelta(days=1))]
    if retail.empty:
        return []
    retail = retail.assign(day=retail["sale_datetime"].dt.normalize()).astype({"quantity": "float64"})
    days = pd.date_range(first_day, end, freq="D")
    keys = ["store_code", "medicine_code"]
    units = retail.pivot_table(index="day", columns=keys, values="quantity", aggfunc="sum", fill_value=0.0).reindex(days, fill_value=0.0)
    lines = retail.pivot_table(index="day", columns=keys, values="sale_id", aggfunc="count", fill_value=0).reindex(days, fill_value=0)
    names = _names(sales, medicines)

    found = []
    for back in range(ANOMALY_LOOKBACK_DAYS):
        day = end - pd.Timedelta(days=back)
        base = units.loc[day - pd.Timedelta(days=Z_PRODUCT_BASE_DAYS) : day - pd.Timedelta(days=1)]
        base_lines = lines.loc[base.index]
        median = base.median()
        mad = (base - median).abs().median()
        # Sàn của độ lệch: căn bậc hai trung vị (dao động tự nhiên của số đếm) và tối thiểu 1.
        scale = np.maximum(MAD_SCALE * mad, np.maximum(np.sqrt(median), 1.0))
        z = (units.loc[day] - median) / scale
        for key in z.index[z > Z_THRESHOLD]:
            expected_lines = float(base_lines[key].mean())
            count = int(lines.loc[day, key])
            if poisson_sf(count, expected_lines) >= Z_PRODUCT_MAX_P:
                continue  # bán nhiều hơn vì vài đơn số lượng lớn, không phải nhiều khách hơn hẳn
            store, code = key
            actual, usual = float(units.loc[day, key]), float(median[key])
            name = names.get(code, code)
            found.append(
                _record(
                    "medicine_spike",
                    "low",
                    store,
                    day,
                    actual,
                    usual,
                    f"{store}: {name} bán {_number(actual)} ngày {day:%d/%m} ({count} lần), gấp "
                    f"{_decimal(actual / usual)} lần mức thường ({_number(usual)}/ngày)"
                    if usual
                    else f"{store}: {name} bán {_number(actual)} ngày {day:%d/%m} ({count} lần) trong khi thường gần như không bán",
                    medicine_code=code,
                    medicine_name=name,
                    evidence=[{"method": "robust_z", "z": round(float(z[key]), 2), "lines": count, "expected_lines": round(expected_lines, 1)}],
                )
            )
    return found
