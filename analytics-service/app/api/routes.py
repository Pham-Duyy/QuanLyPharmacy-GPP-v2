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
StockStatusParam = Literal["out_of_stock", "low", "dead", "high", "normal"]
ExpiryLevelParam = Literal["expired", "critical", "warning", "monitor"]
ForecastTargetParam = Literal["revenue", "demand"]
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


def _section(snapshot: dict[str, Any], name: str, store: str) -> Any:
    """Khối Phase 2 của một phạm vi. Snapshot tạo trước bản 2.5 chưa có: chờ lần tính kế tiếp (≤ 5 phút)."""
    _store_kpi(snapshot, store)  # kiểm tra mã cửa hàng
    if name not in snapshot:
        raise HTTPException(503, "Snapshot được tạo trước khi có phân tích tồn kho: chờ lần tính kế tiếp")
    return snapshot[name][store.upper()]


def _overview(snapshot: dict[str, Any], store: str) -> dict[str, Any] | None:
    """Vài con số tồn kho, hạn dùng, cảnh báo cho thẻ KPI của Dashboard."""
    if "inventory" not in snapshot:
        return None
    key = store.upper()
    stock, expiry, alerts = snapshot["inventory"][key], snapshot["expiry"][key], snapshot["alerts"][key]
    severities = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    for alert in alerts:
        severities[alert["severity"]] += 1
    overview: dict[str, Any] = {"stock_as_of": snapshot.get("stock_as_of"), "inventory_available": stock["available"], "alerts": severities}
    if stock["available"]:
        summary = stock["summary"]
        overview.update(
            total_stock_value=stock["total_stock_value"],
            out_of_stock=summary["out_of_stock"]["count"],
            low_stock=summary["low"]["count"],
            dead_stock=summary["dead"]["count"],
        )
    if expiry.get("available") and expiry.get("levels"):
        levels = expiry["levels"]
        overview.update(
            expired_lots=levels["expired"]["lots"],
            expiring_30d_lots=levels["critical"]["lots"] + levels["warning"]["lots"],
            at_risk_value=expiry["at_risk"]["value"],
        )
    return overview


