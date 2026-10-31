"""Dự báo nhu cầu bằng học máy, vai trò bên thách đấu (Phase 5, bước 5.6; quyết định D21).

Một mô hình dùng chung cho MỌI chuỗi (cửa hàng × thuốc), dự báo trực tiếp từng ngày tới (h = 1..30)
từ các đặc trưng có tại thời điểm dự báo:

- tỷ lệ so với mức bán 28 ngày gần nhất (không phụ thuộc thuốc bán nhiều hay ít): trung bình 7 ngày,
  trung bình 4 lần cùng thứ gần nhất, lần cùng thứ gần nhất; log mức bán 28 ngày;
- ngày thứ mấy tới (h), thứ trong tuần, ngày lễ, khoảng cách tới Tết; cửa hàng, nhóm thuốc.

Học tỷ lệ y / mức 28 ngày rồi nhân lại: thuốc bán 5 hộp/ngày và 500 viên/ngày cùng học một quy luật
"cuối tuần cao hơn 20%". Đo bằng đúng 4 lần thử như forecast.backtest (mỗi lần 7 ngày), mô hình chỉ
học trên dữ liệu TRƯỚC thời điểm thử. forecast_demand chỉ dùng kết quả ML cho chuỗi nào sai số
thấp hơn mô hình cổ điển ít nhất ML_MIN_IMPROVEMENT; còn lại giữ nguyên.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from app.config import (
    BACKTEST_FOLDS,
    FORECAST_HORIZON_DAYS,
    INTERVAL_QUANTILES,
    MIN_HISTORY_DAYS,
    ML_ORIGIN_STEP,
    ML_TET_WINDOW,
    VN_FIXED_HOLIDAYS,
    VN_TET,
)

MODEL_NAME = "ml_gbm"
MODEL_LABEL = "Học máy (gradient boosting, học chung mọi thuốc)"
# Đổi đặc trưng, tham số thì đổi số này để bộ nhớ đệm dự báo tính lại.
VERSION = "ml1"
_TET = pd.to_datetime(list(VN_TET))


def _nanmean(values: np.ndarray) -> np.ndarray:
    """Trung bình theo cột bỏ NaN; cột toàn NaN (chuỗi chưa bắt đầu bán) ra NaN mà không cảnh báo."""
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmean(values, axis=0)


def available() -> bool:
    try:
        import sklearn  # noqa: F401
    except ImportError:
        return False
    return True


def calendar_features(dates: pd.DatetimeIndex) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(ngày lễ 0/1, số ngày tới mùng 1 Tết gần nhất chặn ±30, thứ trong tuần 0 = thứ Hai) cho từng ngày."""
    days = dates.values.astype("datetime64[D]")
    tet = _TET.values.astype("datetime64[D]")
    distance = (days[:, None] - tet[None, :]).astype(int)
    nearest = distance[np.arange(len(days)), np.abs(distance).argmin(axis=1)]
    fixed = np.isin(dates.strftime("%m-%d"), VN_FIXED_HOLIDAYS)
    holiday = fixed | (np.abs(nearest) <= ML_TET_WINDOW)
    return holiday.astype(float), np.clip(nearest, -30, 30).astype(float), dates.day_of_week.to_numpy(dtype=float)


def _features(table: np.ndarray, origin: int, h: int, store: np.ndarray, category: np.ndarray, calendar) -> np.ndarray:
    """Đặc trưng cho mọi chuỗi, dự báo ngày origin + h - 1 khi chỉ biết dữ liệu trước origin."""
    with np.errstate(invalid="ignore", divide="ignore"):
        level = _nanmean(table[max(0, origin - 28) : origin])
        recent = _nanmean(table[max(0, origin - 7) : origin])
        target = origin + h - 1
        same = [target - 7 * k for k in range(1, 9) if target - 7 * k < origin][:4]
        same = [day for day in same if day >= 0]
        weekday_mean = _nanmean(table[same]) if same else np.full(table.shape[1], np.nan)
        last_same = table[same[0]] if same else np.full(table.shape[1], np.nan)
        base = np.maximum(level, 0.1)
        holiday, tet, weekday = calendar
        columns = [
            np.full(table.shape[1], h, dtype=float),
            np.full(table.shape[1], weekday[target]),
            recent / base,
            weekday_mean / base,
            last_same / base,
            np.log1p(level),
            np.full(table.shape[1], holiday[target]),
            np.full(table.shape[1], tet[target]),
            store,
            category,
        ]
    return np.column_stack(columns)


