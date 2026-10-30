"""Nguồn dữ liệu của pipeline (Phase 5, bước 5.5; quyết định D22).

- FolderSource: thư mục tệp medicines / sales / inventory (.xlsx, .csv) như từ Phase 1.
- PostgresSource: đọc thẳng CSDL của phần mềm qua 4 view chỉ đọc trong schema analytics_src
  (migration 20261031150000_analytics_source_views), bằng tài khoản chỉ đọc analytics_reader.

Hai nguồn cùng trả "dấu nhận biết" cho từng bộ dữ liệu: dấu không đổi thì pipeline không đọc
lại. Với PostgreSQL, dấu là mốc trong view change_marker (vài phép đếm, max trên chỉ mục), hỏi
mỗi lần Monitor kiểm tra (~30 giây); chỉ khi mốc đổi mới đọc cả view.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Protocol

import pandas as pd

from app.pipeline_types import FileFingerprint, sha256_of
from app.processor import INVENTORY, MEDICINES, SALES
from app.processor.loader import LoadError
from app.processor.service import ProcessResult, find_file, process_folder, process_frames

DATASETS = ("medicines", "sales", "inventory")


class DataSource(Protocol):
    kind: str

    def describe(self) -> str: ...

    def fingerprints(self, known: dict[str, FileFingerprint]) -> dict[str, FileFingerprint]: ...

    def load(self, now: pd.Timestamp) -> dict[str, ProcessResult]: ...


class FolderSource:
    kind = "files"

    def __init__(self, folder: Path):
        self.folder = Path(folder)

    def describe(self) -> str:
        return str(self.folder)

    def fingerprints(self, known: dict[str, FileFingerprint]) -> dict[str, FileFingerprint]:
        """So size + mtime trước (gần như miễn phí); chỉ khi khác mới tính sha256 (đọc cả tệp)."""
        found: dict[str, FileFingerprint] = {}
        for schema in (MEDICINES, SALES, INVENTORY):
            path = find_file(self.folder, schema)
            if path is None:
                continue
            stat = path.stat()
            previous = known.get(schema.name)
            if previous and previous.name == path.name and previous.size == stat.st_size and previous.mtime == stat.st_mtime:
                found[schema.name] = previous
            else:
                found[schema.name] = FileFingerprint(path.name, stat.st_size, stat.st_mtime, sha256_of(path))
        if "sales" not in found:
            raise LoadError(f"Không thấy sales.xlsx hoặc sales.csv trong {self.folder}")
        return found

    def load(self, now: pd.Timestamp) -> dict[str, ProcessResult]:
        return process_folder(self.folder, now=now)


class PostgresSource:
    kind = "postgres"

    def __init__(self, dsn: str, schema: str = "analytics_src", *, timeout_seconds: int = 10):
        self.dsn = dsn
        self.schema = schema
        self.timeout_seconds = timeout_seconds

    def describe(self) -> str:
        """Không in mật khẩu: chỉ máy chủ, cổng, tên CSDL."""
        from psycopg.conninfo import conninfo_to_dict

        try:
            info = conninfo_to_dict(self.dsn)
        except Exception:  # noqa: BLE001 - chuỗi kết nối hỏng thì lúc kết nối sẽ báo lỗi rõ
            return f"postgres ({self.schema})"
        return f"postgres://{info.get('host', 'localhost')}:{info.get('port', 5432)}/{info.get('dbname', '')} ({self.schema})"

    def _connect(self):
        import psycopg

        try:
            return psycopg.connect(
                self.dsn,
                connect_timeout=self.timeout_seconds,
                # Phiên chỉ đọc: kể cả khi lỡ dùng tài khoản có quyền ghi, câu lệnh ghi vẫn bị chặn.
                options="-c default_transaction_read_only=on -c statement_timeout=60000",
            )
        except psycopg.Error as error:
            raise LoadError(f"Không kết nối được PostgreSQL ({self.describe()}): {str(error).strip()}") from error

    def fingerprints(self, known: dict[str, FileFingerprint]) -> dict[str, FileFingerprint]:
        import psycopg

        try:
            with self._connect() as connection:
                row = connection.execute(
                    f"SELECT medicines, sales, inventory FROM {self.schema}.change_marker"
                ).fetchone()
        except psycopg.Error as error:
            raise LoadError(f"Không đọc được {self.schema}.change_marker: {str(error).strip()}") from error
        found: dict[str, FileFingerprint] = {}
        now = time.time()
        for name, marker in zip(DATASETS, row):
            previous = known.get(name)
            # Mốc không đổi: giữ dấu cũ (kể cả thời điểm), nên "tồn tính đến" là lúc dữ liệu đổi lần cuối.
            if previous and previous.sha256 == marker:
                found[name] = previous
            else:
                found[name] = FileFingerprint(f"{self.schema}.{name}", 0, now, marker)
        return found

    def load(self, now: pd.Timestamp) -> dict[str, ProcessResult]:
        import psycopg

        frames: dict[str, pd.DataFrame] = {}
        try:
            with self._connect() as connection:
                for name in DATASETS:
                    cursor = connection.execute(f"SELECT * FROM {self.schema}.{name}")
                    columns = [column.name for column in cursor.description]
                    frames[name] = pd.DataFrame(cursor.fetchall(), columns=columns)
        except psycopg.Error as error:
            raise LoadError(f"Không đọc được dữ liệu từ {self.schema}: {str(error).strip()}") from error
        if frames["sales"].empty:
            raise LoadError(f"{self.schema}.sales chưa có dòng bán hàng nào (hóa đơn hoàn tất có dòng thuốc)")
        if frames["inventory"].empty:
            del frames["inventory"]
        return process_frames(frames, source=self.schema, now=now)


def make_source(kind: str, folder: Path, dsn: str | None) -> DataSource:
    if kind == "postgres":
        if not dsn:
            raise SystemExit("ANALYTICS_SOURCE=postgres cần ANALYTICS_PG_DSN (chuỗi kết nối tài khoản chỉ đọc)")
        return PostgresSource(dsn)
    return FolderSource(folder)