def _pick(values: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    return {field: values.get(field) for field in fields}


def create_app(store: AnalyticsStore, monitor=None, *, lifespan=None) -> FastAPI:  # noqa: ANN001
    app = FastAPI(
        title="Pharmacy Intelligent Analytics API",
        description="Số liệu kinh doanh nhà thuốc đã tính sẵn. Chỉ đọc, không gọi LLM.",
        version="2.5.0",
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
            "overview": _overview(snapshot, store_code),
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

    @app.get("/api/analytics/products", tags=["Sản phẩm"], summary="Xếp hạng sản phẩm, bán chậm, không bán được")
    def products(period: PeriodParam = "month", store_code: StoreParam = "ALL") -> dict[str, Any]:
        snapshot = reader.get()
        data = _section(snapshot, "products", store_code)
        return {**_meta(snapshot), "store": store_code.upper(), **data["periods"][period], "stock": data["stock"]}

    @app.get("/api/analytics/inventory", tags=["Tồn kho"], summary="Tồn kho: hết hàng, sắp hết, tồn chết, tồn cao")
    def inventory(
        store_code: StoreParam = "ALL",
        status: StockStatusParam | None = Query(None, description="Chỉ lấy một trạng thái"),
    ) -> dict[str, Any]:
        snapshot = reader.get()
        data = _section(snapshot, "inventory", store_code)
        if data["available"] and status:
            data = {**data, "items": [item for item in data["items"] if item["status"] == status]}
        return {**_meta(snapshot), **data}

    @app.get("/api/analytics/expiry", tags=["Tồn kho"], summary="Hạn dùng 5 mức, FEFO, hàng có nguy cơ hết hạn")
    def expiry(
        store_code: StoreParam = "ALL",
        level: ExpiryLevelParam | None = Query(None, description="Chỉ lấy lô ở một mức"),
    ) -> dict[str, Any]:
        snapshot = reader.get()
        data = _section(snapshot, "expiry", store_code)
        if data.get("lots") and level:
            data = {**data, "lots": [lot for lot in data["lots"] if lot["level"] == level]}
        return {**_meta(snapshot), **data}

    @app.get("/api/analytics/alerts", tags=["Cảnh báo"], summary="Cảnh báo theo luật, nặng nhất trước")
    def alerts(store_code: StoreParam = "ALL") -> dict[str, Any]:
        snapshot = reader.get()
        return {**_meta(snapshot), "store": store_code.upper(), "alerts": _section(snapshot, "alerts", store_code)}

    @app.get("/api/analytics/anomalies", tags=["Bất thường, dự báo"], summary="Bất thường: luật R1–R3 + Z-score, đã gộp đợt")
    def anomalies(
        store_code: StoreParam = "ALL",
        days: int = Query(14, ge=1, le=60, description="Đợt kết thúc trong ngần này ngày gần nhất"),
        direction: Literal["down", "up"] | None = Query(None, description="Chỉ tụt (down) hoặc tăng vọt (up)"),
    ) -> dict[str, Any]:
        snapshot = reader.get()
        events = _section(snapshot, "anomalies", store_code)
        since = (pd.Timestamp(snapshot["as_of"]).normalize() - pd.Timedelta(days=days)).date().isoformat()
        events = [event for event in events if event["end"] >= since and (direction is None or event["direction"] == direction)]
        return {**_meta(snapshot), "store": store_code.upper(), "since": since, "events": events}

    @app.get("/api/analytics/forecast", tags=["Bất thường, dự báo"], summary="Dự báo doanh thu 30 ngày, nhu cầu thuốc, ngày hết hàng")
    def forecast(store_code: StoreParam = "ALL", target: ForecastTargetParam = "revenue") -> dict[str, Any]:
        snapshot = reader.get()
        _store_kpi(snapshot, store_code)
        block = snapshot.get("forecast")
        if not block:
            raise HTTPException(503, "Snapshot chưa có dự báo: chờ lần tính kế tiếp")
        key = store_code.upper()
        meta = {**_meta(snapshot), "store": key, "target": target, "data_through": block["data_through"]}
        if target == "revenue":
            return {**meta, "horizon_days": block["horizon_days"], "revenue": block["revenue"].get(key)}
        rows = block["demand"] if key == "ALL" else [row for row in block["demand"] if row["store_code"] == key]
        stockout = block["stockout"] if key == "ALL" else [row for row in block["stockout"] if row["store_code"] == key]
        return {**meta, "demand": rows, "stockout": stockout}

    @app.get("/api/analytics/classification", tags=["Đặt hàng, ABC"], summary="Phân loại ABC–XYZ: đóng góp doanh thu, độ ổn định nhu cầu")
    def classification(
        store_code: StoreParam = "ALL",
        abc: Literal["A", "B", "C"] | None = Query(None, description="Chỉ một nhóm ABC"),
        xyz: Literal["X", "Y", "Z"] | None = Query(None, description="Chỉ một nhóm XYZ"),
    ) -> dict[str, Any]:
        snapshot = reader.get()
        if "classification" not in snapshot:
            raise HTTPException(503, "Snapshot chưa có phân loại ABC–XYZ: chờ lần tính kế tiếp")
        data = _section(snapshot, "classification", store_code)
        items = [item for item in data["items"] if (abc is None or item["abc"] == abc) and (xyz is None or item["xyz"] == xyz)]
        return {**_meta(snapshot), **data, "items": items}

    @app.get("/api/analytics/reorder", tags=["Đặt hàng, ABC"], summary="Gợi ý đặt hàng theo dự báo và chuyển hàng giữa cửa hàng")
    def reorder(
        store_code: StoreParam = "ALL",
        action: Literal["order", "transfer"] | None = Query(None, description="Chỉ dòng phải mua (order) hoặc có chuyển (transfer)"),
    ) -> dict[str, Any]:
        snapshot = reader.get()
        _store_kpi(snapshot, store_code)
        if "reorder" not in snapshot:
            raise HTTPException(503, "Snapshot chưa có gợi ý đặt hàng: chờ lần tính kế tiếp")
        key = store_code.upper()
        plans = snapshot["reorder"]
        # Nguồn PostgreSQL (bước 5.5): mã cửa hàng, mã thuốc trùng phần mềm, trang Đề xuất đặt hàng ghép được.
        sales_name = str(snapshot.get("source", {}).get("sales", {}).get("name", ""))
        data_source = "files" if sales_name.lower().endswith((".xlsx", ".csv")) else "postgres"
        # Cửa hàng không có dòng nào trong tệp tồn: không có gì để gợi ý (không phải lỗi).
        data = plans.get(key) or {**plans["ALL"], "store": key, "lines": 0, "items": [], "transfers": []}
        if not data.get("available"):
            return {**_meta(snapshot), "store": key, "data_source": data_source, "available": False, "items": [], "transfers": []}
        items = data["items"]
        if action == "order":
            items = [item for item in items if item["order_quantity"] > 0]
        elif action == "transfer":
            items = [item for item in items if item["transfer_quantity"] > 0]
        return {**_meta(snapshot), **data, "data_source": data_source, "items": items}

    @app.get("/api/analytics/runs", tags=["Hệ thống"], summary="Nhật ký các lần chạy pipeline")
    def runs(limit: int = Query(20, ge=1, le=200)) -> dict[str, Any]:
        return {"runs": store.recent_runs(limit)}

    return app
