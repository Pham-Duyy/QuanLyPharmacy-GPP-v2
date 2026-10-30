"""Gợi ý đặt hàng theo dự báo (Phase 5, bước 5.2; quyết định D18–D20).

Cho từng thuốc ở từng cửa hàng:

    kỳ cần đủ       P = thời gian chờ hàng về + REORDER_COVER_DAYS
    nhu cầu P ngày  = cộng dự báo từng ngày (bước 3.5, gồm cả bán buôn trung bình)
    tồn an toàn     = z(mức phục vụ của ô ABC–XYZ) × σ_P
                      σ_P = MAE_TO_SIGMA × sai số tổng 7 ngày (backtest) × nhu cầu 7 ngày × √(P / 7)
    mức cần có      = max(nhu cầu P ngày + tồn an toàn, tồn tối thiểu), không quá tồn tối đa,
                      hàng nhóm C không quá REORDER_MAX_DAYS ngày bán
    tồn dùng được   = tồn bán được − phần các lô sẽ hết hạn trước khi bán kịp (FEFO theo dự báo)
    số đặt          = mức cần có − tồn dùng được, làm tròn lên theo quy cách (pack_size)

Chuyển hàng trước khi mua (bước 5.3): cửa hàng nào có tồn dùng được vượt mức cần có của CHÍNH
nó thì phần vượt chuyển được. Nơi thiếu gấp nhất được chia trước, từ nơi thừa nhiều nhất; phần
còn thiếu mới đặt mua. Mỗi lần chuyển phải bù ít nhất TRANSFER_MIN_SHARE lượng thiếu.

Thuốc chưa có dự báo (ít lịch sử) dùng tốc độ bán 30 ngày và sai số mặc định. Không tạo chứng
từ nào: chỉ gợi ý để người đặt hàng xem, sửa. Mọi phép tính là tất định, không gọi LLM.
"""

from __future__ import annotations

import math
from statistics import NormalDist

import pandas as pd

from app.config import (
    LEAD_TIME_MAX_DAYS,
    MAE_TO_SIGMA,
    REORDER_COVER_DAYS,
    REORDER_DEFAULT_LEAD_DAYS,
    REORDER_DEFAULT_PACK,
    REORDER_FALLBACK_ERROR,
    REORDER_MAX_DAYS,
    SAFETY_MAX_SHARE,
    TRANSFER_MIN_SHARE,
)

from .classify import service_level
from .expiry import lot_table
from .inventory import stock_table

REASON_LABELS = {
    "out_of_stock": "Hết hàng",
    "stockout_before_arrival": "Hết trước khi hàng kịp về",
    "below_min": "Dưới tồn tối thiểu",
    "reorder": "Cần bổ sung cho kỳ tới",
}


def _optional(value) -> float | None:
    if value is None or (isinstance(value, float) and math.isnan(value)) or pd.isna(value):
        return None
    return float(value)


def _pack(value) -> int:
    number = _optional(value)
    return int(number) if number is not None and number >= 1 else REORDER_DEFAULT_PACK


def _lead(value) -> int:
    number = _optional(value)
    return int(number) if number is not None and 0 <= number <= LEAD_TIME_MAX_DAYS else REORDER_DEFAULT_LEAD_DAYS


def demand_over(values: list[float], days: int) -> float:
    """Tổng nhu cầu `days` ngày tới; quá tầm dự báo thì lấy trung bình 7 ngày cuối cho phần còn thiếu."""
    if days <= len(values):
        return float(sum(values[:days]))
    tail = values[-7:] or [0.0]
    return float(sum(values)) + (days - len(values)) * sum(tail) / len(tail)


def _latest_lot(inventory: pd.DataFrame, keys: list[str]) -> pd.DataFrame:
    """Lô nhập gần nhất theo `keys`: giá nhập, nhà cung cấp (bỏ ô trống)."""
    lots = inventory.copy()
    order = ["received_date", "expiry_date"] if "received_date" in lots.columns else ["expiry_date"]
    lots = lots.sort_values(order, na_position="first")
    columns = [column for column in ("purchase_price", "supplier") if column in lots.columns]
    return lots.groupby(keys)[columns].last()


def _lot_field(tables: list[tuple[pd.DataFrame, object]], field: str):
    """Giá trị `field` ở bảng đầu tiên có (cửa hàng trước, rồi cả chuỗi)."""
    for table, key in tables:
        if field in table.columns and key in table.index:
            value = table.at[key, field]
            if isinstance(value, str) and value:
                return value
            if not isinstance(value, str) and _optional(value) is not None:
                return float(value)
    return None


