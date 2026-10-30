"""Điểm chạy của analytics-service.

Lệnh hiện có:
- process: xử lý một thư mục dữ liệu, in báo cáo chất lượng dữ liệu (bước 1.2)
- kpi:     tính chỉ số kinh doanh hôm nay / tuần này / tháng này (bước 1.3)
- run:     chạy pipeline Processor → KPI → lưu snapshot vào SQLite (bước 1.4)
- status:  xem các lần chạy gần nhất và snapshot hiện tại (bước 1.4)
- watch:   tự theo dõi thư mục, tệp được lưu thì tự chạy pipeline (bước 1.5)
Các bước sau sẽ thêm `serve` (API + theo dõi tệp).

Chạy:  python main.py process                  (mặc định: data/samples)
       python main.py process data/inbox --issues-csv data/reports/issues.csv
       python main.py kpi --as-of "2026-10-30 18:00" --store CH01
       python main.py run             (chạy lại ngay: thêm --force)
       python main.py status
       python main.py watch           (theo dõi data/inbox; Ctrl+C để dừng)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

from app.analytics import kpi_summary, prepare_sales, sales_breakdown
from app.analytics.periods import Window
from app.config import ANALYTICS_DB, INBOX_DIR, MONITOR_DEBOUNCE_SECONDS, MONITOR_POLL_SECONDS, SAMPLES_DIR
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Pharmacy Intelligent Analytics: analytics-service")
    commands = parser.add_subparsers(dest="command", required=True)
    process = commands.add_parser("process", help="Xử lý dữ liệu và in báo cáo chất lượng dữ liệu")
    process.add_argument("folder", nargs="?", type=Path, default=SAMPLES_DIR, help="Thư mục chứa medicines/sales")
    process.add_argument("--max-issues", type=int, default=20, help="Số vấn đề in ra màn hình")
    process.add_argument("--issues-csv", type=Path, help="Ghi toàn bộ vấn đề ra tệp CSV")
    process.set_defaults(handler=command_process)
    kpi = commands.add_parser("kpi", help="Tính KPI hôm nay / tuần này / tháng này")
    kpi.add_argument("folder", nargs="?", type=Path, default=SAMPLES_DIR, help="Thư mục chứa medicines/sales")
    kpi.add_argument("--as-of", help='Thời điểm tính, ví dụ "2026-10-30 18:00" (mặc định: bây giờ)')
    kpi.add_argument("--store", help="Chỉ tính một cửa hàng, ví dụ CH01")
    kpi.add_argument("--json", action="store_true", help="In kết quả dạng JSON")
    kpi.set_defaults(handler=command_kpi)
    run = commands.add_parser("run", help="Chạy pipeline và lưu snapshot vào SQLite")
    run.add_argument("folder", nargs="?", type=Path, default=SAMPLES_DIR, help="Thư mục chứa medicines/sales")
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
    args = parser.parse_args()
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
