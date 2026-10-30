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


# --- Phase 2: sản phẩm, tồn kho, hạn dùng, cảnh báo (bước 2.5) --------------------------

INVENTORY = [
    # Paracetamol CH01: 30 ngày bán 15 viên (HD1 10 + HD3 5) → ADS 0,5; tồn 3 viên đủ 6 ngày: sắp hết; còn 5 ngày hạn → bán kịp.
    {"store_code": "CH01", "medicine_code": "GD001", "batch_code": "PA1", "quantity": 3, "expiry_date": datetime(2026, 11, 3), "purchase_price": 800},
    {"store_code": "CH01", "medicine_code": "GD001", "batch_code": "PA0", "quantity": 10, "expiry_date": datetime(2026, 10, 1), "purchase_price": 800},
    # Amoxicillin CH02: có tồn nhưng 30 ngày chỉ bán 2 viên → còn 20 ngày, nguy cơ.
    {"store_code": "CH02", "medicine_code": "KS001", "batch_code": "AM1", "quantity": 100, "expiry_date": datetime(2026, 11, 18), "purchase_price": 3_500},
]


@pytest.fixture
def stocked(workspace):
    folder, store = workspace
    pd.DataFrame(INVENTORY).to_excel(folder / "inventory.xlsx", index=False)
    Pipeline(folder, store).run(as_of=AS_OF)
    return TestClient(create_app(store))


def test_alerts_and_overview(stocked):
    alerts = stocked.get("/api/analytics/alerts").json()["alerts"]
    codes = [alert["code"] for alert in alerts]
    assert codes[0] == "expired_in_stock"  # nặng nhất trước
    assert {"expiry_risk", "expiring_soon", "data_errors"} <= set(codes)
    assert [alert["code"] for alert in stocked.get("/api/analytics/alerts", params={"store": "ch02"}).json()["alerts"]] == [
        "expiry_risk",
        "expiring_soon",
    ]

    overview = stocked.get("/api/analytics/summary").json()["overview"]
    assert overview["inventory_available"] is True
    assert (overview["expired_lots"], overview["expiring_30d_lots"]) == (1, 2)
    assert overview["alerts"]["critical"] == 1


def test_inventory_and_expiry_filters(stocked):
    inventory = stocked.get("/api/analytics/inventory", params={"store": "CH02"}).json()
    assert inventory["available"] is True
    assert [(item["medicine_code"], item["status"]) for item in inventory["items"]] == [("KS001", "high")]
    low = stocked.get("/api/analytics/inventory", params={"status": "low"}).json()["items"]
    assert [(item["store_code"], item["medicine_code"], item["days_of_cover"]) for item in low] == [("CH01", "GD001", 6.0)]
    assert stocked.get("/api/analytics/inventory", params={"status": "nhieu"}).status_code == 422

    expiry = stocked.get("/api/analytics/expiry", params={"level": "expired"}).json()
    assert [lot["batch_code"] for lot in expiry["lots"]] == ["PA0"]
    # PA1 (3 viên, còn 5 ngày): theo trung bình 30 ngày (0,5 viên/ngày) thì bán kịp; nhưng từ bước 3.5
    # FEFO dùng tốc độ bán DỰ BÁO, và tuần vừa qua CH01 không bán Paracetamol nào: dự báo ~0, lô có nguy cơ.
    assert [lot["batch_code"] for lot in expiry["risk_lots"]] == ["AM1", "PA1"]
    assert expiry["rate_source"] == "forecast"
    assert expiry["risk_lots"][0]["at_risk_quantity"] == 99  # 20 ngày × 2/30 viên/ngày ≈ 1 viên bán kịp


def test_products_endpoint(stocked):
    body = stocked.get("/api/analytics/products", params={"period": "week"}).json()
    assert [row["medicine_code"] for row in body["revenue"]] == ["GD001", "KS001"]
    assert body["stock"]["basis"] == "inventory"
    assert stocked.get("/api/analytics/products", params={"store": "CH99"}).status_code == 404


def test_without_inventory_file_sections_say_unavailable(client):
    assert client.get("/api/analytics/inventory").json()["available"] is False
    assert client.get("/api/analytics/expiry").json()["available"] is False
    assert client.get("/api/analytics/summary").json()["overview"]["inventory_available"] is False
    assert client.get("/api/analytics/products").json()["stock"]["basis"] == "sales_history"


def test_anomalies_and_forecast_endpoints(stocked):
    body = stocked.get("/api/analytics/anomalies", params={"days": 60}).json()
    assert {"events", "since", "version"} <= set(body)
    assert stocked.get("/api/analytics/anomalies", params={"direction": "sideways"}).status_code == 422

    revenue = stocked.get("/api/analytics/forecast").json()
    assert revenue["target"] == "revenue"
    assert revenue["data_through"] == "2026-10-28"
    assert revenue["revenue"]["status"] == "ok" or "message" in revenue["revenue"]

    demand = stocked.get("/api/analytics/forecast", params={"target": "demand", "store": "CH02"}).json()
    assert all(row["store_code"] == "CH02" for row in demand["demand"] + demand["stockout"])
    assert stocked.get("/api/analytics/forecast", params={"target": "weather"}).status_code == 422


def test_classification_and_reorder_endpoints(stocked):
    abc = stocked.get("/api/analytics/classification").json()
    assert {"summary", "matrix", "items", "window", "version"} <= set(abc)
    assert {item["medicine_code"] for item in abc["items"]} == {"GD001", "KS001"}
    only_a = stocked.get("/api/analytics/classification", params={"abc": "A"}).json()["items"]
    assert only_a and all(item["abc"] == "A" for item in only_a)
    assert stocked.get("/api/analytics/classification", params={"abc": "D"}).status_code == 422

    # CH01 Paracetamol còn 6 ngày bán (sắp hết), CH02 không có Paracetamol để chuyển: phải mua.
    plan = stocked.get("/api/analytics/reorder", params={"store": "ch01"}).json()
    assert plan["available"] is True and plan["store"] == "CH01"
    assert plan["data_source"] == "files"
    row = next(item for item in plan["items"] if item["medicine_code"] == "GD001")
    assert row["action"] == "order" and row["order_quantity"] > 0
    assert stocked.get("/api/analytics/reorder", params={"action": "transfer"}).json()["items"] == []
    assert stocked.get("/api/analytics/reorder", params={"store": "CH99"}).status_code == 404
    assert stocked.get("/api/analytics/reorder", params={"action": "steal"}).status_code == 422


def test_reorder_without_inventory_file(client):
    assert client.get("/api/analytics/reorder").json()["available"] is False
