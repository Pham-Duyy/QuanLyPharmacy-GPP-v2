"""Kiểm thử File Monitor (bước 1.5) với watchdog thật trên thư mục tạm.

Monitor chạy ở một luồng riêng; test sửa tệp rồi chờ snapshot mới xuất hiện.
Debounce rút ngắn còn 0,3 giây cho test chạy nhanh.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pandas as pd
import pytest

from app.monitor import Monitor, is_relevant
from app.pipeline import Pipeline
from app.store import AnalyticsStore

HEADER = "sale_id,line_no,sale_datetime,sale_type,store_code,medicine_code,quantity,selling_price,purchase_price\n"


def sales_line(sale_id: str, quantity: int = 1) -> str:
    return f"{sale_id},1,29/10/2026 09:00,retail,CH01,GD001,{quantity},1200,800\n"


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("sales.xlsx", True),
        ("Sales.CSV", True),
        ("medicines.xlsx", True),
        ("~$sales.xlsx", False),  # tệp khóa của Excel khi đang mở
        ("8A3F2B10", False),  # tệp tạm Excel tạo lúc lưu
        (".sales.tmp.xlsx", False),
        ("sales.xls", False),
        ("report.xlsx", False),
    ],
)
def test_relevant_files(name, expected):
    assert is_relevant(name) is expected


def wait_until(condition, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.05)
    return False


@pytest.fixture
def running(tmp_path):
    """Khởi động Monitor ở luồng nền trên một thư mục có sẵn sales.csv."""
    folder = tmp_path / "inbox"
    folder.mkdir()
    (folder / "sales.csv").write_text(HEADER + sales_line("HD1"), encoding="utf-8")
    store = AnalyticsStore(tmp_path / "analytics.db")
    monitors: list[tuple[Monitor, threading.Event, threading.Thread]] = []

    def start(**options) -> Monitor:
        monitor = Monitor(folder, Pipeline(folder, store), debounce_seconds=0.3, poll_seconds=60, retry_seconds=0.3, **options)
        stop = threading.Event()
        thread = threading.Thread(target=monitor.run_forever, args=(stop,), daemon=True)
        thread.start()
        monitors.append((monitor, stop, thread))
        assert wait_until(lambda: store.latest_version() == 1), "lần chạy đầu tiên phải tạo snapshot"
        return monitor

    yield folder, store, start
    for _, stop, thread in monitors:
        stop.set()
        thread.join(timeout=5)


def append(folder: Path, text: str) -> None:
    with open(folder / "sales.csv", "a", encoding="utf-8") as handle:
        handle.write(text)


def test_saved_file_is_processed_automatically(running):
    folder, store, start = running
    monitor = start()

    append(folder, sales_line("HD2", quantity=4))

    assert wait_until(lambda: store.latest_version() == 2)
    assert store.latest_snapshot()["kpi"]["ALL"]["all_time"]["revenue"] == 6_000
    assert monitor.stats.last_latency_ms is not None


def test_burst_of_saves_runs_pipeline_once(running):
    """Excel lưu một lần sinh nhiều sự kiện liên tiếp: debounce gộp lại thành một lần xử lý."""
    folder, store, start = running
    monitor = start()

    for index in range(5):
        append(folder, sales_line(f"HD{index + 10}"))
        time.sleep(0.05)

    assert wait_until(lambda: store.latest_version() == 2)
    time.sleep(1.0)
    assert store.latest_version() == 2
    assert monitor.stats.runs["processed"] == 2  # lần đầu + một lần cho cả đợt


def test_temporary_files_and_reads_do_not_trigger(running):
    folder, store, start = running
    monitor = start()
    events_before = monitor.stats.events

    (folder / "~$sales.xlsx").write_bytes(b"lock")
    (folder / "8A3F2B10").write_bytes(b"tmp")
    (folder / "sales.csv").read_text(encoding="utf-8")  # chỉ mở để đọc

    time.sleep(1.0)
    assert monitor.stats.events == events_before
    assert store.latest_version() == 1


def test_polling_catches_changes_without_events(running):
    """Ổ mạng, OneDrive: không có sự kiện, polling vẫn bắt được thay đổi."""
    folder, store, start = running
    monitor = start(use_events=False)
    monitor.poll_seconds = 0.3

    append(folder, sales_line("HD2"))

    assert wait_until(lambda: store.latest_version() == 2)


def test_broken_file_then_fixed(running):
    folder, store, start = running
    monitor = start()

    (folder / "sales.csv").write_text("sale_id,line_no\nHD1,1\n", encoding="utf-8")  # thiếu cột bắt buộc
    assert wait_until(lambda: monitor.stats.runs["failed"] >= 1)
    assert store.latest_version() == 1  # vẫn giữ snapshot tốt

    (folder / "sales.csv").write_text(HEADER + sales_line("HD1") + sales_line("HD9", quantity=9), encoding="utf-8")
    assert wait_until(lambda: store.latest_version() == 2)
    assert store.latest_snapshot()["kpi"]["ALL"]["all_time"]["revenue"] == 12_000


def test_polling_does_not_repeat_same_failure(tmp_path):
    """Tệp hỏng nằm im: polling không ghi "failed" mỗi 30 giây."""
    folder = tmp_path
    (folder / "sales.csv").write_text("sale_id\nHD1\n", encoding="utf-8")
    store = AnalyticsStore(tmp_path / "analytics.db")
    pipeline = Pipeline(folder, store)
    now = pd.Timestamp("2026-10-29 12:00")

    assert pipeline.run(trigger="monitor", as_of=now).status == "failed"
    assert pipeline.run(trigger="refresh", as_of=now).status == "unchanged"
    assert pipeline.run(trigger="monitor", as_of=now).status == "failed"  # thử lại do sự kiện vẫn chạy
    assert len(store.recent_runs()) == 2
