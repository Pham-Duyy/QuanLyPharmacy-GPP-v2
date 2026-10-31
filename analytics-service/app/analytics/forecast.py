"""Dự báo Level 1 và backtest (Phase 3, bước 3.4; master prompt §17, quyết định D12).

Chỉ dùng NGÀY ĐÃ TRỌN (series.py). Ba mô hình đơn giản, đều tính tới cuối tuần đông khách:

    naive        ngây thơ: ngày t bằng đúng cùng thứ tuần trước        (mức chuẩn để so)
    weekday_mean trung bình WEEKDAY_MEAN_WEEKS cùng thứ gần nhất        (Level 1, §17 "Moving Average")
    flat_mean    trung bình FLAT_MEAN_DAYS ngày gần nhất, mọi ngày như nhau

Với nhu cầu thuốc, đo trên tổng 7 ngày thì weekday_mean và flat_mean cho cùng một tổng
(cùng là trung bình 4 tuần), nên chỉ so naive với weekday_mean.

Chọn mô hình bằng BACKTEST: đứng ở BACKTEST_FOLDS thời điểm trong quá khứ (cách nhau 7 ngày),
chỉ nhìn dữ liệu trước thời điểm đó, dự báo 7 ngày tiếp theo, so với số thật. Thước đo:

    WAPE = Σ|thật − dự báo| / Σ thật          (không chia cho 0 ở ngày bán 0, khác MAPE)
    WAPE tổng 7 ngày = Σ|tổng 7 ngày thật − tổng 7 ngày dự báo| / Σ thật
        Nhu cầu một thuốc từng ngày dao động rất mạnh (vài lần bán, mỗi lần 10–60 viên), nhưng
        quyết định nhập hàng cần TỔNG 7 ngày: thước đo này đo đúng cái được dùng.
    Lệch (bias) = Σ(dự báo − thật) / Σ thật   (dương: dự báo cao hơn thật)

Mô hình có WAPE thấp nhất được dùng; mô hình ngây thơ cũng là ứng viên, nên mô hình phức
tạp hơn mà không thắng nó thì không được chọn. LLM không tham gia: nó chỉ đọc kết quả.
"""

from __future__ import annotations

from typing import Callable

import numpy as np
import pandas as pd

from app.config import (
    BACKTEST_FOLDS,
    FLAT_MEAN_DAYS,
    FORECAST_HORIZON_DAYS,
    HW_ALPHAS,
    HW_BETAS,
    HW_DAMPING,
    HW_GAMMAS,
    INTERVAL_QUANTILES,
    MIN_HISTORY_DAYS,
    ML_ENABLED,
    ML_MIN_IMPROVEMENT,
    WEEKDAY_MEAN_WEEKS,
)

Model = Callable[[np.ndarray, int], np.ndarray]


def naive(history: np.ndarray, horizon: int) -> np.ndarray:
    """Lặp lại tuần cuối: ngày thứ h tới bằng ngày cùng thứ trong 7 ngày gần nhất."""
    last_week = history[-7:]
    return np.array([last_week[h % 7] for h in range(horizon)], dtype="float64")


