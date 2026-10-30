"""Hạn dùng 5 mức và FEFO (Phase 2, bước 2.4; master prompt §14, §15).

1. Mức hạn của từng lô, theo số ngày còn lại = hạn dùng − hôm nay:
   expired < 0 | critical 0–7 | warning 8–30 | monitor 31–90 | normal > 90.
   Hạn dùng là ngày cuối còn dùng được: lô hạn đúng hôm nay còn 0 ngày, chưa hết hạn.

2. FEFO (First Expired, First Out): với mỗi thuốc ở mỗi cửa hàng, xếp lô
   còn hạn theo hạn gần trước; lô đứng đầu là lô phải bán trước. Giả định bán
   đúng thứ tự đó với tốc độ ADS (bán trung bình/ngày, 30 ngày gần nhất):

       đã_dùng = 0 ngày
       mỗi lô theo hạn tăng dần:
           bán_được   = min(số lượng, max(0, ngày_còn_lại − đã_dùng) × ADS)
           có_nguy_cơ = số lượng − bán_được      (× giá nhập = tiền có thể mất)
           đã_dùng   += số lượng / ADS

   Ví dụ ADS 10: lô A 50 hộp còn 7 ngày → bán hết sau 5 ngày, an toàn;
   lô B 200 hộp còn 12 ngày → chỉ còn 7 ngày để bán, được 70, 130 hộp có nguy cơ.

   Chỉ kết luận "có nguy cơ" cho lô còn ≤ EXPIRY_MONITOR_DAYS ngày: dự đoán tốc
   độ bán xa hơn thế không đáng tin, và thuốc không ai mua đã là "tồn chết" ở 2.3.
   Lô đã hết hạn: toàn bộ là hàng không được bán (không còn là "nguy cơ").
   Tính thận trọng: số ngày để bán = số ngày còn lại, không cộng phần còn lại của
   hôm nay; lô hạn đúng hôm nay coi như hết thời gian bán. Báo sớm an toàn hơn báo muộn.
"""

from __future__ import annotations

import math
from typing import Literal

import pandas as pd

from app.config import (
    EXPIRY_CRITICAL_DAYS,
    EXPIRY_MONITOR_DAYS,
    EXPIRY_RISK_MIN_SHARE,
    EXPIRY_WARNING_DAYS,
    SALES_LOOKBACK_DAYS,
)

from .periods import Window

Level = Literal["expired", "critical", "warning", "monitor", "normal"]
LEVELS: tuple[Level, ...] = ("expired", "critical", "warning", "monitor", "normal")
LEVEL_LABELS = {
    "expired": "Đã hết hạn",
    "critical": "Nguy cấp (≤ 7 ngày)",
    "warning": "Cảnh báo (8–30 ngày)",
    "monitor": "Theo dõi (31–90 ngày)",
    "normal": "Bình thường (> 90 ngày)",
}


def level_of(days_left: int) -> Level:
    if days_left < 0:
        return "expired"
    if days_left <= EXPIRY_CRITICAL_DAYS:
        return "critical"
    if days_left <= EXPIRY_WARNING_DAYS:
        return "warning"
    if days_left <= EXPIRY_MONITOR_DAYS:
        return "monitor"
    return "normal"


def fefo_plan(lots: pd.DataFrame, ads: float) -> pd.DataFrame:
    """Mô phỏng FEFO cho các lô của MỘT thuốc ở MỘT cửa hàng (docstring đầu tệp).

    Trả về thêm các cột: fefo_rank (1 = bán trước; lô hết hạn để trống),
    sell_start_day, sellable_before_expiry, at_risk_quantity.
    """
    lots = lots.sort_values(["days_left", "batch_code"]).copy()
    ranks, starts, sellable, at_risk = [], [], [], []
    used = 0.0
    rank = 0
    for quantity, days_left in zip(lots["quantity"], lots["days_left"]):
        if days_left < 0:
            # Hết hạn: không được bán, không chiếm thời gian bán của lô sau.
            ranks.append(None)
            starts.append(None)
            sellable.append(0.0)
            at_risk.append(None)
            continue
        rank += 1
        ranks.append(rank)
        starts.append(used if ads > 0 else None)
        if ads > 0:
            can_sell = min(quantity, max(0.0, days_left - used) * ads)
            used += quantity / ads
        else:
            can_sell = 0.0
        sellable.append(can_sell)
        # Ngoài 90 ngày không kết luận: đoán xa không đáng tin.
        at_risk.append(quantity - can_sell if days_left <= EXPIRY_MONITOR_DAYS else None)
    lots["fefo_rank"] = ranks
    lots["sell_start_day"] = starts
    lots["sellable_before_expiry"] = sellable
    lots["at_risk_quantity"] = at_risk
    return lots


def _number(value, digits: int = 2):
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    return round(float(value), digits)