def reorder_plan(
    sales: pd.DataFrame,
    inventory: pd.DataFrame | None,
    medicines: pd.DataFrame | None,
    as_of: pd.Timestamp,
    forecast: dict | None,
    stockout: list[dict],
    classes: dict[str, dict],
) -> dict:
    """Gợi ý đặt hàng cho mọi cửa hàng; trả {"ALL": ..., "CH01": ...}.

    `forecast`: forecast_bundle (bước 3.5) hoặc None; `stockout`: stockout_projection;
    `classes`: kết quả classify theo cửa hàng (bước 5.1).
    """
    if inventory is None or inventory.empty:
        return {"ALL": {"available": False, "items": []}}

    table = stock_table(sales, inventory, medicines, as_of)
    for column in ("pack_size", "lead_time_days", "supplier"):
        table[column] = (
            table["medicine_code"].map(medicines.drop_duplicates("medicine_code").set_index("medicine_code")[column])
            if medicines is not None and column in medicines.columns
            else None
        )

    points: dict[tuple[str, str], list[float]] = {}
    errors: dict[tuple[str, str], float | None] = {}
    if forecast:
        points = {(row["store_code"], row["medicine_code"]): row["values"] for row in forecast["demand_points"]}
        errors = {(row["store_code"], row["medicine_code"]): row["wape_total"] for row in forecast["demand"]}
    rates = {key: demand_over(values, 30) / 30 for key, values in points.items()}

    lots = lot_table(sales, inventory, medicines, as_of, rates)
    at_risk = lots[lots["days_left"] >= 0].groupby(["store_code", "medicine_code"])["at_risk_quantity"].sum(min_count=1)
    # Thuốc đã hết sạch ở cửa hàng không còn lô để tra: lấy lô gần nhất của cùng thuốc ở cả chuỗi.
    latest = _latest_lot(inventory, ["store_code", "medicine_code"])
    latest_chain = _latest_lot(inventory, ["medicine_code"])
    sold_price = sales.dropna(subset=["purchase_price"]).sort_values("sale_datetime").groupby("medicine_code")["purchase_price"].last()
    stockouts = {(row["store_code"], row["medicine_code"]): row for row in stockout}
    cells = {
        (store, item["medicine_code"]): item
        for store, result in classes.items()
        if store != "ALL"
        for item in result.get("items", [])
    }

    items = []
    # Phần tồn vượt mức cần có của chính cửa hàng: chuyển được cho cửa hàng khác (bước 5.3).
    excess: dict[tuple[str, str], float] = {}
    for row in table.itertuples(index=False):
        key = (row.store_code, row.medicine_code)
        values = points.get(key)
        method = "forecast" if values else "ads"
        if not values:
            values = [float(row.ads)] * 30
        lead = _lead(row.lead_time_days)
        pack = _pack(row.pack_size)
        period = lead + REORDER_COVER_DAYS
        demand = demand_over(values, period)
        week = demand_over(values, 7)
        error = errors.get(key)
        error_used = error if error is not None else REORDER_FALLBACK_ERROR

        cell = cells.get(key)
        abc = cell["abc"] if cell else "C"
        xyz = cell["xyz"] if cell else None
        level = service_level(abc, xyz)
        z = NormalDist().inv_cdf(level)
        safety = min(z * MAE_TO_SIGMA * error_used * week * math.sqrt(period / 7), SAFETY_MAX_SHARE * demand)

        minimum = _optional(row.min_stock) or 0.0
        maximum = _optional(row.max_stock)
        target = max(demand + safety, minimum)
        if abc in REORDER_MAX_DAYS:
            target = min(target, max(demand_over(values, REORDER_MAX_DAYS[abc]), minimum))
        if maximum is not None and maximum > 0:
            target = min(target, maximum)

        stock = float(row.stock_quantity)
        # Lô còn trên 90 ngày không kết luận nguy cơ (để trống): coi như bán kịp.
        expiring = _optional(at_risk.get(key)) or 0.0
        usable = max(stock - expiring, 0.0)
        need = target - usable
        if need <= 0 or (demand <= 0 and minimum <= 0):
            if usable - target >= 1:
                excess[key] = usable - target
            continue

        projected = stockouts.get(key)
        days_until = projected["days_until_stockout"] if projected else (0 if stock <= 0 else None)
        if stock <= 0:
            reason = "out_of_stock"
        elif days_until is not None and days_until <= lead:
            reason = "stockout_before_arrival"
        elif usable < minimum:
            reason = "below_min"
        else:
            reason = "reorder"

        sources = [(latest, key), (latest_chain, row.medicine_code)]
        unit_cost = _lot_field(sources, "purchase_price")
        if unit_cost is None:
            unit_cost = _optional(sold_price.get(row.medicine_code))
        supplier = row.supplier if isinstance(row.supplier, str) and row.supplier else _lot_field(sources, "supplier")

        items.append(
            {
                "store_code": row.store_code,
                "medicine_code": row.medicine_code,
                "medicine_name": row.medicine_name if isinstance(row.medicine_name, str) else None,
                "unit": row.unit if isinstance(row.unit, str) else None,
                "abc": abc,
                "xyz": xyz,
                "cell": f"{abc}{xyz}" if xyz else abc,
                "service_level": level,
                "reason": reason,
                "stock_quantity": round(stock, 2),
                "expiring_quantity": round(expiring, 2),
                "usable_quantity": round(usable, 2),
                "lead_time_days": lead,
                "cover_days": REORDER_COVER_DAYS,
                "demand_quantity": round(demand, 1),
                "safety_stock": round(safety, 1),
                "target_quantity": round(target, 1),
                "pack_size": pack,
                "need_quantity": round(need, 2),
                "unit_cost": None if unit_cost is None else round(unit_cost, 2),
                "supplier": supplier,
                "days_until_stockout": days_until,
                "stockout_date": projected["stockout_date"] if projected else None,
                "forecast_method": method,
                "forecast_error": error,
            }
        )

    urgency = {"out_of_stock": 0, "stockout_before_arrival": 1, "below_min": 2, "reorder": 3}
    items.sort(
        key=lambda item: (
            urgency[item["reason"]],
            item["days_until_stockout"] if item["days_until_stockout"] is not None else 999,
            -(item["need_quantity"] * (item["unit_cost"] or 0)),
        )
    )
    # Chỉ chuyển giữa các cửa hàng có bán hàng: mã chỉ có trong tệp tồn thường là gõ nhầm (unknown_store).
    selling = set(sales["store_code"].dropna())
    transfers = _allocate(items, {key: value for key, value in excess.items() if key[0] in selling})
    stores = sorted({row.store_code for row in table.itertuples(index=False)})
    return {
        scope: _scope(
            items if scope == "ALL" else [item for item in items if item["store_code"] == scope],
            transfers if scope == "ALL" else [move for move in transfers if scope in (move["from_store"], move["to_store"])],
            scope,
        )
        for scope in ["ALL", *stores]
    }