def weekday_mean(history: np.ndarray, horizon: int) -> np.ndarray:
    """Ngày thứ h tới = trung bình WEEKDAY_MEAN_WEEKS ngày cùng thứ gần nhất."""
    weeks = min(WEEKDAY_MEAN_WEEKS, len(history) // 7)
    recent = history[len(history) - weeks * 7 :].reshape(weeks, 7)  # mỗi hàng một tuần, cột cùng thứ
    by_weekday = recent.mean(axis=0)
    return np.array([by_weekday[h % 7] for h in range(horizon)], dtype="float64")


def flat_mean(history: np.ndarray, horizon: int) -> np.ndarray:
    """Mọi ngày tới bằng trung bình FLAT_MEAN_DAYS ngày gần nhất."""
    return np.full(horizon, float(history[-FLAT_MEAN_DAYS:].mean()))


# --- Holt-Winters (Level 2, bước 3.5; quyết định D11) -------------------------------------
#
# Tách chuỗi thành ba phần, mỗi ngày cập nhật một lần:
#   mức_t      = α·(y_t − mùa_{t−7}) + (1−α)·(mức_{t−1} + φ·xu_hướng_{t−1})
#   xu_hướng_t = β·(mức_t − mức_{t−1}) + (1−β)·φ·xu_hướng_{t−1}
#   mùa_t      = γ·(y_t − mức_t) + (1−γ)·mùa_{t−7}
#   dự_báo_{t+h} = mức_t + (φ + φ² + … + φ^h)·xu_hướng_t + mùa_{t+h−7}
# φ = HW_DAMPING (xu hướng tắt dần). α, β, γ chọn trong lưới HW_ALPHAS × HW_BETAS × HW_GAMMAS theo
# sai số dự báo một bước trên dữ liệu học. Cả lưới chạy cùng lúc bằng mảng numpy (mỗi tổ hợp một
# hàng), nên vòng lặp chỉ chạy theo ngày.

_GRID = np.array([(a, b, g) for a in HW_ALPHAS for b in HW_BETAS for g in HW_GAMMAS], dtype="float64")


def holt_winters_fit(history: np.ndarray, grid: np.ndarray = _GRID, damping: float = HW_DAMPING) -> dict:
    """Chạy Holt-Winters cộng tính, mùa 7 ngày, cho mọi tổ hợp trong `grid`; giữ tổ hợp sai số nhỏ nhất.

    Khởi tạo từ hai tuần đầu: mức = trung bình tuần 1, xu hướng = chênh trung bình tuần 2 và tuần 1 chia 7,
    mùa = độ lệch từng ngày tuần 1 so với mức.
    """
    values = np.asarray(history, dtype="float64")
    if len(values) < 14:
        raise ValueError("Holt-Winters cần ít nhất 14 ngày")
    alpha, beta, gamma = grid[:, 0], grid[:, 1], grid[:, 2]
    size = len(grid)
    level = np.full(size, values[:7].mean())
    trend = np.full(size, (values[7:14].mean() - values[:7].mean()) / 7)
    season = np.tile(values[:7] - values[:7].mean(), (size, 1))
    sse = np.zeros(size)
    for t in range(7, len(values)):
        slot = t % 7
        y = values[t]
        predicted = level + damping * trend + season[:, slot]
        sse += (y - predicted) ** 2
        new_level = alpha * (y - season[:, slot]) + (1 - alpha) * (level + damping * trend)
        trend = beta * (new_level - level) + (1 - beta) * damping * trend
        season[:, slot] = gamma * (y - new_level) + (1 - gamma) * season[:, slot]
        level = new_level
    best = int(np.argmin(sse))
    return {
        "alpha": float(alpha[best]),
        "beta": float(beta[best]),
        "gamma": float(gamma[best]),
        "level": float(level[best]),
        "trend": float(trend[best]),
        "season": season[best].copy(),
        "next_slot": len(values) % 7,
        "damping": damping,
    }


def holt_winters(history: np.ndarray, horizon: int) -> np.ndarray:
    """Dự báo `horizon` ngày bằng Holt-Winters (tham số chọn trên chính `history`)."""
    fit = holt_winters_fit(history)
    steps = np.arange(1, horizon + 1)
    damped = np.cumsum(fit["damping"] ** steps)  # φ + φ² + … + φ^h
    slots = (fit["next_slot"] + steps - 1) % 7
    return fit["level"] + damped * fit["trend"] + fit["season"][slots]


MODELS: dict[str, Model] = {
    "naive": naive,
    "weekday_mean": weekday_mean,
    "flat_mean": flat_mean,
    "holt_winters": holt_winters,
}
MODEL_LABELS = {
    "naive": "Lặp lại tuần trước",
    "weekday_mean": f"Trung bình {WEEKDAY_MEAN_WEEKS} tuần theo thứ",
    "flat_mean": f"Trung bình {FLAT_MEAN_DAYS} ngày",
    "holt_winters": "Holt-Winters (mức, xu hướng, mùa 7 ngày)",
}


def wape(actual: np.ndarray, predicted: np.ndarray) -> float | None:
    total = float(np.sum(actual))
    if total <= 0:
        return None
    return float(np.sum(np.abs(actual - predicted)) / total)


def backtest(values: np.ndarray, model: Model, *, folds: int = BACKTEST_FOLDS, horizon: int = FORECAST_HORIZON_DAYS) -> dict | None:
    """Sai số của `model` khi dự báo `horizon` ngày từ `folds` thời điểm quá khứ.

    Thời điểm sớm nhất vẫn phải còn MIN_HISTORY_DAYS ngày phía trước để mô hình học.
    Trả None nếu chưa đủ dữ liệu cho dù một lần thử.
    """
    usable = min(folds, (len(values) - MIN_HISTORY_DAYS) // horizon)
    if usable < 1:
        return None
    actual_all, predicted_all, errors, total_errors = [], [], [], []
    for fold in range(usable, 0, -1):
        origin = len(values) - fold * horizon
        actual = values[origin : origin + horizon]
        predicted = model(values[:origin], horizon)
        actual_all.append(actual)
        predicted_all.append(predicted)
        errors.append(predicted - actual)
        total_errors.append(abs(float(predicted.sum() - actual.sum())))
    actual = np.concatenate(actual_all)
    predicted = np.concatenate(predicted_all)
    total = float(actual.sum())
    return {
        "folds": usable,
        "wape": None if total <= 0 else round(float(np.abs(predicted - actual).sum() / total), 4),
        "bias": None if total <= 0 else round(float((predicted - actual).sum() / total), 4),
        "wape_total": None if total <= 0 else round(sum(total_errors) / total, 4),
        # Sai số từng ngày (dự báo − thật): bước 3.5 dùng để dựng khoảng tin cậy.
        "errors": np.concatenate(errors).round(2).tolist(),
    }


def choose_model(values: np.ndarray, candidates: tuple[str, ...] = tuple(MODELS), *, metric: str = "wape") -> dict:
    """Backtest mọi ứng viên, chọn sai số `metric` thấp nhất. Hòa thì ưu tiên mô hình đứng trước (đơn giản hơn).

    metric: "wape" (từng ngày, cho doanh thu vẽ biểu đồ) hoặc "wape_total" (tổng 7 ngày, cho nhu cầu thuốc).
    """
    scores = {name: backtest(values, MODELS[name]) for name in candidates}
    scored = {name: score for name, score in scores.items() if score is not None and score[metric] is not None}
    if not scored:
        # Chưa đủ dữ liệu để backtest: dùng trung bình theo thứ, nói rõ chưa đo được độ chính xác.
        return {"model": "weekday_mean", "scores": scores, "measured": False}
    best = min(scored, key=lambda name: (scored[name][metric], candidates.index(name)))
    return {"model": best, "scores": scores, "measured": True}


def forecast_series(
    series: pd.Series,
    *,
    horizon: int = FORECAST_HORIZON_DAYS,
    candidates: tuple[str, ...] = tuple(MODELS),
    metric: str = "wape",
) -> dict:
    """Dự báo `horizon` ngày sau ngày cuối của `series` (chuỗi theo ngày, chỉ ngày đã trọn).

    Kèm: mô hình được chọn và lý do (WAPE từng mô hình), so với 7 ngày vừa qua.
    """
    clean = series.dropna()
    if len(clean) < MIN_HISTORY_DAYS:
        return {
            "status": "insufficient_data",
            "message": f"Chưa đủ dữ liệu để dự báo: mới có {len(clean)} ngày đã trọn, cần ít nhất {MIN_HISTORY_DAYS} ngày.",
        }
    values = clean.to_numpy(dtype="float64")
    choice = choose_model(values, candidates, metric=metric)
    predicted = np.maximum(MODELS[choice["model"]](values, horizon), 0.0)  # không có doanh thu/lượng bán âm
    start = clean.index[-1] + pd.Timedelta(days=1)
    dates = pd.date_range(start, periods=horizon, freq="D")
    # Khoảng tin cậy ~80% từ sai số backtest (sai số = dự báo − thật, nên thật = dự báo − sai số).
    # Không giả định phân phối chuẩn: lấy thẳng phân vị của các sai số đã gặp.
    errors = np.asarray(choice["scores"][choice["model"]]["errors"] if choice["measured"] else [], dtype="float64")
    if len(errors):
        low_q, high_q = np.quantile(errors, INTERVAL_QUANTILES)
        lows, highs = np.maximum(predicted - high_q, 0.0), np.maximum(predicted - low_q, 0.0)
    else:
        lows = highs = [None] * horizon
    last_week = float(values[-7:].sum())
    next_week = float(predicted[:7].sum())
    return {
        "status": "ok",
        "model": choice["model"],
        "model_label": MODEL_LABELS[choice["model"]],
        "accuracy_measured": choice["measured"],
        "metric": metric,
        "wape": choice["scores"][choice["model"]][metric] if choice["measured"] else None,
        "scores": {
            name: None if score is None else {key: score[key] for key in ("folds", "wape", "wape_total", "bias")}
            for name, score in choice["scores"].items()
        },
        "errors": choice["scores"][choice["model"]]["errors"] if choice["measured"] else [],
        "points": [
            {
                "date": day.date().isoformat(),
                "value": round(float(value), 2),
                "low": None if low is None else round(float(low), 2),
                "high": None if high is None else round(float(high), 2),
            }
            for day, value, low, high in zip(dates, predicted, lows, highs)
        ],
        "total": round(float(predicted.sum()), 2),
        "last_7_days": round(last_week, 2),
        # "Dự kiến 7 ngày tới tăng 18%" (§17): 7 ngày tới so với 7 ngày vừa qua.
        "change_vs_last_7_pct": None if last_week <= 0 else round((next_week - last_week) / last_week * 100, 1),
    }


# --- Dự báo có tách bán lẻ / bán buôn --------------------------------------------------------
#
# Đơn bán buôn (khoảng 1/5 doanh thu dữ liệu mẫu) là vài đơn lớn thất thường: không mô hình nào
# đoán được ngày nào có. Đưa vào chuỗi thì sai số tăng gấp rưỡi (đo trên dữ liệu mẫu: doanh thu
# toàn chuỗi 16% → 9,8% khi tách). Nên: dự báo phần bán lẻ bằng mô hình chọn qua backtest, cộng
# phần bán buôn bằng trung bình FLAT_MEAN_DAYS ngày (về lâu dài nó vẫn tiêu hao hàng, góp doanh thu).
# Độ chính xác báo cáo là của phần bán lẻ.


def _split(sales: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    if "sale_type" not in sales.columns:
        return sales, sales.iloc[0:0]
    wholesale = sales["sale_type"] == "wholesale"
    return sales[~wholesale], sales[wholesale]


def _with_wholesale(result: dict, wholesale: pd.Series, retail_index: pd.DatetimeIndex, retail_last_7: float) -> dict:
    """Cộng trung bình bán buôn mỗi ngày vào dự báo bán lẻ."""
    if result["status"] != "ok":
        return result
    aligned = wholesale.reindex(retail_index, fill_value=0.0)
    per_day = float(aligned.iloc[-FLAT_MEAN_DAYS:].mean()) if len(aligned) else 0.0
    def shift(value: float | None) -> float | None:
        return None if value is None else round(value + per_day, 2)

    points = [
        {**point, "value": shift(point["value"]), "low": shift(point["low"]), "high": shift(point["high"])}
        for point in result["points"]
    ]
    return {
        **result,
        "points": points,
        "total": round(sum(point["value"] for point in points), 2),
        # Mức thay đổi so BÁN LẺ với BÁN LẺ: tuần vừa qua tình cờ không có đơn bán buôn thì so tổng
        # sẽ ra "tăng gấp đôi" giả. (result["change_vs_last_7_pct"] đã tính trên chuỗi bán lẻ.)
        "last_7_days": round(retail_last_7 + float(aligned.iloc[-7:].sum()), 2),
        "retail_last_7_days": round(retail_last_7, 2),
        "retail_total": result["total"],
        "wholesale_per_day": round(per_day, 2),
        "accuracy_scope": "retail",
    }


def forecast_revenue(sales: pd.DataFrame, as_of: pd.Timestamp, store_code: str | None = None, *, horizon: int = FORECAST_HORIZON_DAYS) -> dict:
    """Doanh thu từng ngày tới của một cửa hàng (None = toàn chuỗi)."""
    from .series import revenue_series

    retail, wholesale = _split(sales)
    retail_series = revenue_series(retail, as_of, store_code)
    result = forecast_series(retail_series, horizon=horizon)
    if result["status"] != "ok":
        return result
    wholesale_series = revenue_series(wholesale, as_of, store_code) if not wholesale.empty else pd.Series(dtype="float64")
    return _with_wholesale(result, wholesale_series, retail_series.index, float(retail_series.iloc[-7:].sum()))


def forecast_demand(sales: pd.DataFrame, as_of: pd.Timestamp, *, horizon: int = FORECAST_HORIZON_DAYS) -> list[dict]:
    """Nhu cầu (số lượng) từng thuốc ở từng cửa hàng; độ chính xác đo trên TỔNG 7 ngày bán lẻ.

    Bước 5.6: mô hình học máy (ml.py) thách đấu mô hình chọn được; chuỗi nào ML có sai số thấp
    hơn ít nhất ML_MIN_IMPROVEMENT thì dùng dự báo ML, còn lại giữ nguyên.
    """
    from . import ml
    from .series import units_table

    retail, wholesale = _split(sales)
    retail_table = units_table(retail, as_of)
    wholesale_table = units_table(wholesale, as_of) if not wholesale.empty else pd.DataFrame()
    classic = {
        column: forecast_series(
            retail_table[column], horizon=horizon, candidates=("naive", "weekday_mean", "holt_winters"), metric="wape_total"
        )
        for column in retail_table.columns
    }
    challengers: dict = {}
    if ML_ENABLED and ml.available() and any(result["status"] == "ok" for result in classic.values()):
        categories = sales.drop_duplicates("medicine_code").set_index("medicine_code")["category"].to_dict() if "category" in sales.columns else {}
        challengers = ml.ml_demand(retail_table, categories, horizon=horizon)
    rows = []
    for column in retail_table.columns:
        result = classic[column]
        challenger = challengers.get(column)
        if result["status"] == "ok":
            # Mọi chuỗi đều ghi sai số của ML để so (kể cả khi không dùng).
            result = {**result, "ml_wape": None if challenger is None else challenger["wape_total"]}
            if ml.adopt(result, challenger, ML_MIN_IMPROVEMENT):
                result = ml.as_forecast(result, challenger, [point["date"] for point in result["points"]])
        clean = retail_table[column].dropna()
        extra = wholesale_table[column] if column in wholesale_table.columns else pd.Series(dtype="float64")
        result = _with_wholesale(result, extra.fillna(0.0), clean.index, float(clean.iloc[-7:].sum()))
        rows.append({"store_code": column[0], "medicine_code": column[1], **result})
    return rows


# --- Ngày dự kiến hết hàng, gói dự báo (bước 3.5) --------------------------------------------


def stockout_projection(demand: list[dict], stock: pd.DataFrame) -> list[dict]:
    """Cộng dồn nhu cầu dự báo từng ngày; ngày đầu tiên tổng vượt tồn bán được là ngày dự kiến hết hàng.

    Khác "số ngày tồn = tồn / ADS" (bước 2.3): tính được cuối tuần đông khách và xu hướng tăng/giảm.
    `demand`: demand_points của forecast_bundle ({store_code, medicine_code, start, values}).
    `stock`: sellable_stock (store_code, medicine_code, stock_quantity). Quá tầm dự báo thì để trống.
    """
    remaining = {(row.store_code, row.medicine_code): float(row.stock_quantity) for row in stock.itertuples()}
    found = []
    for row in demand:
        key = (row["store_code"], row["medicine_code"])
        if key not in remaining or remaining[key] <= 0:
            continue
        total, date, days = 0.0, None, None
        for index, value in enumerate(row["values"]):
            total += value
            if total >= remaining[key]:
                days = index + 1
                date = (pd.Timestamp(row["start"]) + pd.Timedelta(days=index)).date().isoformat()
                break
        found.append(
            {
                "store_code": key[0],
                "medicine_code": key[1],
                "stock_quantity": remaining[key],
                "stockout_date": date,
                "days_until_stockout": days,
                "horizon_days": len(row["values"]),
            }
        )
    return sorted(found, key=lambda item: (item["days_until_stockout"] is None, item["days_until_stockout"] or 0))


def data_key(sales: pd.DataFrame, as_of: pd.Timestamp) -> str:
    """Dấu vân tay của dữ liệu NGÀY ĐÃ TRỌN: không đổi thì dự báo không đổi, dùng lại bản đã lưu.

    Gồm ngày cuối đã trọn, tổng theo (ngày, cửa hàng, thuốc, loại bán) và tên các mô hình/tham số.
    Thêm hóa đơn trong ngày hôm nay không làm đổi dấu này.
    """
    import hashlib

    from .series import last_complete_day

    end = last_complete_day(as_of)
    complete = sales[sales["sale_datetime"] < as_of.normalize()]
    keys = [complete["sale_datetime"].dt.normalize(), complete["store_code"], complete["medicine_code"]]
    if "sale_type" in complete.columns:
        keys.append(complete["sale_type"])
    totals = complete.groupby(keys)[["quantity", "revenue"]].sum().round(4)
    digest = hashlib.sha256()
    from . import ml

    # Bật/tắt ML hay đổi phiên bản ML cũng làm dấu đổi, để bộ nhớ đệm dự báo tính lại.
    ml_tag = f"{ml.VERSION}:{ML_MIN_IMPROVEMENT}" if ML_ENABLED and ml.available() else "no-ml"
    digest.update(f"{end.date()}|{sorted(MODELS)}|{HW_ALPHAS}{HW_BETAS}{HW_GAMMAS}{HW_DAMPING}|{BACKTEST_FOLDS}|{ml_tag}".encode())
    digest.update(pd.util.hash_pandas_object(totals, index=True).to_numpy().tobytes())
    return digest.hexdigest()


def forecast_bundle(sales: pd.DataFrame, as_of: pd.Timestamp, stores: list[str], *, horizon: int = 30) -> dict:
    """Mọi dự báo cho snapshot: doanh thu từng ngày (toàn chuỗi + từng cửa hàng) và nhu cầu từng thuốc.

    Nhu cầu chỉ giữ tổng 7 / 30 ngày và các con số tóm tắt, không giữ từng ngày (180 chuỗi × 30 ngày quá nặng);
    `demand_points` (ngày đầu + mảng số lượng từng ngày) để tính ngày hết hàng và FEFO theo dự báo.
    """
    from .series import last_complete_day

    revenue = {(store or "ALL"): forecast_revenue(sales, as_of, store, horizon=horizon) for store in [None, *stores]}
    demand_full = forecast_demand(sales, as_of, horizon=horizon)
    demand = []
    for row in demand_full:
        if row["status"] != "ok":
            continue
        values = [point["value"] for point in row["points"]]
        week = sum(values[:7])
        error = row["wape"]
        demand.append(
            {
                "store_code": row["store_code"],
                "medicine_code": row["medicine_code"],
                "model": row["model"],
                "wape_total": error,
                "next_7_days": round(week, 2),
                # Khoảng cho tổng 7 ngày: ± sai số tổng 7 ngày đo bằng backtest.
                "next_7_low": None if error is None else round(max(week * (1 - error), 0.0), 2),
                "next_7_high": None if error is None else round(week * (1 + error), 2),
                "next_30_days": round(sum(values), 2),
                "change_vs_last_7_pct": row["change_vs_last_7_pct"],
                "wholesale_per_day": row.get("wholesale_per_day"),
            }
        )
    return {
        "data_through": last_complete_day(as_of).date().isoformat(),
        "horizon_days": horizon,
        "revenue": revenue,
        "demand": demand,
        "demand_points": [
            {
                "store_code": row["store_code"],
                "medicine_code": row["medicine_code"],
                "start": row["points"][0]["date"],
                "values": [point["value"] for point in row["points"]],
            }
            for row in demand_full
            if row["status"] == "ok"
        ],
    }
