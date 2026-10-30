"""Điểm chạy của analytics-service.

Lệnh hiện có:
- process: xử lý một thư mục dữ liệu, in báo cáo chất lượng dữ liệu (bước 1.2)
- kpi:     tính chỉ số kinh doanh hôm nay / tuần này / tháng này (bước 1.3)
- run:     chạy pipeline Processor → KPI → lưu snapshot vào SQLite (bước 1.4)
- status:  xem các lần chạy gần nhất và snapshot hiện tại (bước 1.4)
- watch:   tự theo dõi thư mục, tệp được lưu thì tự chạy pipeline (bước 1.5)
- serve:   chạy Analytics API + Monitor trong cùng một tiến trình (bước 1.6)
Các bước sau sẽ thêm `serve` (API + theo dõi tệp).

Chạy:  python main.py process                  (mặc định: data/samples)
       python main.py process data/inbox --issues-csv data/reports/issues.csv
       python main.py kpi --as-of "2026-10-30 18:00" --store CH01
       python main.py run             (chạy lại ngay: thêm --force)
       python main.py status
       python main.py watch           (theo dõi data/inbox; Ctrl+C để dừng)
       python main.py serve           (API ở http://127.0.0.1:8000/docs + Monitor)
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import pandas as pd

from app.analytics import kpi_summary, prepare_sales, sales_breakdown
from app.analytics.periods import Window
from app.config import ANALYTICS_DB, INBOX_DIR, MONITOR_DEBOUNCE_SECONDS, MONITOR_POLL_SECONDS, SAMPLES_DIR, TIMEZONE
from app.logging_setup import setup_logging
from app.monitor import Monitor
from app.pipeline import Pipeline
from app.store import AnalyticsStore
from app.processor import LoadError, ProcessResult, process_folder
from app.processor.service import now_local

# Windows PowerShell mặc định không in được tiếng Việt có dấu nếu không đổi bảng mã.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def print_report(result: ProcessResult, max_issues: int) -> None:
    print(f"\n=== {result.file} ({result.dataset}) ===")
    print(
        f"Đọc {result.rows_read:,} dòng | hợp lệ {result.rows_valid:,} | loại {result.rows_rejected:,} "
        f"| {result.error_count} lỗi, {result.warning_count} cảnh báo | {result.duration_ms} ms"
    )
    if not result.issues:
        print("Không phát hiện vấn đề nào.")
        return
    print("Theo loại:", ", ".join(f"{code}={count}" for code, count in result.issue_summary().items()))
    for issue in result.issues[:max_issues]:
        where = f"dòng {issue.row}" if issue.row else "cả tệp"
        value = f" (giá trị: {issue.value!r})" if issue.value is not None else ""
        label = "LỖI" if issue.severity == "error" else "Cảnh báo"
        print(f"  [{label}] {where}, cột {issue.column}: {issue.message}{value}")
    if len(result.issues) > max_issues:
        print(f"  … và {len(result.issues) - max_issues} vấn đề khác (dùng --issues-csv để xem hết)")


def command_process(args: argparse.Namespace) -> int:
    try:
        results = process_folder(args.folder)
    except (LoadError, FileNotFoundError) as error:
        print(f"Không xử lý được: {error}", file=sys.stderr)
        return 1
    for result in results.values():
        print_report(result, args.max_issues)
    if args.issues_csv:
        rows = [issue.to_dict() | {"file": result.file} for result in results.values() for issue in result.issues]
        args.issues_csv.parent.mkdir(parents=True, exist_ok=True)
        pd.DataFrame(rows).to_csv(args.issues_csv, index=False, encoding="utf-8-sig")
        print(f"\nĐã ghi danh sách vấn đề ra {args.issues_csv}")
    return 0


def _money(value: float | None) -> str:
    return "—" if value is None else f"{value:,.0f} đ".replace(",", ".")


def _number(value: float, digits: int = 0) -> str:
    """Kiểu Việt Nam: 4.844 và 20,7."""
    return f"{value:,.{digits}f}".replace(",", "_").replace(".", ",").replace("_", ".")


def _growth(value: float | None) -> str:
    return "  —   " if value is None else f"{value:+.1f}%".replace(".", ",")


def command_kpi(args: argparse.Namespace) -> int:
    try:
        results = process_folder(args.folder)
    except (LoadError, FileNotFoundError) as error:
        print(f"Không xử lý được: {error}", file=sys.stderr)
        return 1
    medicines = results["medicines"].data if "medicines" in results else None
    sales = prepare_sales(results["sales"].data, medicines)
    as_of = pd.Timestamp(args.as_of) if args.as_of else now_local()
    summary = kpi_summary(sales, as_of, args.store)
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    scope = f"cửa hàng {args.store}" if args.store else "toàn chuỗi"
    print(f"\nKPI {scope}, tính đến {as_of:%d/%m/%Y %H:%M} (bỏ {results['sales'].rows_rejected} dòng lỗi)")
    for period in summary["periods"].values():
        current, previous, growth = period["current"], period["previous_same_span"], period["growth"]
        print(f"\n--- {period['label']} (so với {period['previous_label'].lower()} cùng thời điểm) ---")
        print(f"  Doanh thu     {_money(current['revenue']):>20}   {_growth(growth['revenue'])}   (kỳ trước {_money(previous['revenue'])})")
        print(f"  Giá vốn       {_money(current['cogs']):>20}")
        print(f"  Lợi nhuận     {_money(current['profit']):>20}   {_growth(growth['profit'])}")
        margin = current["margin_pct"]
        print(f"  Biên lợi nhuận{'—' if margin is None else _number(margin, 1) + '%':>20}")
        print(f"  Số đơn        {_number(current['orders']):>20}   {_growth(growth['orders'])}")
        print(f"  Số lượng bán  {_number(current['units']):>20}   {_growth(growth['units'])}")
        print(f"  Giá trị/đơn   {_money(current['avg_order_value']):>20}   {_growth(growth['avg_order_value'])}")
        if current["cost_coverage_pct"] is not None and current["cost_coverage_pct"] < 100:
            print(f"  (Chỉ {current['cost_coverage_pct']}% doanh thu có giá vốn: lợi nhuận tính trên phần đó)")

    month = Window(pd.Timestamp(summary["periods"]["month"]["current_window"]["start"]), as_of)
    scoped = sales if not args.store else sales[sales["store_code"] == args.store]
    print("\n--- Tháng này theo nhóm thuốc ---")
    for row in sales_breakdown(scoped, month, "category"):
        print(
            f"  {row['label']:<22} {_money(row['revenue']):>18}  {_number(row['share_pct'], 1):>5}%"
            f"  biên {'—' if row['margin_pct'] is None else _number(row['margin_pct'], 1) + '%'}"
        )
    if not args.store:
        print("\n--- Tháng này theo cửa hàng ---")
        for row in sales_breakdown(scoped, month, "store_code"):
            print(f"  {row['label']:<22} {_money(row['revenue']):>18}  {_number(row['share_pct'], 1):>5}%")
    return 0


def command_products(args: argparse.Namespace) -> int:
    """Phân tích sản phẩm (bước 2.2): xếp hạng theo kỳ và hàng bán chậm, không bán được."""
    from app.analytics.products import RANKING_LABELS, product_analysis

    try:
        results = process_folder(args.folder)
    except (LoadError, FileNotFoundError) as error:
        print(f"Không xử lý được: {error}", file=sys.stderr)
        return 1
    medicines = results["medicines"].data if "medicines" in results else None
    inventory = results["inventory"].data if "inventory" in results else None
    sales = prepare_sales(results["sales"].data, medicines)
    as_of = pd.Timestamp(args.as_of) if args.as_of else now_local()
    store = args.store.upper() if args.store else None
    analysis = product_analysis(sales, inventory, medicines, as_of, store, limit=args.top)
    if args.json:
        print(json.dumps(analysis, ensure_ascii=False, indent=2))
        return 0

    scope = f"cửa hàng {store}" if store else "toàn chuỗi"
    period = analysis["periods"][args.period]
    print(f"\nSản phẩm {scope}, {period['label'].lower()}, tính đến {as_of:%d/%m/%Y %H:%M}")
    for key in ("revenue", "profit"):
        print(f"\n--- {RANKING_LABELS[key]} ---")
        for index, row in enumerate(period[key], start=1):
            print(f"  {index:>2}. {row['medicine_name'] or row['medicine_code']:<34} {_money(row[key]):>16}  biên {_margin(row['margin_pct'])}")
    print(f"\n--- {RANKING_LABELS['low_profit']} ---")
    for index, row in enumerate(period["low_profit"], start=1):
        print(f"  {index:>2}. {row['medicine_name'] or row['medicine_code']:<34} biên {_margin(row['margin_pct']):>6}  lợi nhuận {_money(row['profit'])}")
    print(f"\n--- {RANKING_LABELS['declining']} (so với {period['previous_label'].lower()} cùng thời điểm) ---")
    if not period["declining"]:
        print("  Không có thuốc nào giảm")
    for index, row in enumerate(period["declining"], start=1):
        print(
            f"  {index:>2}. {row['medicine_name'] or row['medicine_code']:<34} {_growth(row['growth_pct'])}"
            f"  {_money(row['previous_revenue'])} → {_money(row['revenue'])}"
        )

    stock = analysis["stock"]
    basis = "thuốc còn tồn" if stock["basis"] == "inventory" else "thuốc từng bán (chưa có tệp tồn kho)"
    print(f"\n--- {RANKING_LABELS['slow']}, xét {basis} ---")
    for index, row in enumerate(stock["slow"], start=1):
        print(f"  {index:>2}. {row['medicine_name'] or row['medicine_code']:<34} {_money(row['revenue']):>14}  {_number(row['orders'])} đơn")
    print(f"\n--- {RANKING_LABELS['not_sold']}: {stock['not_sold_total']} thuốc ---")
    for index, row in enumerate(stock["not_sold"], start=1):
        last = "chưa bán bao giờ" if row["last_sale"] is None else f"bán lần cuối {row['days_since_sale']} ngày trước"
        held = "" if row["stock_quantity"] is None else f", còn {_number(row['stock_quantity'])} (vốn {_money(row['stock_value'])})"
        print(f"  {index:>2}. {row['medicine_name'] or row['medicine_code']:<34} {last}{held}")
    return 0


def _margin(value: float | None) -> str:
    return "—" if value is None else _number(value, 1) + "%"


def command_abc(args: argparse.Namespace) -> int:
    """Phân loại ABC–XYZ (bước 5.1): thuốc nào đem lại doanh thu, nhu cầu đều hay thất thường."""
    from app.analytics.classify import XYZ_LABELS, classify

    try:
        results = process_folder(args.folder)
    except (LoadError, FileNotFoundError) as error:
        print(f"Không xử lý được: {error}", file=sys.stderr)
        return 1
    medicines = results["medicines"].data if "medicines" in results else None
    inventory = results["inventory"].data if "inventory" in results else None
    sales = prepare_sales(results["sales"].data, medicines)
    as_of = pd.Timestamp(args.as_of) if args.as_of else now_local()
    store = args.store.upper() if args.store and args.store.upper() != "ALL" else None
    result = classify(sales, inventory, medicines, as_of, store)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    scope = f"cửa hàng {store}" if store else "toàn chuỗi"
    window = result["window"]
    print(f"\nABC–XYZ {scope}: doanh thu {window['start']} → {window['end']}, nhu cầu bán lẻ {result['weeks']} tuần")
    for group, part in result["summary"].items():
        print(f"  {group}: {part['count']:>3} thuốc  {_money(part['revenue']):>18}  {_number(part['share_pct'], 1):>5}% doanh thu")
    print("\n       X ổn định   Y dao động  Z thất thường")
    for abc in ("A", "B", "C"):
        cells = [result["matrix"][f"{abc}{xyz}"] for xyz in ("X", "Y", "Z")]
        print(f"  {abc}  " + "".join(f"{cell['count']:>4} ({_number(cell['service_level'] * 100, 0)}%)  " for cell in cells))
    if result["unclassified_xyz"]:
        print(f"  Chưa xếp XYZ (dưới vài tuần bán hoặc không bán): {result['unclassified_xyz']}")
    print()
    for item in result["items"][: args.top]:
        xyz = XYZ_LABELS.get(item["xyz"] or "", "chưa xếp")
        cv = "—" if item["cv"] is None else _number(item["cv"], 2)
        print(
            f"  {item['cell']:<3} {item['medicine_name'] or item['medicine_code']:<34}"
            f" {_money(item['revenue']):>16}  cộng dồn {_number(item['cumulative_pct'], 1):>5}%  CV {cv:>5} {xyz}"
        )
    if len(result["items"]) > args.top:
        print(f"  … và {len(result['items']) - args.top} thuốc khác")
    return 0


def command_inventory(args: argparse.Namespace) -> int:
    """Tình trạng tồn kho (bước 2.3): hết hàng, sắp hết, tồn chết, tồn cao."""
    from app.analytics.inventory import STATUS_LABELS, inventory_analysis
    from app.processor import INVENTORY
    from app.processor.service import find_file

    try:
        results = process_folder(args.folder)
    except (LoadError, FileNotFoundError) as error:
        print(f"Không xử lý được: {error}", file=sys.stderr)
        return 1
    if "inventory" not in results:
        print(f"Chưa có inventory.xlsx hoặc inventory.csv trong {args.folder}", file=sys.stderr)
        return 1
    medicines = results["medicines"].data if "medicines" in results else None
    sales = prepare_sales(results["sales"].data, medicines)
    as_of = pd.Timestamp(args.as_of) if args.as_of else now_local()
    saved = pd.Timestamp(find_file(args.folder, INVENTORY).stat().st_mtime, unit="s", tz="UTC").tz_convert(TIMEZONE).tz_localize(None)
    store = args.store.upper() if args.store else None
    analysis = inventory_analysis(sales, results["inventory"].data, medicines, as_of, store, stock_as_of=saved)
    if args.json:
        print(json.dumps(analysis, ensure_ascii=False, indent=2))
        return 0

    scope = f"cửa hàng {store}" if store else "mọi cửa hàng"
    print(f"\nTồn kho {scope}: số tồn theo tệp lưu lúc {saved:%H:%M %d/%m/%Y}, tốc độ bán 30 ngày đến {as_of:%d/%m/%Y %H:%M}")
    print(f"Tổng giá trị tồn bán được: {_money(analysis['total_stock_value'])}")
    for status, part in analysis["summary"].items():
        print(f"  {part['label']:<12} {part['count']:>4} mặt hàng   {_money(part['stock_value']):>18}")
    wanted = [args.status] if args.status else ["out_of_stock", "low", "dead", "high"]
    for status in wanted:
        items = [item for item in analysis["items"] if item["status"] == status]
        print(f"\n--- {STATUS_LABELS[status]}: {len(items)} ---")
        for item in items[: args.top]:
            cover = "—" if item["days_of_cover"] is None else f"{_number(item['days_of_cover'], 1)} ngày"
            last = "" if status != "dead" else (
                "  chưa bán bao giờ" if item["last_sale"] is None else f"  bán lần cuối {item['days_since_sale']} ngày trước"
            )
            print(
                f"  {item['store_code']} {item['medicine_name'] or item['medicine_code']:<34}"
                f" tồn {_number(item['stock_quantity']):>7}  bán {_number(item['ads'], 1):>6}/ngày  đủ {cover:>10}{last}"
            )
        if len(items) > args.top:
            print(f"  … và {len(items) - args.top} mặt hàng khác")
    return 0


def command_expiry(args: argparse.Namespace) -> int:
    """Hạn dùng 5 mức và FEFO (bước 2.4): lô hết hạn, sắp hết hạn, hàng có nguy cơ không kịp bán."""
    from app.analytics.expiry import expiry_analysis

    try:
        results = process_folder(args.folder)
    except (LoadError, FileNotFoundError) as error:
        print(f"Không xử lý được: {error}", file=sys.stderr)
        return 1
    if "inventory" not in results:
        print(f"Chưa có inventory.xlsx hoặc inventory.csv trong {args.folder}", file=sys.stderr)
        return 1
    medicines = results["medicines"].data if "medicines" in results else None
    sales = prepare_sales(results["sales"].data, medicines)
    as_of = pd.Timestamp(args.as_of) if args.as_of else now_local()
    store = args.store.upper() if args.store else None
    analysis = expiry_analysis(sales, results["inventory"].data, medicines, as_of, store)
    if args.json:
        print(json.dumps(analysis, ensure_ascii=False, indent=2))
        return 0

    scope = f"cửa hàng {store}" if store else "mọi cửa hàng"
    print(f"\nHạn dùng {scope}, tính ngày {as_of:%d/%m/%Y}")
    for level in analysis["levels"].values():
        print(f"  {level['label']:<24} {level['lots']:>4} lô  {_money(level['value']):>18}")
    risk = analysis["at_risk"]
    print(f"\nCó nguy cơ hết hạn trước khi bán kịp (theo FEFO): {risk['lots']} lô, {_number(risk['quantity'])} đơn vị, {_money(risk['value'])}")
    for lot in analysis["risk_lots"][: args.top]:
        print(
            f"  {lot['store_code']} {lot['medicine_name'] or lot['medicine_code']:<30} lô {lot['batch_code']:<14}"
            f" còn {lot['days_left']:>2} ngày  tồn {_number(lot['quantity']):>6}  bán kịp {_number(lot['sellable_before_expiry']):>6}"
            f"  → nguy cơ {_number(lot['at_risk_quantity'])} ({_money(lot['at_risk_value'])})"
        )

    expired = [lot for lot in analysis["lots"] if lot["level"] == "expired"]
    print(f"\n--- Đã hết hạn, còn trong kho: {len(expired)} lô (tách khỏi quầy, làm thủ tục hủy hoặc trả nhà cung cấp) ---")
    for lot in expired[: args.top]:
        print(
            f"  {lot['store_code']} {lot['medicine_name'] or lot['medicine_code']:<30} lô {lot['batch_code']:<14}"
            f" hết hạn {-lot['days_left']} ngày  {_number(lot['quantity'])} đơn vị  {_money(lot['value'])}"
        )
    soon = [lot for lot in analysis["lots"] if lot["level"] in ("critical", "warning")]
    print(f"\n--- Hết hạn trong 30 ngày: {len(soon)} lô (FEFO: lô số 1 phải bán trước) ---")
    for lot in soon[: args.top]:
        verdict = "nguy cơ" if (lot["at_risk_quantity"] or 0) > 0 else "bán kịp"
        print(
            f"  {lot['store_code']} {lot['medicine_name'] or lot['medicine_code']:<30} lô {lot['batch_code']:<14}"
            f" còn {lot['days_left']:>2} ngày  FEFO #{lot['fefo_rank']}  tồn {_number(lot['quantity']):>6}  {verdict}"
        )
    return 0


def command_anomalies(args: argparse.Namespace) -> int:
    """Bất thường theo luật R1–R3 (bước 3.2)."""
    from app.analytics.anomaly_events import detect_anomalies
    from app.pipeline import sha256_of, stock_totals
    from app.processor import INVENTORY
    from app.processor.service import find_file

    try:
        results = process_folder(args.folder)
    except (LoadError, FileNotFoundError) as error:
        print(f"Không xử lý được: {error}", file=sys.stderr)
        return 1
    medicines = results["medicines"].data if "medicines" in results else None
    sales = prepare_sales(results["sales"].data, medicines)
    as_of = pd.Timestamp(args.as_of) if args.as_of else now_local()

    # R3 cần lần lưu tệp tồn kho TRƯỚC đó: lấy từ stock_history trong Analytics Store.
    current = previous = None
    previous_at = None
    if "inventory" in results:
        current = stock_totals(results["inventory"].data)
        sha = sha256_of(find_file(args.folder, INVENTORY))
        if args.db.exists():
            older = [version for version in AnalyticsStore(args.db).stock_versions(5) if version["file_sha"] != sha]
            if older:
                previous, previous_at = pd.DataFrame(older[0]["rows"]), older[0]["saved_at"]
    found = detect_anomalies(sales, as_of, medicines, current_stock=current, previous_stock=previous, previous_saved_at=previous_at)
    if args.store:
        found = [item for item in found if item["store_code"] == args.store.upper()]
    if args.json:
        print(json.dumps(found, ensure_ascii=False, indent=2))
        return 0

    print(f"\nBất thường (luật R1–R3 + Z-score), tính đến {as_of:%d/%m/%Y %H:%M}: {len(found)} sự kiện")
    if previous is None:
        print("(R3 tồn kho: chưa có lần lưu tệp tồn kho trước đó trong Analytics Store để so)")
    for item in found:
        how = "+".join(evidence.get("rule") or "z" for evidence in item["evidence"])
        print(f"  [{how}] {item['end']}  {item['message']}")
    return 0


def command_forecast(args: argparse.Namespace) -> int:
    """Dự báo doanh thu và nhu cầu thuốc (bước 3.4): mô hình chọn bằng backtest."""
    from app.analytics.anomaly import WEEKDAYS
    from app.analytics.forecast import MODEL_LABELS, forecast_demand, forecast_revenue

    try:
        results = process_folder(args.folder)
    except (LoadError, FileNotFoundError) as error:
        print(f"Không xử lý được: {error}", file=sys.stderr)
        return 1
    medicines = results["medicines"].data if "medicines" in results else None
    sales = prepare_sales(results["sales"].data, medicines)
    sales = sales[sales["sale_datetime"] < (pd.Timestamp(args.as_of) if args.as_of else now_local())]
    as_of = pd.Timestamp(args.as_of) if args.as_of else now_local()
    store = args.store.upper() if args.store else None

    revenue = forecast_revenue(sales, as_of, store, horizon=args.horizon)
    if args.json:
        print(json.dumps(revenue, ensure_ascii=False, indent=2))
        return 0
    scope = f"cửa hàng {store}" if store else "toàn chuỗi"
    print(f"\nDự báo doanh thu {scope}, {args.horizon} ngày tới (dữ liệu đến hết {as_of - pd.Timedelta(days=1):%d/%m/%Y})")
    if revenue["status"] != "ok":
        print(f"  {revenue['message']}")
        return 0
    print("Chọn mô hình bằng backtest 4 tuần trên doanh thu BÁN LẺ (WAPE: sai số, càng thấp càng tốt):")
    for name, score in revenue["scores"].items():
        mark = "  ← chọn" if name == revenue["model"] else ""
        if score is None or score["wape"] is None:
            print(f"  {MODEL_LABELS[name]:<28} chưa đủ dữ liệu")
            continue
        print(f"  {MODEL_LABELS[name]:<28} WAPE {_number(score['wape'] * 100, 1):>5}%   lệch {_number(score['bias'] * 100, 1):>5}%{mark}")
    print(f"Cộng bán buôn trung bình {_money(revenue['wholesale_per_day'])}/ngày (đơn bán buôn không đoán trước được ngày).")
    for point in revenue["points"]:
        day = pd.Timestamp(point["date"])
        band = "" if point["low"] is None else f"   (khoảng 80%: {_money(point['low'])} – {_money(point['high'])})"
        print(f"  {WEEKDAYS[day.weekday()]:<9} {day:%d/%m}  {_money(point['value']):>18}{band}")
    print(
        f"7 ngày tới: {_money(sum(point['value'] for point in revenue['points'][:7]))}"
        f" (bán lẻ {_growth(revenue['change_vs_last_7_pct'])} so với 7 ngày vừa qua)"
    )

    demand = [
        row
        for row in forecast_demand(sales, as_of, horizon=args.horizon)
        if row["status"] == "ok" and (store is None or row["store_code"] == store)
    ]
    names = {} if medicines is None else medicines.set_index("medicine_code")["medicine_name"].to_dict()
    demand.sort(key=lambda row: row["total"], reverse=True)
    print(f"\nNhu cầu 7 ngày tới ({len(demand)} cặp cửa hàng × thuốc; 10 cặp cần nhiều nhất):")
    for row in demand[:10]:
        error = "chưa đo" if row["wape"] is None else f"±{_number(row['wape'] * 100)}%"
        print(
            f"  {row['store_code']} {names.get(row['medicine_code'], row['medicine_code']):<32} {_number(sum(p['value'] for p in row['points'][:7])):>7}"
            f"  bán lẻ {_growth(row['change_vs_last_7_pct'])}  sai số tổng 7 ngày {error}"
        )
    if "inventory" in results:
        from app.analytics.forecast import stockout_projection
        from app.analytics.stock import sellable_stock

        points = [
            {"store_code": row["store_code"], "medicine_code": row["medicine_code"], "start": row["points"][0]["date"], "values": [p["value"] for p in row["points"]]}
            for row in demand
        ]
        soon = [item for item in stockout_projection(points, sellable_stock(results["inventory"].data, as_of)) if item["days_until_stockout"]]
        print(f"\nDự kiến hết hàng trong {args.horizon} ngày tới (cộng dồn nhu cầu dự báo từng ngày): {len(soon)}")
        for item in soon[:10]:
            print(
                f"  {item['store_code']} {names.get(item['medicine_code'], item['medicine_code']):<32}"
                f" tồn {_number(item['stock_quantity']):>7}  hết sau {item['days_until_stockout']:>2} ngày ({pd.Timestamp(item['stockout_date']):%d/%m})"
            )
    measured = [row["wape"] for row in demand if row["wape"] is not None]
    if measured:
        print(
            f"Sai số tổng 7 ngày của nhu cầu thuốc (phần bán lẻ): trung vị {_number(float(np.median(measured)) * 100)}%,"
            f" 3/4 số thuốc dưới {_number(float(np.percentile(measured, 75)) * 100)}%"
        )
    return 0


def command_run(args: argparse.Namespace) -> int:
    store = AnalyticsStore(args.db)
    pipeline = Pipeline(args.folder, store)
    as_of = pd.Timestamp(args.as_of) if args.as_of else None
    result = pipeline.run(trigger="manual", as_of=as_of, force=args.force)
    labels = {"processed": "ĐÃ XỬ LÝ", "refreshed": "TÍNH LẠI", "unchanged": "BỎ QUA", "failed": "THẤT BẠI"}
    print(f"[{labels[result.status]}] {result.message} ({result.duration_ms} ms)")
    if result.snapshot_version:
        snapshot = store.latest_snapshot()
        month = snapshot["kpi"]["ALL"]["periods"]["month"]
        print(f"Snapshot version {result.snapshot_version}, lần chạy #{result.run_id}, lưu tại {args.db}")
        print(f"  Cửa hàng: {', '.join(snapshot['stores'])}")
        print(f"  Doanh thu tháng này (toàn chuỗi): {_money(month['current']['revenue'])} ({_growth(month['growth']['revenue']).strip()})")
        quality = snapshot["data_quality"]["sales"]
        print(f"  sales: {_number(quality['rows_valid'])} dòng hợp lệ, loại {quality['rows_rejected']} dòng lỗi")
    return 1 if result.status == "failed" else 0


def command_status(args: argparse.Namespace) -> int:
    store = AnalyticsStore(args.db)
    meta = store.latest_snapshot_meta()
    if meta:
        print(f"Snapshot hiện tại: version {meta['version']}, tính đến {meta['as_of']}, tạo lúc {meta['created_at']}")
    else:
        print("Chưa có snapshot nào: chạy `python main.py run`.")
    print(f"\n{'#':>4}  {'Bắt đầu':<25} {'Kết quả':<8} {'Nguồn':<8} {'Đọc tệp':<8} {'Hợp lệ':>8} {'Lỗi':>5} {'ms':>6}  Snapshot")
    for run in store.recent_runs(args.limit):
        valid = "" if run["rows_valid"] is None else _number(run["rows_valid"])
        errors = "" if run["error_count"] is None else run["error_count"]
        reread = "có" if run["reprocessed"] else "không"
        print(
            f"{run['id']:>4}  {run['started_at']:<25} {run['status']:<8} {run['trigger']:<8} {reread:<8} "
            f"{valid:>8} {errors:>5} {run['duration_ms']:>6}  {run['snapshot_version'] or ''}"
        )
        if run["error_message"]:
            print(f"      ↳ {run['error_message']}")
    return 0


def command_watch(args: argparse.Namespace) -> int:
    log = setup_logging("monitor")
    args.folder.mkdir(parents=True, exist_ok=True)
    store = AnalyticsStore(args.db)
    monitor = Monitor(
        args.folder,
        Pipeline(args.folder, store),
        debounce_seconds=args.debounce,
        poll_seconds=args.poll,
        use_events=not args.polling_only,
        logger=log,
    )
    log.info("Bắt đầu theo dõi %s, ghi kết quả vào %s. Nhấn Ctrl+C để dừng.", args.folder.resolve(), args.db)
    try:
        monitor.run_forever()
    except KeyboardInterrupt:
        monitor.close()
    stats = monitor.stats
    log.info(
        "Đã dừng. %s sự kiện; xử lý %s, tính lại %s, bỏ qua %s, lỗi %s.",
        stats.events,
        stats.runs["processed"],
        stats.runs["refreshed"],
        stats.runs["unchanged"],
        stats.runs["failed"],
    )
    return 0


def command_serve(args: argparse.Namespace) -> int:
    import uvicorn

    from app.api import create_app

    log = setup_logging("monitor")
    args.folder.mkdir(parents=True, exist_ok=True)
    store = AnalyticsStore(args.db)
    monitor = None
    if not args.no_monitor:
        monitor = Monitor(args.folder, Pipeline(args.folder, store), poll_seconds=args.poll, logger=log)
    stop = threading.Event()

    @asynccontextmanager
    async def lifespan(_app):
        # Monitor chạy ở luồng nền, là nơi DUY NHẤT ghi SQLite; API chỉ đọc.
        thread = None
        if monitor is not None:
            thread = threading.Thread(target=monitor.run_forever, args=(stop,), name="monitor", daemon=True)
            thread.start()
        yield
        stop.set()
        if thread is not None:
            thread.join(timeout=10)

    app = create_app(store, monitor, lifespan=lifespan)
    log.info("API: http://%s:%s/docs (Ctrl+C để dừng)", args.host, args.port)
    if monitor is None:
        log.info("Không chạy Monitor: API chỉ đọc snapshot có sẵn trong %s", args.db)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Pharmacy Intelligent Analytics: analytics-service")
    commands = parser.add_subparsers(dest="command", required=True)
    process = commands.add_parser("process", help="Xử lý dữ liệu và in báo cáo chất lượng dữ liệu")
    process.add_argument("folder", nargs="?", type=Path, default=SAMPLES_DIR, help="Thư mục chứa medicines/sales/inventory")
    process.add_argument("--max-issues", type=int, default=20, help="Số vấn đề in ra màn hình")
    process.add_argument("--issues-csv", type=Path, help="Ghi toàn bộ vấn đề ra tệp CSV")
    process.set_defaults(handler=command_process)
    kpi = commands.add_parser("kpi", help="Tính KPI hôm nay / tuần này / tháng này")
    kpi.add_argument("folder", nargs="?", type=Path, default=SAMPLES_DIR, help="Thư mục chứa medicines/sales/inventory")
    kpi.add_argument("--as-of", help='Thời điểm tính, ví dụ "2026-10-30 18:00" (mặc định: bây giờ)')
    kpi.add_argument("--store", help="Chỉ tính một cửa hàng, ví dụ CH01")
    kpi.add_argument("--json", action="store_true", help="In kết quả dạng JSON")
    kpi.set_defaults(handler=command_kpi)
    products = commands.add_parser("products", help="Phân tích sản phẩm: bán chạy, lợi nhuận, giảm mạnh, bán chậm")
    products.add_argument("folder", nargs="?", type=Path, default=SAMPLES_DIR, help="Thư mục chứa medicines/sales/inventory")
    products.add_argument("--period", choices=["day", "week", "month"], default="month", help="Kỳ xếp hạng (mặc định tháng này)")
    products.add_argument("--store", help="Chỉ một cửa hàng, ví dụ CH01")
    products.add_argument("--as-of", help="Thời điểm tính (mặc định: bây giờ)")
    products.add_argument("--top", type=int, default=10, help="Số dòng mỗi bảng (mặc định 10)")
    products.add_argument("--json", action="store_true", help="In kết quả dạng JSON")
    products.set_defaults(handler=command_products)
    inventory = commands.add_parser("inventory", help="Tồn kho: hết hàng, sắp hết, tồn chết, tồn cao")
    inventory.add_argument("folder", nargs="?", type=Path, default=SAMPLES_DIR, help="Thư mục chứa medicines/sales/inventory")
    inventory.add_argument("--store", help="Chỉ một cửa hàng, ví dụ CH01")
    inventory.add_argument(
        "--status", choices=["out_of_stock", "low", "dead", "high", "normal"], help="Chỉ in một trạng thái"
    )
    inventory.add_argument("--as-of", help="Thời điểm tính (mặc định: bây giờ)")
    inventory.add_argument("--top", type=int, default=15, help="Số dòng mỗi trạng thái (mặc định 15)")
    inventory.add_argument("--json", action="store_true", help="In kết quả dạng JSON")
    inventory.set_defaults(handler=command_inventory)
    expiry = commands.add_parser("expiry", help="Hạn dùng 5 mức, FEFO, hàng có nguy cơ hết hạn")
    expiry.add_argument("folder", nargs="?", type=Path, default=SAMPLES_DIR, help="Thư mục chứa medicines/sales/inventory")
    expiry.add_argument("--store", help="Chỉ một cửa hàng, ví dụ CH02")
    expiry.add_argument("--as-of", help="Thời điểm tính (mặc định: bây giờ)")
    expiry.add_argument("--top", type=int, default=15, help="Số dòng mỗi danh sách (mặc định 15)")
    expiry.add_argument("--json", action="store_true", help="In kết quả dạng JSON")
    expiry.set_defaults(handler=command_expiry)
    anomalies = commands.add_parser("anomalies", help="Bất thường: doanh thu tụt/tăng vọt, thuốc bán tụt/tăng vọt, tồn tăng vọt")
    anomalies.add_argument("folder", nargs="?", type=Path, default=SAMPLES_DIR, help="Thư mục chứa medicines/sales/inventory")
    anomalies.add_argument("--store", help="Chỉ một cửa hàng (hoặc ALL cho toàn chuỗi)")
    anomalies.add_argument("--as-of", help="Thời điểm tính (mặc định: bây giờ)")
    anomalies.add_argument("--db", type=Path, default=ANALYTICS_DB, help="Analytics Store chứa lịch sử tồn kho (luật R3)")
    anomalies.add_argument("--json", action="store_true", help="In kết quả dạng JSON")
    anomalies.set_defaults(handler=command_anomalies)
    forecast = commands.add_parser("forecast", help="Dự báo doanh thu, nhu cầu thuốc (mô hình chọn bằng backtest)")
    forecast.add_argument("folder", nargs="?", type=Path, default=SAMPLES_DIR, help="Thư mục chứa medicines/sales")
    forecast.add_argument("--store", help="Chỉ một cửa hàng, ví dụ CH01")
    forecast.add_argument("--horizon", type=int, choices=[7, 30], default=7, help="Số ngày dự báo (7 hoặc 30)")
    forecast.add_argument("--as-of", help="Thời điểm tính (mặc định: bây giờ)")
    forecast.add_argument("--json", action="store_true", help="In dự báo doanh thu dạng JSON")
    forecast.set_defaults(handler=command_forecast)
    abc = commands.add_parser("abc", help="Phân loại ABC–XYZ: đóng góp doanh thu, độ ổn định nhu cầu")
    abc.add_argument("folder", nargs="?", type=Path, default=SAMPLES_DIR, help="Thư mục chứa medicines/sales/inventory")
    abc.add_argument("--store", help="Một cửa hàng, ví dụ CH01 (mặc định toàn chuỗi)")
    abc.add_argument("--as-of", help="Thời điểm tính (mặc định: bây giờ)")
    abc.add_argument("--top", type=int, default=20, help="Số thuốc in ra (mặc định 20)")
    abc.add_argument("--json", action="store_true", help="In kết quả dạng JSON")
    abc.set_defaults(handler=command_abc)
    run = commands.add_parser("run", help="Chạy pipeline và lưu snapshot vào SQLite")
    run.add_argument("folder", nargs="?", type=Path, default=SAMPLES_DIR, help="Thư mục chứa medicines/sales/inventory")
    run.add_argument("--db", type=Path, default=ANALYTICS_DB, help="Tệp SQLite (mặc định data/analytics.db)")
    run.add_argument("--as-of", help="Thời điểm tính (mặc định: bây giờ)")
    run.add_argument("--force", action="store_true", help="Đọc lại tệp dù không đổi")
    run.set_defaults(handler=command_run)
    status = commands.add_parser("status", help="Xem các lần chạy gần nhất")
    status.add_argument("--db", type=Path, default=ANALYTICS_DB, help="Tệp SQLite")
    status.add_argument("--limit", type=int, default=10, help="Số lần chạy hiển thị")
    status.set_defaults(handler=command_status)
    watch = commands.add_parser("watch", help="Theo dõi thư mục, tự chạy pipeline khi tệp được lưu")
    watch.add_argument("folder", nargs="?", type=Path, default=INBOX_DIR, help="Thư mục theo dõi (mặc định data/inbox)")
    watch.add_argument("--db", type=Path, default=ANALYTICS_DB, help="Tệp SQLite")
    watch.add_argument("--debounce", type=float, default=MONITOR_DEBOUNCE_SECONDS, help="Giây chờ yên lặng sau sự kiện")
    watch.add_argument("--poll", type=float, default=MONITOR_POLL_SECONDS, help="Giây giữa hai lần polling dự phòng")
    watch.add_argument("--polling-only", action="store_true", help="Không dùng sự kiện, chỉ polling (ổ mạng)")
    watch.set_defaults(handler=command_watch)
    serve = commands.add_parser("serve", help="Chạy Analytics API (và Monitor) cho Dashboard")
    serve.add_argument("folder", nargs="?", type=Path, default=INBOX_DIR, help="Thư mục Monitor theo dõi")
    serve.add_argument("--db", type=Path, default=ANALYTICS_DB, help="Tệp SQLite")
    # Mặc định chỉ nghe trên chính máy này: Node Gateway đứng trước để kiểm tra đăng nhập.
    serve.add_argument("--host", default="127.0.0.1", help="Địa chỉ nghe (mặc định chỉ máy này)")
    serve.add_argument("--port", type=int, default=8000, help="Cổng (mặc định 8000)")
    serve.add_argument("--poll", type=float, default=MONITOR_POLL_SECONDS, help="Giây giữa hai lần polling")
    serve.add_argument("--no-monitor", action="store_true", help="Chỉ chạy API, không theo dõi tệp")
    serve.set_defaults(handler=command_serve)
    args = parser.parse_args()
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
