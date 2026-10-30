"""Kiểm thử Pipeline và Analytics Store (bước 1.4).

Mỗi test dùng thư mục tạm riêng và tệp SQLite riêng, thời điểm tính cố định.
"""

from __future__ import annotations

import os
from datetime import datetime

import pandas as pd
import pytest

import app.pipeline as pipeline_module
import app.store.sqlite_store as store_module
from app.analytics import kpi_summary, prepare_sales
from app.pipeline import Pipeline
from app.processor import process_folder
from app.store import AnalyticsStore

AS_OF = pd.Timestamp("2026-10-29 12:00")

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


BASE_SALES = [
    sale("HD1", "2026-10-29 09:00"),  # 12.000
    sale("HD2", "2026-10-28 10:00", code="KS001", quantity=2, price=5_000, cost=3_500, store="CH02"),  # 10.000
    sale("HD3", "2026-10-20 08:00", quantity=0),  # lỗi: số lượng 0
]


@pytest.fixture
def workspace(tmp_path):
    folder = tmp_path / "inbox"
    folder.mkdir()
    pd.DataFrame(MEDICINES).to_excel(folder / "medicines.xlsx", index=False)
    pd.DataFrame(BASE_SALES).to_excel(folder / "sales.xlsx", index=False)
    store = AnalyticsStore(tmp_path / "analytics.db")
    return folder, store


@pytest.fixture
def reads(monkeypatch):
    """Đếm số lần pipeline thật sự đọc tệp."""
    counter = {"count": 0}
    original = pipeline_module.process_folder

    def counting(*args, **kwargs):
        counter["count"] += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(pipeline_module, "process_folder", counting)
    return counter


def test_first_run_stores_snapshot_matching_kpi_engine(workspace, reads):
    folder, store = workspace
    result = Pipeline(folder, store).run(as_of=AS_OF)

    assert (result.status, result.snapshot_version, reads["count"]) == ("processed", 1, 1)
    snapshot = store.latest_snapshot()
    assert snapshot["version"] == 1
    assert snapshot["stores"] == ["CH01", "CH02"]

    # Snapshot phải đúng bằng kết quả KPI Engine tính trực tiếp.
    results = process_folder(folder, now=AS_OF)
    sales = prepare_sales(results["sales"].data, results["medicines"].data)
    assert snapshot["kpi"]["ALL"] == kpi_summary(sales, AS_OF)
    assert snapshot["kpi"]["CH02"] == kpi_summary(sales, AS_OF, "CH02")
    assert snapshot["kpi"]["ALL"]["periods"]["day"]["current"]["revenue"] == 12_000
    assert len(snapshot["trend"]["daily"]["ALL"]) == 90
    assert snapshot["data_quality"]["sales"]["rows_rejected"] == 1

    # Bảng theo ngày × cửa hàng, nền cho phát hiện bất thường và dự báo.
    assert store.daily_kpis() == [
        {"date": "2026-10-28", "revenue": 10_000, "cogs": 7_000, "profit": 3_000, "orders": 1, "units": 2},
        {"date": "2026-10-29", "revenue": 12_000, "cogs": 8_000, "profit": 4_000, "orders": 1, "units": 10},
    ]
    issues = store.latest_issues()
    assert [issue["code"] for issue in issues["issues"]] == ["non_positive_quantity"]


def test_unchanged_files_are_not_read_again(workspace, reads):
    folder, store = workspace
    pipeline = Pipeline(folder, store)
    pipeline.run(as_of=AS_OF)

    result = pipeline.run(as_of=AS_OF + pd.Timedelta(minutes=1))

    assert result.status == "unchanged"
    assert reads["count"] == 1
    assert store.latest_version() == 1
    assert len(store.recent_runs()) == 1  # bỏ qua thì không ghi nhật ký, tránh phình bảng


def test_restart_remembers_processed_files(workspace, reads):
    folder, store = workspace
    Pipeline(folder, store).run(as_of=AS_OF)

    result = Pipeline(folder, store).run(as_of=AS_OF + pd.Timedelta(minutes=1))  # tiến trình mới

    assert result.status == "unchanged"
    assert reads["count"] == 1