def _rows(table, origins, horizon, store, category, calendar, history_count, *, limit: int | None = None):
    """Ghép dữ liệu học: (đặc trưng, tỷ lệ mục tiêu, mức 28 ngày) cho các mốc `origins`.

    `limit`: chỉ lấy mục tiêu có chỉ số ngày < limit (không học từ tương lai của lần thử).
    """
    features, targets = [], []
    for origin in origins:
        eligible = history_count[origin] >= MIN_HISTORY_DAYS
        if not eligible.any():
            continue
        level = np.maximum(_nanmean(table[max(0, origin - 28) : origin]), 0.1)
        for h in range(1, horizon + 1):
            target = origin + h - 1
            if target >= table.shape[0] or (limit is not None and target >= limit):
                break
            y = table[target]
            keep = eligible & ~np.isnan(y)
            if not keep.any():
                continue
            features.append(_features(table, origin, h, store, category, calendar)[keep])
            targets.append((y / level)[keep])
    if not features:
        return np.empty((0, 10)), np.empty(0)
    return np.vstack(features), np.concatenate(targets)


def _model():
    from sklearn.ensemble import HistGradientBoostingRegressor

    # Cột 8, 9 là cửa hàng, nhóm thuốc (mã số): để mô hình tách nhánh theo nhóm thay vì coi như số đo.
    return HistGradientBoostingRegressor(
        max_iter=200, learning_rate=0.06, max_leaf_nodes=31, min_samples_leaf=40,
        categorical_features=[8, 9], random_state=0,
    )


def _predict(model, table, origin, horizon, store, category, calendar) -> np.ndarray:
    """Dự báo (horizon × số chuỗi) từ mốc origin."""
    level = np.maximum(_nanmean(table[max(0, origin - 28) : origin]), 0.1)
    out = np.empty((horizon, table.shape[1]))
    for h in range(1, horizon + 1):
        out[h - 1] = np.maximum(model.predict(_features(table, origin, h, store, category, calendar)), 0.0) * level
    return out