def _allocate(items: list[dict], excess: dict[tuple[str, str], float]) -> list[dict]:
    """Chia phần tồn thừa cho nơi thiếu (đã xếp gấp trước), rồi tính số còn phải mua.

    Ghi vào từng dòng: transfers, transfer_quantity, order_quantity, order_packs, order_value, action.
    """
    moves = []
    for item in items:
        need = item["need_quantity"]
        remaining = need
        donors = sorted(
            ((store, available) for (store, code), available in excess.items() if code == item["medicine_code"] and store != item["store_code"]),
            key=lambda donor: (-donor[1], donor[0]),
        )
        incoming = []
        for store, available in donors:
            if remaining <= 0:
                break
            # Chuyển tròn lên phần thiếu nếu nơi gửi đủ: không để lại 0,7 viên rồi đi mua 1 viên.
            quantity = min(math.ceil(round(remaining, 6)), math.floor(available))
            if quantity < 1 or quantity < TRANSFER_MIN_SHARE * need:
                continue
            excess[(store, item["medicine_code"])] = available - quantity
            remaining -= quantity
            incoming.append({"from_store": store, "quantity": quantity})
            moves.append(
                {
                    "from_store": store,
                    "to_store": item["store_code"],
                    "medicine_code": item["medicine_code"],
                    "medicine_name": item["medicine_name"],
                    "unit": item["unit"],
                    "quantity": quantity,
                    "value": None if item["unit_cost"] is None else round(quantity * item["unit_cost"]),
                }
            )
        pack = item["pack_size"]
        order = math.ceil(round(remaining, 6) / pack) * pack if remaining > 1e-6 else 0
        transferred = sum(move["quantity"] for move in incoming)
        item.update(
            {
                "transfers": incoming,
                "transfer_quantity": transferred,
                "order_quantity": int(order),
                "order_packs": int(order // pack),
                "order_value": None if item["unit_cost"] is None else round(order * item["unit_cost"]),
                "action": "transfer" if order == 0 else ("transfer_and_order" if transferred else "order"),
            }
        )
    return moves


def _scope(items: list[dict], transfers: list[dict], scope: str) -> dict:
    buying = [item for item in items if item["order_quantity"] > 0]
    values = [item["order_value"] for item in buying if item["order_value"] is not None]
    by_supplier: dict[str, dict] = {}
    for item in buying:
        name = item["supplier"] or "Chưa rõ nhà cung cấp"
        entry = by_supplier.setdefault(name, {"supplier": name, "lines": 0, "order_value": 0})
        entry["lines"] += 1
        entry["order_value"] += item["order_value"] or 0
    return {
        "available": True,
        "store": scope,
        "cover_days": REORDER_COVER_DAYS,
        "lines": len(items),
        "order_lines": len(buying),
        "order_value": round(sum(values)),
        "missing_cost": len(buying) - len(values),
        # Chuyển hàng: tiền hàng khỏi phải mua (theo giá nhập), cả chiều nhận và chiều gửi của cửa hàng này.
        "transfer_lines": len(transfers),
        "transfer_value": round(sum(move["value"] or 0 for move in transfers)),
        "transfers": transfers,
        "by_reason": {
            reason: {"label": label, "lines": sum(1 for item in items if item["reason"] == reason)}
            for reason, label in REASON_LABELS.items()
        },
        "by_supplier": sorted(by_supplier.values(), key=lambda entry: -entry["order_value"]),
        "items": items,
    }