def test_saving_without_changes_is_ignored(workspace, reads):
    """Mở Excel bấm Lưu mà không sửa gì: thời điểm sửa đổi, nội dung (hash) y nguyên."""
    folder, store = workspace
    pipeline = Pipeline(folder, store)
    pipeline.run(as_of=AS_OF)
    path = folder / "sales.xlsx"
    stat = path.stat()
    os.utime(path, (stat.st_atime, stat.st_mtime + 60))

    assert pipeline.run(as_of=AS_OF + pd.Timedelta(minutes=1)).status == "unchanged"
    assert reads["count"] == 1


def test_new_rows_trigger_processing(workspace, reads):
    folder, store = workspace
    pipeline = Pipeline(folder, store)
    pipeline.run(as_of=AS_OF)
    pd.DataFrame([*BASE_SALES, sale("HD4", "2026-10-29 10:30", quantity=5)]).to_excel(folder / "sales.xlsx", index=False)

    result = pipeline.run(as_of=AS_OF + pd.Timedelta(minutes=1))

    assert (result.status, result.snapshot_version, reads["count"]) == ("processed", 2, 2)
    assert store.latest_snapshot()["kpi"]["ALL"]["periods"]["day"]["current"]["revenue"] == 18_000


def test_stale_snapshot_is_recomputed_without_rereading(workspace, reads):
    """Qua nửa đêm: tệp không đổi nhưng "hôm nay" phải về 0. Chỉ tính lại, không đọc lại tệp."""
    folder, store = workspace
    pipeline = Pipeline(folder, store, refresh_seconds=300)
    pipeline.run(as_of=pd.Timestamp("2026-10-29 23:58"))
    assert store.latest_snapshot()["kpi"]["ALL"]["periods"]["day"]["current"]["revenue"] == 12_000

    result = pipeline.run(as_of=pd.Timestamp("2026-10-30 00:04"))

    assert (result.status, result.snapshot_version, reads["count"]) == ("refreshed", 2, 1)
    day = store.latest_snapshot()["kpi"]["ALL"]["periods"]["day"]
    assert day["current"]["revenue"] == 0
    assert day["previous_full"]["revenue"] == 12_000
    # Lần tính lại không kiểm tra lại tệp: lỗi dữ liệu vẫn lấy từ lần đọc tệp gần nhất.
    assert store.latest_issues()["run_id"] == 1


def test_broken_file_keeps_last_good_snapshot(workspace):
    folder, store = workspace
    pipeline = Pipeline(folder, store)
    pipeline.run(as_of=AS_OF)
    (folder / "sales.xlsx").write_bytes(b"day khong phai excel")

    result = pipeline.run(as_of=AS_OF + pd.Timedelta(minutes=1))

    assert result.status == "failed"
    assert store.latest_version() == 1  # Dashboard vẫn hiện dữ liệu tốt gần nhất
    last_run = store.recent_runs(1)[0]
    assert last_run["status"] == "failed" and "sales.xlsx" in last_run["error_message"]


def test_missing_sales_file_fails_cleanly(tmp_path):
    store = AnalyticsStore(tmp_path / "analytics.db")
    result = Pipeline(tmp_path, store).run(as_of=AS_OF)
    assert result.status == "failed"
    assert store.latest_snapshot() is None


def test_old_snapshots_are_pruned(workspace, monkeypatch):
    folder, store = workspace
    monkeypatch.setattr(store_module, "KEEP_SNAPSHOTS", 3)
    pipeline = Pipeline(folder, store)
    for minute in range(5):
        pipeline.run(as_of=AS_OF + pd.Timedelta(minutes=minute), force=True)

    assert store.latest_version() == 5  # version vẫn tăng đều, không dùng lại số cũ
    assert len(store.recent_runs()) == 5
    with store._connect() as db:
        assert [row[0] for row in db.execute("SELECT version FROM snapshots ORDER BY version")] == [3, 4, 5]
