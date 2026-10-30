"""Cảnh báo theo luật (Phase 2, bước 2.5; master prompt §18).

Đọc kết quả đã tính của KPI, tồn kho, hạn dùng; mỗi luật thỏa thì sinh MỘT
cảnh báo có mức độ và một câu tiếng Việt kèm con số. Không tính thêm số liệu
nào, không gọi LLM: câu chữ là khuôn cố định, số lấy thẳng từ kết quả.

    critical  lô đã hết hạn còn trong kho (GPP: phải tách khỏi khu bán)
    high      hàng có nguy cơ hết hạn trước khi bán kịp (FEFO); hết hàng
    medium    lô hết hạn trong 30 ngày; sắp hết hàng; bất thường giảm (doanh thu, lượng bán)
    low       tồn chết; tệp dữ liệu có dòng bị loại; bất thường tăng vọt; tồn kho tăng bất thường
"""

from __future__ import annotations

from typing import Literal

from app.config import ANOMALY_ALERT_DAYS, EXPIRY_WARNING_DAYS, SALES_LOOKBACK_DAYS

Severity = Literal["critical", "high", "medium", "low"]
SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def _money(value: float | None) -> str:
    if value is None:
        return ""
    if abs(value) >= 1_000_000:
        return f"{value / 1_000_000:,.1f} triệu đ".replace(",", "_").replace(".", ",").replace("_", ".")
    return f"{value:,.0f} đ".replace(",", ".")


def _alert(code: str, severity: Severity, title: str, *, section: str, count: int | None = None, value: float | None = None, items: list[str] | None = None) -> dict:
    return {
        "code": code,
        "severity": severity,
        "title": title,
        # Khối trên Dashboard nơi xem chi tiết: inventory, expiry, anomalies, data_quality.
        "section": section,
        "count": count,
        "value": value,
        "items": items or [],
    }


def _names(rows: list[dict], limit: int = 3) -> list[str]:
    """Vài tên tiêu biểu kèm cửa hàng, ví dụ 'Siro ho Prospan 100ml (CH02)'."""
    names = []
    for row in rows[:limit]:
        name = row.get("medicine_name") or row["medicine_code"]
        names.append(f"{name} ({row['store_code']})")
    return names


def build_alerts(
    inventory: dict,
    expiry: dict,
    data_quality: dict | None = None,
    anomalies: list[dict] | None = None,
) -> list[dict]:
    """Cảnh báo của một phạm vi. data_quality chỉ truyền cho toàn chuỗi (lỗi tính trên cả tệp)."""
    alerts: list[dict] = []

    if expiry.get("available") and expiry.get("levels"):
        lots = expiry["lots"]
        expired = [lot for lot in lots if lot["level"] == "expired"]
        if expired:
            value = expiry["levels"]["expired"]["value"]
            alerts.append(
                _alert(
                    "expired_in_stock",
                    "critical",
                    f"{len(expired)} lô đã hết hạn vẫn còn trong kho{f' ({_money(value)})' if value else ''}: tách khỏi khu bán",
                    section="expiry",
                    count=len(expired),
                    value=value,
                    items=_names(expired),
                )
            )
        risk = expiry["at_risk"]
        if risk and risk["lots"]:
            alerts.append(
                _alert(
                    "expiry_risk",
                    "high",
                    f"{risk['lots']} lô khó bán kịp trước hạn dùng"
                    f"{f', có thể mất {_money(risk['value'])}' if risk['value'] else ''}",
                    section="expiry",
                    count=risk["lots"],
                    value=risk["value"],
                    items=_names(expiry["risk_lots"]),
                )
            )
        soon = [lot for lot in lots if 0 <= lot["days_left"] <= EXPIRY_WARNING_DAYS]
        if soon:
            alerts.append(
                _alert(
                    "expiring_soon",
                    "medium",
                    f"{len(soon)} lô thuốc hết hạn trong {EXPIRY_WARNING_DAYS} ngày tới: ưu tiên bán trước (FEFO)",
                    section="expiry",
                    count=len(soon),
                    items=_names(soon),
                )
            )

    if inventory.get("available"):
        items = inventory["items"]
        for status, severity, text in (
            ("out_of_stock", "high", "sản phẩm đã hết hàng nhưng vẫn có khách mua trong 30 ngày qua"),
            ("low", "medium", "sản phẩm sắp hết hàng: cần nhập thêm"),
        ):
            found = [item for item in items if item["status"] == status]
            if found:
                alerts.append(_alert(status, severity, f"{len(found)} {text}", section="inventory", count=len(found), items=_names(found)))
        dead = [item for item in items if item["status"] == "dead"]
        if dead:
            value = inventory["summary"]["dead"]["stock_value"]
            alerts.append(
                _alert(
                    "dead_stock",
                    "low",
                    f"{len(dead)} sản phẩm không bán được trong {SALES_LOOKBACK_DAYS} ngày"
                    f"{f', đọng {_money(value)} tiền vốn' if value else ''}",
                    section="inventory",
                    count=len(dead),
                    value=value,
                    items=_names(dead),
                )
            )

    # Bất thường (bước 3.3): đã gộp bằng chứng và gộp đợt; pipeline chỉ truyền đợt mới (ANOMALY_ALERT_DAYS ngày).
    events = anomalies or []
    for direction, severity, text in (
        ("down", "medium", "bất thường giảm (doanh thu, lượng bán tụt so với mức thường)"),
        ("up", "low", "bất thường tăng vọt (doanh thu, lượng bán)"),
    ):
        found = [event for event in events if event["direction"] == direction and event["kind"] != "stock_jump"]
        if found:
            alerts.append(
                _alert(
                    f"anomaly_{direction}",
                    severity,
                    f"{len(found)} {text} trong {ANOMALY_ALERT_DAYS} ngày qua",
                    section="anomalies",
                    count=len(found),
                    items=[event["short"] for event in found[:3]],
                )
            )
    jumps = [event for event in events if event["kind"] == "stock_jump"]
    if jumps:
        alerts.append(
            _alert(
                "stock_jump",
                "low",
                f"{len(jumps)} sản phẩm có tồn kho tăng bất thường giữa hai lần lưu tệp: kiểm tra lại số nhập",
                section="inventory",
                count=len(jumps),
                items=[event["short"] for event in jumps[:3]],
            )
        )

    if data_quality:
        rejected = sum(part["rows_rejected"] for part in data_quality.values())
        if rejected:
            files = ", ".join(part["file"] for part in data_quality.values() if part["rows_rejected"])
            alerts.append(
                _alert(
                    "data_errors",
                    "low",
                    f"{rejected} dòng dữ liệu bị loại vì lỗi ({files}): số liệu có thể thiếu",
                    section="data_quality",
                    count=rejected,
                )
            )

    return sorted(alerts, key=lambda alert: SEVERITY_ORDER[alert["severity"]])
