"""Kiểm thử cảnh báo theo luật (bước 2.5). Đầu vào dựng tay theo đúng khuôn kết quả 2.3, 2.4."""

from __future__ import annotations

from app.analytics.alerts import build_alerts


def event(kind: str, direction: str, short: str) -> dict:
    return {"kind": kind, "direction": direction, "short": short}


ANOMALIES = [
    event("revenue_drop_day", "down", "CH01 · doanh thu · 20/10 −79%"),
    event("medicine_drop", "down", "CH02 · Amoxicillin 500mg · 23/10–29/10 −78%"),
    event("medicine_spike", "up", "CH02 · Khẩu trang y tế 4 lớp · 24/10–25/10 +515%"),
    event("stock_jump", "up", "CH01 · Losartan 50mg · 30/10 +1100%"),
]


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
    alerts = build_alerts(INVENTORY, EXPIRY, QUALITY, ANOMALIES)
    assert [(alert["code"], alert["severity"], alert["count"]) for alert in alerts] == [
        ("expired_in_stock", "critical", 1),
        ("expiry_risk", "high", 1),
        ("out_of_stock", "high", 1),
        ("expiring_soon", "medium", 2),  # 5 và 20 ngày; 60 ngày chưa tính
        ("low", "medium", 2),
        ("anomaly_down", "medium", 2),
        ("dead_stock", "low", 1),
        ("anomaly_up", "low", 1),  # tồn tăng vọt tách riêng, không tính là "bán tăng vọt"
        ("stock_jump", "low", 1),
        ("data_errors", "low", 10),
    ]


def test_titles_carry_numbers_from_results():
    alerts = {alert["code"]: alert for alert in build_alerts(INVENTORY, EXPIRY, QUALITY, ANOMALIES)}
    assert alerts["expired_in_stock"]["title"] == "1 lô đã hết hạn vẫn còn trong kho (43.062 đ): tách khỏi khu bán"
    assert alerts["expiry_risk"]["title"] == "1 lô khó bán kịp trước hạn dùng, có thể mất 4,4 triệu đ"
    assert alerts["expiry_risk"]["items"] == ["Thuốc NEAR (CH02)"]
    assert alerts["low"]["items"] == ["Thuốc B (CH01)", "Thuốc C (CH02)"]
    assert alerts["anomaly_down"]["title"] == "2 bất thường giảm (doanh thu, lượng bán tụt so với mức thường) trong 7 ngày qua"
    assert alerts["anomaly_down"]["items"] == ["CH01 · doanh thu · 20/10 −79%", "CH02 · Amoxicillin 500mg · 23/10–29/10 −78%"]
    assert (alerts["anomaly_down"]["section"], alerts["stock_jump"]["section"]) == ("anomalies", "inventory")
    assert alerts["dead_stock"]["title"] == "1 sản phẩm không bán được trong 30 ngày, đọng 2,6 triệu đ tiền vốn"
    assert alerts["data_errors"]["title"] == "10 dòng dữ liệu bị loại vì lỗi (sales.xlsx): số liệu có thể thiếu"


def test_nothing_to_report():
    calm_inventory = {"available": True, "items": [item("E", "normal")], "summary": {"dead": {"stock_value": 0}}}
    calm_expiry = {"available": True, "levels": {"expired": {"lots": 0, "value": 0}}, "lots": [], "at_risk": {"lots": 0}, "risk_lots": []}
    assert build_alerts(calm_inventory, calm_expiry, {"sales": {"file": "sales.xlsx", "rows_rejected": 0}}, []) == []