def lot_table(
    sales: pd.DataFrame,
    inventory: pd.DataFrame,
    medicines: pd.DataFrame | None,
    as_of: pd.Timestamp,
    rates: dict[tuple[str, str], float] | None = None,
) -> pd.DataFrame:
    """Mọi lô kèm mức hạn, thứ tự FEFO, số lượng và tiền có nguy cơ.

    rates: tốc độ bán mỗi ngày theo DỰ BÁO (bước 3.5) cho từng (cửa hàng, thuốc); có thì dùng thay ADS
    30 ngày qua (mùa cúm đang lên thì lô siro bán nhanh hơn trung bình cũ).
    """
    today = as_of.normalize()
    lots = inventory.copy()
    lots["days_left"] = (lots["expiry_date"] - today).dt.days.astype(int)
    lots["level"] = lots["days_left"].map(level_of)

    lookback = Window(as_of - pd.Timedelta(days=SALES_LOOKBACK_DAYS), as_of)
    recent = sales[lookback.contains(sales["sale_datetime"])]
    ads = (recent.groupby(["store_code", "medicine_code"])["quantity"].sum() / SALES_LOOKBACK_DAYS).to_dict()
    if rates:
        ads.update(rates)

    planned = [
        fefo_plan(group, ads.get(key, 0.0)).assign(ads=ads.get(key, 0.0))
        for key, group in lots.groupby(["store_code", "medicine_code"], sort=False)
    ]
    table = pd.concat(planned) if planned else lots.assign(fefo_rank=None, sell_start_day=None, sellable_before_expiry=None, at_risk_quantity=None, ads=0.0)
    # Số lượng nguy cơ làm tròn tới đơn vị: không có "0,4 viên" hết hạn.
    table["at_risk_quantity"] = table["at_risk_quantity"].astype("float64").round()
    table["value"] = table["quantity"] * table["purchase_price"]
    table["at_risk_value"] = table["at_risk_quantity"] * table["purchase_price"]
    table["days_to_sell"] = (table["quantity"] / table["ads"]).where(table["ads"] > 0)

    if medicines is not None and not medicines.empty:
        catalog = medicines[["medicine_code", "medicine_name", "category", "unit"]].drop_duplicates("medicine_code")
        table = table.merge(catalog, on="medicine_code", how="left")
    else:
        for column in ("medicine_name", "category", "unit"):
            table[column] = None
    return table.sort_values(["days_left", "store_code", "medicine_code", "batch_code"]).reset_index(drop=True)


def _lot_row(record: dict) -> dict:
    rank = record.get("fefo_rank")
    return {
        "store_code": record["store_code"],
        "medicine_code": record["medicine_code"],
        "medicine_name": record.get("medicine_name"),
        "unit": record.get("unit"),
        "batch_code": record["batch_code"],
        "expiry_date": record["expiry_date"].date().isoformat(),
        "days_left": int(record["days_left"]),
        "level": record["level"],
        "quantity": _number(record["quantity"]),
        "purchase_price": _number(record.get("purchase_price")),
        "value": _number(record.get("value")),
        "ads": _number(record["ads"]),
        "days_to_sell": _number(record.get("days_to_sell"), 1),
        "fefo_rank": None if rank is None or pd.isna(rank) else int(rank),
        "sellable_before_expiry": _number(record.get("sellable_before_expiry")),
        "at_risk_quantity": _number(record.get("at_risk_quantity")),
        "at_risk_value": _number(record.get("at_risk_value")),
    }


def _total(values: pd.Series):
    """Cộng tiền; có lô thiếu giá nhập thì để trống thay vì cộng thiếu."""
    return _number(values.sum()) if values.notna().all() else None


def expiry_analysis(
    sales: pd.DataFrame,
    inventory: pd.DataFrame | None,
    medicines: pd.DataFrame | None,
    as_of: pd.Timestamp,
    store_code: str | None = None,
    rates: dict[tuple[str, str], float] | None = None,
) -> dict:
    """Mức hạn và nguy cơ hết hạn của một cửa hàng, hoặc mọi cửa hàng (None)."""
    if inventory is None or inventory.empty:
        return {"store": store_code or "ALL", "available": False}
    if store_code is not None:
        sales = sales[sales["store_code"] == store_code]
        inventory = inventory[inventory["store_code"] == store_code]
        if inventory.empty:
            return {"store": store_code, "available": True, "levels": {}, "at_risk": None, "lots": [], "risk_lots": []}
    table = lot_table(sales, inventory, medicines, as_of, rates)

    levels = {}
    for level in LEVELS:
        part = table[table["level"] == level]
        levels[level] = {
            "label": LEVEL_LABELS[level],
            "lots": int(len(part)),
            "quantity": _number(part["quantity"].sum()),
            "value": _total(part["value"]),
        }
    risky = table[(table["at_risk_quantity"] > 0) & (table["at_risk_quantity"] >= EXPIRY_RISK_MIN_SHARE * table["quantity"])]
    # Nguy cơ lớn nhất (theo tiền, rồi theo số lượng) lên đầu: việc cần xử lý trước.
    risky = risky.sort_values(["at_risk_value", "at_risk_quantity"], ascending=False, na_position="last")
    return {
        "store": store_code or "ALL",
        "available": True,
        "lookback_days": SALES_LOOKBACK_DAYS,
        "rate_source": "forecast" if rates else "last_30_days",
        "thresholds": {"critical": EXPIRY_CRITICAL_DAYS, "warning": EXPIRY_WARNING_DAYS, "monitor": EXPIRY_MONITOR_DAYS},
        "levels": levels,
        "at_risk": {
            "lots": int(len(risky)),
            "quantity": _number(risky["at_risk_quantity"].sum()),
            "value": _total(risky["at_risk_value"]),
        },
        # Lô cần chú ý: mọi lô trừ mức bình thường (bình thường chỉ đếm ở levels).
        "lots": [_lot_row(record) for record in table[table["level"] != "normal"].to_dict("records")],
        "risk_lots": [_lot_row(record) for record in risky.to_dict("records")],
    }
