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

from app.config import BACKTEST_FOLDS, FLAT_MEAN_DAYS, FORECAST_HORIZON_DAYS, MIN_HISTORY_DAYS, WEEKDAY_MEAN_WEEKS

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


MODELS: dict[str, Model] = {"naive": naive, "weekday_mean": weekday_mean, "flat_mean": flat_mean}
MODEL_LABELS = {
    "naive": "Lặp lại tuần trước",
    "weekday_mean": f"Trung bình {WEEKDAY_MEAN_WEEKS} tuần theo thứ",
    "flat_mean": f"Trung bình {FLAT_MEAN_DAYS} ngày",
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
        "points": [{"date": day.date().isoformat(), "value": round(float(value), 2)} for day, value in zip(dates, predicted)],
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
    points = [{**point, "value": round(point["value"] + per_day, 2)} for point in result["points"]]
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
    """Nhu cầu (số lượng) từng thuốc ở từng cửa hàng; độ chính xác đo trên TỔNG 7 ngày bán lẻ."""
    from .series import units_table

    retail, wholesale = _split(sales)
    retail_table = units_table(retail, as_of)
    wholesale_table = units_table(wholesale, as_of) if not wholesale.empty else pd.DataFrame()
    rows = []
    for column in retail_table.columns:
        series = retail_table[column]
        result = forecast_series(series, horizon=horizon, candidates=("naive", "weekday_mean"), metric="wape_total")
        clean = series.dropna()
        extra = wholesale_table[column] if column in wholesale_table.columns else pd.Series(dtype="float64")
        result = _with_wholesale(result, extra.fillna(0.0), clean.index, float(clean.iloc[-7:].sum()))
        rows.append({"store_code": column[0], "medicine_code": column[1], **result})
    return rows
