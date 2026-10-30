"""Kiểm thử Analytics API (bước 1.6) bằng TestClient của FastAPI (gọi trong bộ nhớ)."""

from __future__ import annotations

from datetime import datetime

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.pipeline import Pipeline
from app.store import AnalyticsStore

AS_OF = pd.Timestamp("2026-10-29 12:00")  # thứ Năm

MEDICINES = [
    {"medicine_code": "GD001", "medicine_name": "Paracetamol 500mg", "category": "Giảm đau", "unit": "Viên"},
    {"medicine_code": "KS001", "medicine_name": "Amoxicillin 500mg", "category": "Kháng sinh", "unit": "Viên"},
]


def sale(sale_id, at, code="GD001", quantity=10, price=1_200, cost=800, store="CH01") -> dict:
    return {
        "sale_id": sale_id,
        "line_no": 1,
        "sale_datetime": datetime.fromisoformat(at),
        "sale_type": "retail",
        "store_code": store,
        "medicine_code": code,
        "quantity": quantity,
        "selling_price": price,
        "purchase_price": cost,
    }


SALES = [
    sale("HD1", "2026-10-29 09:00"),  # hôm nay CH01: 12.000
    sale("HD2", "2026-10-28 10:00", code="KS001", quantity=2, price=5_000, cost=3_500, store="CH02"),  # 10.000
    sale("HD3", "2026-10-20 08:00", quantity=5),  # thứ Hai tuần trước: 6.000
    sale("HD4", "2026-09-15 08:00", quantity=20),  # tháng trước: 24.000
    sale("HD5", "2026-10-21 08:00", quantity=0),  # lỗi: số lượng 0
]


@pytest.fixture
def workspace(tmp_path):
    folder = tmp_path / "inbox"
    folder.mkdir()
    pd.DataFrame(MEDICINES).to_excel(folder / "medicines.xlsx", index=False)
    pd.DataFrame(SALES).to_excel(folder / "sales.xlsx", index=False)
    store = AnalyticsStore(tmp_path / "analytics.db")
    return folder, store


@pytest.fixture
def client(workspace):
    folder, store = workspace
    Pipeline(folder, store).run(as_of=AS_OF)
    return TestClient(create_app(store))


def test_before_first_snapshot(workspace):
    _, store = workspace
    client = TestClient(create_app(store))
    assert client.get("/api/analytics/version").json() == {"version": None, "as_of": None, "created_at": None}
    response = client.get("/api/analytics/summary")
    assert response.status_code == 503
    assert "Chưa có dữ liệu" in response.json()["detail"]
    assert client.get("/api/analytics/health").json()["status"] == "degraded"


def test_version_and_health(client):
    assert client.get("/api/analytics/version").json()["version"] == 1
    health = client.get("/api/analytics/health").json()
    assert health["status"] == "ok"
    assert health["last_run"]["status"] == "success"
    assert health["snapshot"]["version"] == 1
    assert health["monitor"] is None  # chạy API không kèm Monitor


def test_summary_matches_snapshot(client, workspace):
    _, store = workspace
    body = client.get("/api/analytics/summary").json()
    snapshot = store.latest_snapshot()
    assert body["version"] == 1
    assert body["stores"] == ["CH01", "CH02"]
    assert body["periods"] == snapshot["kpi"]["ALL"]["periods"]
    assert body["periods"]["day"]["current"]["revenue"] == 12_000
    assert body["data_quality"]["sales"]["rows_rejected"] == 1


def test_store_filter_is_case_insensitive_and_validated(client):
    assert client.get("/api/analytics/summary", params={"store": "ch02"}).json()["periods"]["week"]["current"]["revenue"] == 10_000
    response = client.get("/api/analytics/summary", params={"store": "CH99"})
    assert response.status_code == 404
    assert "CH01, CH02" in response.json()["detail"]


