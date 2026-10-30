"""Điểm chạy của analytics-service.

Bước 1.2 mới có lệnh `process`: xử lý một thư mục dữ liệu và in báo cáo chất
lượng dữ liệu. Các bước sau sẽ thêm `serve` (API + theo dõi tệp).

Chạy:  python main.py process                  (mặc định: data/samples)
       python main.py process data/inbox --issues-csv data/reports/issues.csv
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

from app.config import SAMPLES_DIR
from app.processor import LoadError, ProcessResult, process_folder

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


def main() -> int:
    parser = argparse.ArgumentParser(description="Pharmacy Intelligent Analytics: analytics-service")
    commands = parser.add_subparsers(dest="command", required=True)
    process = commands.add_parser("process", help="Xử lý dữ liệu và in báo cáo chất lượng dữ liệu")
    process.add_argument("folder", nargs="?", type=Path, default=SAMPLES_DIR, help="Thư mục chứa medicines/sales")
    process.add_argument("--max-issues", type=int, default=20, help="Số vấn đề in ra màn hình")
    process.add_argument("--issues-csv", type=Path, help="Ghi toàn bộ vấn đề ra tệp CSV")
    process.set_defaults(handler=command_process)
    args = parser.parse_args()
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