def ml_demand(units: pd.DataFrame, categories: dict[str, str], *, horizon: int = 30) -> dict[tuple[str, str], dict]:
    """Dự báo nhu cầu bán lẻ bằng ML cho mọi chuỗi, kèm sai số backtest như forecast.backtest.

    `units`: bảng series.units_table (hàng = ngày đã trọn, cột = (cửa hàng, thuốc), NaN trước lần bán đầu).
    Trả {(cửa hàng, thuốc): {"values": dự báo horizon ngày, "wape_total", "errors", "folds"}}.
    """
    if units.empty or len(units) < MIN_HISTORY_DAYS + FORECAST_HORIZON_DAYS:
        return {}
    table = units.to_numpy(dtype="float64")
    n = table.shape[0]
    columns = list(units.columns)
    store = pd.factorize(pd.Series([column[0] for column in columns]))[0].astype(float)
    category = pd.factorize(pd.Series([categories.get(column[1], "") for column in columns]))[0].astype(float)
    future = pd.date_range(units.index[0], periods=n + horizon, freq="D")
    calendar = calendar_features(future)
    history_count = np.vstack([np.zeros(table.shape[1]), np.cumsum(~np.isnan(table), axis=0)])

    # Backtest: 4 lần thử, mỗi lần học trên mục tiêu trước mốc thử rồi dự báo 7 ngày.
    sums_pred: dict[int, list[float]] = {index: [] for index in range(len(columns))}
    sums_true: dict[int, list[float]] = {index: [] for index in range(len(columns))}
    daily_errors: dict[int, list[np.ndarray]] = {index: [] for index in range(len(columns))}
    for fold in range(BACKTEST_FOLDS, 0, -1):
        origin = n - fold * FORECAST_HORIZON_DAYS
        if origin < MIN_HISTORY_DAYS:
            continue
        x, y = _rows(table, range(MIN_HISTORY_DAYS, origin, ML_ORIGIN_STEP), horizon, store, category, calendar, history_count, limit=origin)
        if len(y) < 200:
            continue
        model = _model().fit(x, y)
        predicted = _predict(model, table, origin, FORECAST_HORIZON_DAYS, store, category, calendar)
        actual = table[origin : origin + FORECAST_HORIZON_DAYS]
        for index in range(len(columns)):
            # Cùng điều kiện với forecast.backtest: chuỗi phải có đủ MIN_HISTORY_DAYS ngày trước mốc.
            if history_count[origin, index] < MIN_HISTORY_DAYS or np.isnan(actual[:, index]).any():
                continue
            sums_pred[index].append(float(predicted[:, index].sum()))
            sums_true[index].append(float(actual[:, index].sum()))
            daily_errors[index].append(predicted[:, index] - actual[:, index])

    x, y = _rows(table, range(MIN_HISTORY_DAYS, n, ML_ORIGIN_STEP), horizon, store, category, calendar, history_count)
    if len(y) < 200:
        return {}
    final = _predict(_model().fit(x, y), table, n, horizon, store, category, calendar)

    results = {}
    for index, column in enumerate(columns):
        total = sum(sums_true[index])
        errors = np.concatenate(daily_errors[index]) if daily_errors[index] else np.empty(0)
        results[column] = {
            "values": final[:, index],
            "folds": len(sums_true[index]),
            "wape_total": None
            if total <= 0
            else round(sum(abs(p - t) for p, t in zip(sums_pred[index], sums_true[index])) / total, 4),
            "errors": errors,
        }
    return results


def adopt(classic: dict, challenger: dict | None, min_improvement: float) -> bool:
    """ML thay mô hình cổ điển khi: cả hai đo trên cùng số lần thử, và sai số ML thấp hơn ít nhất min_improvement."""
    if challenger is None or challenger["wape_total"] is None or not classic.get("accuracy_measured"):
        return False
    folds = (classic.get("scores") or {}).get(classic.get("model"), {}) or {}
    if folds.get("folds") != challenger["folds"]:
        return False
    current = classic.get("wape")
    return current is not None and challenger["wape_total"] < current * (1 - min_improvement)


def as_forecast(classic: dict, challenger: dict, dates: list[str]) -> dict:
    """Kết quả forecast_series (chỉ phần bán lẻ) thay bằng dự báo ML, giữ nguyên dạng."""
    values = challenger["values"]
    errors = challenger["errors"]
    if len(errors):
        low_q, high_q = np.quantile(errors, INTERVAL_QUANTILES)
        lows, highs = np.maximum(values - high_q, 0.0), np.maximum(values - low_q, 0.0)
    else:
        lows = highs = [None] * len(values)
    next_week = float(values[:7].sum())
    last_week = classic.get("last_7_days") or 0.0
    return {
        **classic,
        "model": MODEL_NAME,
        "model_label": MODEL_LABEL,
        "wape": challenger["wape_total"],
        "scores": {**classic.get("scores", {}), MODEL_NAME: {"folds": challenger["folds"], "wape_total": challenger["wape_total"]}},
        "errors": errors.round(2).tolist(),
        "points": [
            {
                "date": day,
                "value": round(float(value), 2),
                "low": None if low is None else round(float(low), 2),
                "high": None if high is None else round(float(high), 2),
            }
            for day, value, low, high in zip(dates, values, lows, highs)
        ],
        "total": round(float(values.sum()), 2),
        "change_vs_last_7_pct": None if last_week <= 0 else round((next_week - last_week) / last_week * 100, 1),
    }
