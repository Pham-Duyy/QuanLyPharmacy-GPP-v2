"""Kiểm thử ML bên thách đấu (bước 5.6). Phần cần scikit-learn tự bỏ qua khi chưa cài."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

import app.analytics.forecast as forecast
from app.analytics import ml

needs_sklearn = pytest.mark.skipif(not ml.available(), reason="chưa cài scikit-learn (requirements-ml.txt)")


def test_calendar_features_holidays_tet_weekday():
    days = pd.DatetimeIndex(["2026-02-17", "2026-02-21", "2026-02-24", "2026-09-02", "2026-10-26"])
    holiday, tet, weekday = ml.calendar_features(days)
    # Mùng 1 Tết 2026 là 17/02; ±5 ngày là ngày lễ; 02/09 lễ cố định; 26/10 thường.
    assert holiday.tolist() == [1.0, 1.0, 0.0, 1.0, 0.0]
    assert tet[:3].tolist() == [0.0, 4.0, 7.0]
    assert tet[4] == -30.0  # xa Tết: chặn ở ±30
    assert weekday.tolist() == [1.0, 5.0, 1.0, 2.0, 0.0]  # 0 = thứ Hai


def test_adopt_only_when_clearly_better_on_the_same_folds():
    classic = {"accuracy_measured": True, "model": "holt_winters", "wape": 0.30, "scores": {"holt_winters": {"folds": 4}}}
    better = {"wape_total": 0.26, "folds": 4}
    assert ml.adopt(classic, better, 0.10)  # 0,26 < 0,30 × 0,9 = 0,27
    assert not ml.adopt(classic, {"wape_total": 0.28, "folds": 4}, 0.10)  # tốt hơn nhưng chưa đủ 10%
    assert not ml.adopt(classic, {"wape_total": 0.10, "folds": 3}, 0.10)  # đo trên số lần thử khác
    assert not ml.adopt({**classic, "accuracy_measured": False}, better, 0.10)
    assert not ml.adopt(classic, None, 0.10)


def _weekly_table(series: int = 12, days: int = 84, seed: int = 0) -> pd.DataFrame:
    """Nhiều chuỗi cùng quy luật: cuối tuần bán gấp rưỡi, mức bán khác nhau giữa các chuỗi."""
    rng = np.random.default_rng(seed)
    index = pd.date_range("2026-08-01", periods=days, freq="D")
    pattern = np.where(index.day_of_week >= 5, 1.5, 1.0)
    columns = pd.MultiIndex.from_tuples([(f"CH0{i % 3 + 1}", f"T{i:02d}") for i in range(series)])
    data = {column: rng.poisson(pattern * (5 + 10 * k)).astype(float) for k, column in enumerate(columns)}
    return pd.DataFrame(data, index=index)


def test_training_rows_never_use_targets_after_the_fold_origin():
    table = _weekly_table()
    values = table.to_numpy()
    store = np.zeros(values.shape[1])
    category = np.zeros(values.shape[1])
    calendar = ml.calendar_features(pd.date_range(table.index[0], periods=len(table) + 30, freq="D"))
    count = np.vstack([np.zeros(values.shape[1]), np.cumsum(~np.isnan(values), axis=0)])
    origin = 60
    limited = ml._rows(values, range(28, origin, 2), 30, store, category, calendar, count, limit=origin)
    # Xóa mọi dữ liệu từ mốc thử trở đi: kết quả phải y hệt (không có gì rò từ tương lai).
    cut = values.copy()
    cut[origin:] = 999.0
    leaked = ml._rows(cut, range(28, origin, 2), 30, store, category, calendar, count, limit=origin)
    assert np.array_equal(limited[0], leaked[0]) and np.array_equal(limited[1], leaked[1])


@needs_sklearn
def test_ml_learns_a_shared_weekly_pattern():
    result = ml.ml_demand(_weekly_table(), {}, horizon=14)
    assert len(result) == 12
    row = result[("CH01", "T00")]
    assert row["folds"] == 4 and len(row["values"]) == 14 and (row["values"] >= 0).all()
    # Chuỗi lớn (mức 115/ngày): sai số tổng 7 ngày chỉ là nhiễu Poisson, dưới 10%.
    assert result[("CH03", "T11")]["wape_total"] < 0.10


def _sales(days: int = 70) -> pd.DataFrame:
    rows = []
    for day in range(1, days + 1):
        at = pd.Timestamp("2026-10-29 09:00") - pd.Timedelta(days=day)
        rows.append({"sale_datetime": at, "sale_type": "retail", "store_code": "CH01", "medicine_code": "A",
                     "quantity": 10.0, "revenue": 10_000.0, "category": "Nhóm"})
        rows.append({"sale_datetime": at, "sale_type": "wholesale", "store_code": "CH01", "medicine_code": "A",
                     "quantity": 2.0, "revenue": 2_000.0, "category": "Nhóm"})
    return pd.DataFrame(rows)


def test_forecast_uses_ml_only_when_it_wins(monkeypatch):
    as_of = pd.Timestamp("2026-10-29 12:00")
    monkeypatch.setattr(forecast, "ML_ENABLED", True)
    monkeypatch.setattr(ml, "available", lambda: True)

    def challenger(wape):
        return lambda *args, **kwargs: {
            ("CH01", "A"): {"values": np.full(7, 13.0), "wape_total": wape, "folds": 4, "errors": np.zeros(28)}
        }

    # Chuỗi đều 10/ngày: mô hình cổ điển sai số 0 → ML không thể thắng.
    monkeypatch.setattr(ml, "ml_demand", challenger(0.05))
    row = forecast.forecast_demand(_sales(), as_of, horizon=7)[0]
    assert row["model"] != ml.MODEL_NAME and row["ml_wape"] == 0.05

    # Giả cổ điển sai số 30% còn ML 5%: dùng ML; bán buôn trung bình (2/ngày) vẫn cộng vào.
    real = forecast.forecast_series

    def worse(*args, **kwargs):
        result = real(*args, **kwargs)
        return {**result, "wape": 0.30}

    monkeypatch.setattr(forecast, "forecast_series", worse)
    row = forecast.forecast_demand(_sales(), as_of, horizon=7)[0]
    assert row["model"] == ml.MODEL_NAME and row["wape"] == 0.05
    assert [point["value"] for point in row["points"]] == [15.0] * 7
    assert row["scores"][ml.MODEL_NAME] == {"folds": 4, "wape_total": 0.05}


def test_ml_off_by_default_is_never_called(monkeypatch):
    monkeypatch.setattr(forecast, "ML_ENABLED", False)

    def boom(*args, **kwargs):
        raise AssertionError("ML không được chạy khi đang tắt")

    monkeypatch.setattr(ml, "ml_demand", boom)
    rows = forecast.forecast_demand(_sales(), pd.Timestamp("2026-10-29 12:00"), horizon=7)
    assert rows[0]["status"] == "ok" and "ml_wape" in rows[0] and rows[0]["ml_wape"] is None
