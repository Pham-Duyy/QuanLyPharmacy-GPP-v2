"""Nối các bước xử lý: đọc -> làm sạch -> kiểm tra -> kết quả.

Đây là chỗ duy nhất các bước sau (pipeline, monitor) gọi tới. Họ không cần
biết bên trong có loader, cleaner, validator.
"""

from __future__ import annotations

import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

from app.config import FUTURE_TOLERANCE_HOURS, TIMEZONE

from .cleaner import clean_dataset
from .issues import DataIssue
from .loader import LoadError, load_dataset
from .schemas import INVENTORY, MEDICINES, SALES, DatasetSchema
from .validator import validate_dataset


@dataclass
class ProcessResult:
    dataset: str
    file: str
    rows_read: int
    rows_valid: int
    rows_rejected: int
    data: pd.DataFrame
    issues: list[DataIssue] = field(default_factory=list)
    duration_ms: int = 0

    @property
    def error_count(self) -> int:
        return sum(1 for issue in self.issues if issue.severity == "error")

    @property
    def warning_count(self) -> int:
        return sum(1 for issue in self.issues if issue.severity == "warning")

    def issue_summary(self) -> dict[str, int]:
        """Đếm lỗi theo loại, ví dụ {'unknown_medicine': 3, 'below_cost': 12}."""
        return dict(Counter(issue.code for issue in self.issues).most_common())


def now_local() -> pd.Timestamp:
    """Giờ Việt Nam hiện tại, bỏ thông tin múi giờ để so được với ngày trong Excel."""
    return pd.Timestamp(datetime.now(TIMEZONE).replace(tzinfo=None))


def process_file(
    path: Path,
    schema: DatasetSchema,
    *,
    catalog_codes: set[str] | None = None,
    sales_stores: set[str] | None = None,
    now: pd.Timestamp | None = None,
) -> ProcessResult:
    """Xử lý một tệp. Thiếu cột bắt buộc hoặc tệp hỏng thì ném LoadError."""
    started = time.perf_counter()
    frame, file_issues = load_dataset(path, schema)
    return _process(frame, file_issues, schema, Path(path).name, started, catalog_codes, sales_stores, now)


def _process(
    frame: pd.DataFrame,
    file_issues: list[DataIssue],
    schema: DatasetSchema,
    name: str,
    started: float,
    catalog_codes: set[str] | None,
    sales_stores: set[str] | None,
    now: pd.Timestamp | None,
) -> ProcessResult:
    cleaned = clean_dataset(frame, schema)
    limit = (now or now_local()) + timedelta(hours=FUTURE_TOLERANCE_HOURS)
    validated = validate_dataset(cleaned, schema, catalog_codes=catalog_codes, sales_stores=sales_stores, now=limit)
    return ProcessResult(
        dataset=schema.name,
        file=name,
        rows_read=len(frame),
        rows_valid=len(validated.valid),
        rows_rejected=validated.rejected_rows,
        data=validated.valid,
        issues=[*file_issues, *validated.issues],
        duration_ms=round((time.perf_counter() - started) * 1000),
    )


def find_file(folder: Path, schema: DatasetSchema) -> Path | None:
    """Tìm medicines.xlsx hoặc medicines.csv trong thư mục; ưu tiên .xlsx."""
    for suffix in (".xlsx", ".csv"):
        candidate = Path(folder) / f"{schema.file_stem}{suffix}"
        if candidate.exists():
            return candidate
    return None


def process_folder(folder: Path, *, now: pd.Timestamp | None = None) -> dict[str, ProcessResult]:
    """Xử lý cả bộ tệp theo đúng thứ tự phụ thuộc: danh mục thuốc → bán hàng → tồn kho.

    Bán hàng cần danh mục để kiểm tra mã thuốc có tồn tại hay không; tồn kho cần
    thêm danh sách cửa hàng trong tệp bán hàng để bắt mã cửa hàng gõ nhầm.
    Tồn kho không bắt buộc: thiếu tệp thì phần bán hàng vẫn chạy.
    """
    results: dict[str, ProcessResult] = {}
    medicines_path = find_file(folder, MEDICINES)
    catalog: set[str] | None = None
    if medicines_path:
        results["medicines"] = process_file(medicines_path, MEDICINES, now=now)
        catalog = set(results["medicines"].data["medicine_code"])

    sales_path = find_file(folder, SALES)
    if sales_path is None:
        raise LoadError(f"Không thấy sales.xlsx hoặc sales.csv trong {folder}")
    results["sales"] = process_file(sales_path, SALES, catalog_codes=catalog, now=now)

    inventory_path = find_file(folder, INVENTORY)
    if inventory_path:
        stores = set(results["sales"].data["store_code"].dropna())
        results["inventory"] = process_file(inventory_path, INVENTORY, catalog_codes=catalog, sales_stores=stores, now=now)
    return results


def process_frames(frames: dict[str, pd.DataFrame], *, source: str, now: pd.Timestamp | None = None) -> dict[str, ProcessResult]:
    """Như process_folder nhưng dữ liệu đã đọc sẵn thành bảng (nguồn PostgreSQL, bước 5.5).

    `frames`: {"medicines", "sales", "inventory"} → bảng có tên cột chuẩn. Làm sạch, kiểm tra
    y như tệp, nên báo cáo chất lượng dữ liệu và mọi phân tích phía sau không đổi.
    `source`: tên hiện ở báo cáo, ví dụ "analytics_src" → "analytics_src.sales".
    """
    from .loader import frame_to_dataset

    def run(schema: DatasetSchema, **kwargs) -> ProcessResult:
        started = time.perf_counter()
        frame = frame_to_dataset(frames[schema.name], schema)
        return _process(frame, [], schema, f"{source}.{schema.name}", started, kwargs.get("catalog_codes"), kwargs.get("sales_stores"), now)

    if "sales" not in frames:
        raise LoadError(f"Nguồn {source} không có dữ liệu bán hàng")
    results: dict[str, ProcessResult] = {}
    catalog: set[str] | None = None
    if "medicines" in frames:
        results["medicines"] = run(MEDICINES)
        catalog = set(results["medicines"].data["medicine_code"])
    results["sales"] = run(SALES, catalog_codes=catalog)
    if "inventory" in frames:
        stores = set(results["sales"].data["store_code"].dropna())
        results["inventory"] = run(INVENTORY, catalog_codes=catalog, sales_stores=stores)
    return results
