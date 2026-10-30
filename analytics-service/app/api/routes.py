"""Analytics API (FastAPI): cửa sổ CHỈ ĐỌC nhìn vào Analytics Store.

Dashboard và AI Agent lấy số liệu qua đây; không ai đọc thẳng SQLite hay tệp
Excel. Mỗi endpoint về sau là một "tool" của AI Agent. Không endpoint nào ghi
dữ liệu, không endpoint nào gọi LLM.

Mọi phản hồi có `version` và `as_of`: biết số liệu tính đến lúc nào.
Tài liệu tự sinh: http://127.0.0.1:8000/docs
"""

from __future__ import annotations

import threading
from datetime import date, datetime
from typing import Annotated, Any, Literal

import pandas as pd
from fastapi import FastAPI, HTTPException, Query

from app.analytics.daily import align_start, default_range, trend_from_daily
from app.config import TIMEZONE
from app.store import AnalyticsStore

PeriodParam = Literal["day", "week", "month"]
GrainParam = Literal["day", "week", "month"]
BreakdownParam = Literal["category", "sale_type", "store", "payment_method", "top_medicines"]
# Trên URL là ?store=CH01; trong Python đặt tên store_code để không trùng đối tượng Store.
StoreParam = Annotated[str, Query(alias="store", description="Mã cửa hàng, hoặc ALL cho toàn chuỗi", max_length=20)]

REVENUE_FIELDS = ("revenue", "orders", "units", "avg_order_value")
PROFIT_FIELDS = ("revenue", "cogs", "profit", "margin_pct", "cost_coverage_pct")


class SnapshotReader:
    """Giữ bản snapshot đã giải mã trong bộ nhớ; chỉ đọc lại SQLite khi version tăng."""

    def __init__(self, store: AnalyticsStore):
        self.store = store
        self._lock = threading.Lock()
        self._version: int | None = None
        self._payload: dict[str, Any] | None = None

    def get(self) -> dict[str, Any]:
        version = self.store.latest_version()
        if version is None:
            raise HTTPException(503, "Chưa có dữ liệu: pipeline chưa chạy thành công lần nào")
        with self._lock:
            if version != self._version:
                self._payload = self.store.latest_snapshot()
                self._version = version
            return self._payload  # type: ignore[return-value]