def test_revenue_and_profit_views(client):
    week = client.get("/api/analytics/revenue", params={"period": "week"}).json()
    assert set(week["current"]) == {"revenue", "orders", "units", "avg_order_value"}
    assert week["current"]["revenue"] == 22_000  # HD1 + HD2
    assert week["previous_same_span"]["revenue"] == 6_000  # HD3, thứ Hai tuần trước
    assert week["growth"]["revenue"] == 266.7

    month = client.get("/api/analytics/profit", params={"period": "month"}).json()
    assert set(month["current"]) == {"revenue", "cogs", "profit", "margin_pct", "cost_coverage_pct"}
    assert month["current"]["profit"] == 9_000  # (12.000 − 8.000) + (10.000 − 7.000) + (6.000 − 4.000)
    assert "profit" in month["growth"]

    assert client.get("/api/analytics/revenue", params={"period": "year"}).status_code == 422


def test_daily_trend_defaults_to_30_days_and_flags_today(client):
    body = client.get("/api/analytics/sales-trend").json()
    points = body["points"]
    assert (body["start"], body["end"], len(points)) == ("2026-09-30", "2026-10-29", 30)
    assert points[-1] == {
        "period_start": "2026-10-29",
        "revenue": 12_000,
        "cogs": 8_000,
        "profit": 4_000,
        "margin_pct": 33.33,
        "orders": 1,
        "units": 10,
        "partial": True,
    }
    assert sum(point["revenue"] for point in points) == 28_000  # tháng 9 nằm ngoài 30 ngày
    assert not any(point["partial"] for point in points[:-1])


def test_weekly_trend_starts_on_monday(client):
    body = client.get("/api/analytics/sales-trend", params={"grain": "week", "start": "2026-10-22"}).json()
    # 22/10 là thứ Năm: lùi về thứ Hai 19/10 để tuần đầu đủ 7 ngày.
    assert body["start"] == "2026-10-19"
    assert [(point["period_start"], point["revenue"], point["partial"]) for point in body["points"]] == [
        ("2026-10-19", 6_000, False),
        ("2026-10-26", 22_000, True),
    ]


def test_monthly_trend_for_one_store(client):
    body = client.get("/api/analytics/sales-trend", params={"grain": "month", "store": "CH01"}).json()
    by_month = {point["period_start"]: point["revenue"] for point in body["points"]}
    assert len(body["points"]) == 12
    assert by_month["2026-09-01"] == 24_000
    assert by_month["2026-10-01"] == 18_000


def test_trend_rejects_bad_ranges(client):
    assert client.get("/api/analytics/sales-trend", params={"start": "2026-10-10", "end": "2026-10-01"}).status_code == 422
    assert client.get("/api/analytics/sales-trend", params={"start": "2020-01-01"}).status_code == 422
    assert client.get("/api/analytics/sales-trend", params={"start": "không phải ngày"}).status_code == 422


def test_breakdown_and_data_quality(client):
    rows = client.get("/api/analytics/breakdown", params={"by": "category"}).json()["rows"]
    assert [(row["label"], row["revenue"]) for row in rows] == [("Giảm đau", 18_000), ("Kháng sinh", 10_000)]
    assert client.get("/api/analytics/breakdown", params={"by": "supplier"}).status_code == 422

    quality = client.get("/api/analytics/data-quality").json()
    assert quality["total"] == 1
    assert quality["issues"][0]["code"] == "non_positive_quantity"
    assert quality["issues"][0]["row"] == 6


def test_new_snapshot_is_served_without_restart(workspace):
    folder, store = workspace
    pipeline = Pipeline(folder, store)
    pipeline.run(as_of=AS_OF)
    client = TestClient(create_app(store))
    assert client.get("/api/analytics/summary").json()["periods"]["day"]["current"]["revenue"] == 12_000

    pd.DataFrame([*SALES, sale("HD9", "2026-10-29 10:00", quantity=1)]).to_excel(folder / "sales.xlsx", index=False)
    pipeline.run(as_of=AS_OF + pd.Timedelta(minutes=1))

    body = client.get("/api/analytics/summary").json()
    assert body["version"] == 2
    assert body["periods"]["day"]["current"]["revenue"] == 13_200


def test_api_is_read_only(client):
    """Không endpoint nào ghi dữ liệu: nguyên tắc an toàn cho AI Agent sau này."""
    methods = {
        method
        for route in client.app.routes
        if getattr(route, "path", "").startswith("/api/")
        for method in getattr(route, "methods", set())
    }
    assert methods <= {"GET", "HEAD"}
