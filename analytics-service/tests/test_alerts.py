"""Kiểm thử cảnh báo theo luật (bước 2.5). Đầu vào dựng tay theo đúng khuôn kết quả 2.3, 2.4."""

from __future__ import annotations

from app.analytics.alerts import build_alerts


def kpi(growth: float | None = None, previous_orders: int = 40) -> dict:
    return {"periods": {"day": {"growth": {"revenue": growth}, "previous_same_span": {"orders": previous_orders}}}}


def lot(code: str, days_left: int, level: str, store: str = "CH01") -> dict:
    return {"medicine_code": code, "medicine_name": f"Thuốc {code}", "store_code": store, "days_left": days_left, "level": level}


EXPIRY = {
    "available": True,
    "levels": {"expired": {"lots": 1, "value": 43_062}, "critical": {"lots": 1}, "warning": {"lots": 1}},
    "lots": [lot("OLD", -5, "expired"), lot("NEAR", 5, "critical", "CH02"), lot("MID", 20, "warning"), lot("LATER", 60, "monitor")],
    "at_risk": {"lots": 1, "quantity": 61, "value": 4_431_572},
    "risk_lots": [lot("NEAR", 5, "critical", "CH02")],
}


def item(code: str, status: str, store: str = "CH01") -> dict:
    return {"medicine_code": code, "medicine_name": f"Thuốc {code}", "store_code": store, "status": status}


INVENTORY = {
    "available": True,
    "items": [item("A", "out_of_stock"), item("B", "low"), item("C", "low", "CH02"), item("D", "dead"), item("E", "normal")],
    "summary": {"dead": {"stock_value": 2_613_819}},
}

QUALITY = {
    "sales": {"file": "sales.xlsx", "rows_rejected": 10},
    "inventory": {"file": "inventory.xlsx", "rows_rejected": 0},
}


def test_every_rule_and_order_by_severity():
    alerts = build_alerts(kpi(-22.4), INVENTORY, EXPIRY, QUALITY)
    assert [(alert["code"], alert["severity"], alert["count"]) for alert in alerts] == [
        ("expired_in_stock", "critical", 1),
        ("expiry_risk", "high", 1),
        ("out_of_stock", "high", 1),
        ("expiring_soon", "medium", 2),  # 5 và 20 ngày; 60 ngày chưa tính
        ("low", "medium", 2),
        ("revenue_drop", "medium", None),
        ("dead_stock", "low", 1),
        ("data_errors", "low", 10),
    ]


def test_titles_carry_numbers_from_results():
    alerts = {alert["code"]: alert for alert in build_alerts(kpi(-22.4), INVENTORY, EXPIRY, QUALITY)}
    assert alerts["expired_in_stock"]["title"] == "1 lô đã hết hạn vẫn còn trong kho (43.062 đ): tách khỏi khu bán"
    assert alerts["expiry_risk"]["title"] == "1 lô khó bán kịp trước hạn dùng, có thể mất 4,4 triệu đ"
    assert alerts["expiry_risk"]["items"] == ["Thuốc NEAR (CH02)"]
    assert alerts["low"]["items"] == ["Thuốc B (CH01)", "Thuốc C (CH02)"]
    assert alerts["revenue_drop"]["title"] == "Doanh thu hôm nay giảm 22% so với hôm qua cùng giờ"
    assert alerts["dead_stock"]["title"] == "1 sản phẩm không bán được trong 30 ngày, đọng 2,6 triệu đ tiền vốn"
    assert alerts["data_errors"]["title"] == "10 dòng dữ liệu bị loại vì lỗi (sales.xlsx): số liệu có thể thiếu"


def test_revenue_drop_needs_size_and_depth():
    assert not build_alerts(kpi(-19.9), INVENTORY | {"available": False}, {"available": False})
    assert not build_alerts(kpi(-50.0, previous_orders=9), {"available": False}, {"available": False})  # hôm qua quá ít đơn
    assert not build_alerts(kpi(None), {"available": False}, {"available": False})  # hôm qua bằng 0: không tính được %
    assert build_alerts(kpi(-20.0), {"available": False}, {"available": False})[0]["code"] == "revenue_drop"


def test_nothing_to_report():
    calm_inventory = {"available": True, "items": [item("E", "normal")], "summary": {"dead": {"stock_value": 0}}}
    calm_expiry = {"available": True, "levels": {"expired": {"lots": 0, "value": 0}}, "lots": [], "at_risk": {"lots": 0}, "risk_lots": []}
    assert build_alerts(kpi(5.0), calm_inventory, calm_expiry, {"sales": {"file": "sales.xlsx", "rows_rejected": 0}}) == []