def _meta(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {"version": snapshot["version"], "as_of": snapshot["as_of"]}


def _store_kpi(snapshot: dict[str, Any], store: str) -> dict[str, Any]:
    key = store.upper()
    if key not in snapshot["kpi"]:
        raise HTTPException(404, f"Không có cửa hàng {store}. Có: ALL, {', '.join(snapshot['stores'])}")
    return snapshot["kpi"][key]


def _pick(values: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    return {field: values.get(field) for field in fields}


def create_app(store: AnalyticsStore, monitor=None, *, lifespan=None) -> FastAPI:  # noqa: ANN001
    app = FastAPI(
        title="Pharmacy Intelligent Analytics API",
        description="Số liệu kinh doanh nhà thuốc đã tính sẵn. Chỉ đọc, không gọi LLM.",
        version="1.6.0",
        lifespan=lifespan,
    )
    reader = SnapshotReader(store)
    started_at = datetime.now(TIMEZONE)

    @app.get("/api/analytics/version", tags=["Hệ thống"], summary="Version snapshot hiện tại (rẻ, để polling)")
    def version() -> dict[str, Any]:
        meta = store.latest_snapshot_meta()
        if meta is None:
            return {"version": None, "as_of": None, "created_at": None}
        return {"version": meta["version"], "as_of": meta["as_of"], "created_at": meta["created_at"]}

    @app.get("/api/analytics/health", tags=["Hệ thống"], summary="Tình trạng Monitor, pipeline, snapshot")
    def health() -> dict[str, Any]:
        meta = store.latest_snapshot_meta()
        runs = store.recent_runs(1)
        age = None
        if meta:
            created = datetime.fromisoformat(meta["created_at"])
            age = round((datetime.now(TIMEZONE) - created).total_seconds())
        monitor_info = None
        if monitor is not None:
            stats = monitor.stats
            monitor_info = {
                "folder": str(monitor.folder),
                "events": stats.events,
                "runs": stats.runs,
                "last_latency_ms": stats.last_latency_ms,
            }
        last_run = runs[0] if runs else None
        healthy = meta is not None and (last_run is None or last_run["status"] == "success")
        return {
            "status": "ok" if healthy else "degraded",
            "started_at": started_at.isoformat(timespec="seconds"),
            "snapshot": {**meta, "age_seconds": age} if meta else None,
            "last_run": last_run and {
                key: last_run[key] for key in ("id", "finished_at", "status", "trigger", "duration_ms", "error_message")
            },
            "monitor": monitor_info,
        }

    @app.get("/api/analytics/summary", tags=["KPI"], summary="Thẻ KPI: hôm nay, tuần này, tháng này")
    def summary(store_code: StoreParam = "ALL") -> dict[str, Any]:
        snapshot = reader.get()
        kpi = _store_kpi(snapshot, store_code)
        return {
            **_meta(snapshot),
            "store": store_code.upper(),
            "stores": snapshot["stores"],
            "periods": kpi["periods"],
            "data_quality": snapshot["data_quality"],
        }

    def _period_view(store_code: str, period: PeriodParam, fields: tuple[str, ...]) -> dict[str, Any]:
        snapshot = reader.get()
        data = _store_kpi(snapshot, store_code)["periods"][period]
        return {
            **_meta(snapshot),
            "store": store_code.upper(),
            "period": period,
            "label": data["label"],
            "previous_label": data["previous_label"],
            "current_window": data["current_window"],
            "previous_window": data["previous_window"],
            "current": _pick(data["current"], fields),
            "previous_same_span": _pick(data["previous_same_span"], fields),
            "previous_full": _pick(data["previous_full"], fields),
            "growth": {field: data["growth"].get(field) for field in fields if field in data["growth"]},
        }

    @app.get("/api/analytics/revenue", tags=["KPI"], summary="Doanh thu, số đơn, giá trị đơn và tăng trưởng")
    def revenue(period: PeriodParam = "day", store_code: StoreParam = "ALL") -> dict[str, Any]:
        return _period_view(store_code, period, REVENUE_FIELDS)

    @app.get("/api/analytics/profit", tags=["KPI"], summary="Giá vốn, lợi nhuận, biên lợi nhuận")
    def profit(period: PeriodParam = "month", store_code: StoreParam = "ALL") -> dict[str, Any]:
        return _period_view(store_code, period, PROFIT_FIELDS)

    @app.get("/api/analytics/sales-trend", tags=["Biểu đồ"], summary="Chuỗi doanh thu theo ngày/tuần/tháng")
    def sales_trend(
        grain: GrainParam = "day",
        store_code: StoreParam = "ALL",
        start: date | None = Query(None, description="Từ ngày (YYYY-MM-DD); mặc định 30 ngày / 12 tuần / 12 tháng gần nhất"),
        end: date | None = Query(None, description="Đến ngày (gồm cả ngày này); mặc định ngày tính snapshot"),
    ) -> dict[str, Any]:
        snapshot = reader.get()
        _store_kpi(snapshot, store_code)  # kiểm tra mã cửa hàng
        today = pd.Timestamp(snapshot["as_of"]).date()
        default_start, default_end = default_range(grain, today)
        start, end = align_start(start or default_start, grain), end or default_end
        if start > end:
            raise HTTPException(422, "start phải trước hoặc bằng end")
        if (end - start).days > 3 * 366:
            raise HTTPException(422, "Khoảng thời gian tối đa 3 năm")
        store_filter = None if store_code.upper() == "ALL" else store_code.upper()
        rows = store.daily_kpis(store_filter, start.isoformat(), (pd.Timestamp(end) + pd.Timedelta(days=1)).date().isoformat())
        return {
            **_meta(snapshot),
            "store": store_code.upper(),
            "grain": grain,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "points": trend_from_daily(rows, grain, start, end, as_of=today),
        }

    @app.get("/api/analytics/breakdown", tags=["Biểu đồ"], summary="Cơ cấu doanh thu tháng này (toàn chuỗi)")
    def breakdown(by: BreakdownParam = "category") -> dict[str, Any]:
        snapshot = reader.get()
        window = snapshot["kpi"]["ALL"]["periods"]["month"]["current_window"]
        return {**_meta(snapshot), "by": by, "window": window, "rows": snapshot["breakdown_month"][by]}

    @app.get("/api/analytics/data-quality", tags=["Dữ liệu"], summary="Lỗi dữ liệu của lần đọc tệp gần nhất")
    def data_quality(limit: int = Query(200, ge=1, le=5000)) -> dict[str, Any]:
        snapshot = reader.get()
        latest = store.latest_issues()
        return {
            **_meta(snapshot),
            "checked_at": latest["checked_at"],
            "summary": snapshot["data_quality"],
            "total": len(latest["issues"]),
            "issues": latest["issues"][:limit],
        }

    @app.get("/api/analytics/runs", tags=["Hệ thống"], summary="Nhật ký các lần chạy pipeline")
    def runs(limit: int = Query(20, ge=1, le=200)) -> dict[str, Any]:
        return {"runs": store.recent_runs(limit)}

    return app
