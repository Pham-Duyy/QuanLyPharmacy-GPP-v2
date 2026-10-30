"""Analytics Store: lưu kết quả đã tính vào SQLite.

Dùng thư viện sqlite3 có sẵn của Python (không cần cài). Một tệp .db duy nhất,
bật chế độ WAL để một tiến trình ghi (pipeline) và nhiều tiến trình đọc (API)
cùng lúc không chặn nhau.

Bảng:
- runs         nhật ký mỗi lần chạy pipeline
- snapshots    kết quả đã tính dạng JSON, version tăng dần
- data_issues  lỗi dữ liệu của từng lần chạy
- kpi_daily    chỉ số theo ngày × cửa hàng (nền cho phát hiện bất thường, dự báo)
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from app.config import KEEP_ISSUE_RUNS, KEEP_RUNS, KEEP_SNAPSHOTS
from app.processor import DataIssue

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at    TEXT NOT NULL,
    finished_at   TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('success', 'failed')),
    trigger       TEXT NOT NULL,              -- manual | monitor | refresh
    source_hash   TEXT,                       -- dấu vân tay của bộ tệp đã đọc
    reprocessed   INTEGER NOT NULL,           -- 1: đã đọc lại tệp; 0: dùng dữ liệu trong bộ nhớ
    files         TEXT NOT NULL,              -- JSON: tên, kích thước, hash, số dòng của từng tệp
    rows_valid    INTEGER,
    rows_rejected INTEGER,
    error_count   INTEGER,
    warning_count INTEGER,
    duration_ms   INTEGER NOT NULL,
    snapshot_version INTEGER,
    error_message TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
    version      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id       INTEGER NOT NULL REFERENCES runs(id),
    created_at   TEXT NOT NULL,
    as_of        TEXT NOT NULL,
    source_hash  TEXT NOT NULL,
    payload      TEXT NOT NULL                -- JSON
);

CREATE TABLE IF NOT EXISTS data_issues (
    run_id    INTEGER NOT NULL REFERENCES runs(id),
    dataset   TEXT NOT NULL,
    file      TEXT NOT NULL,
    row       INTEGER,
    "column"  TEXT,
    code      TEXT NOT NULL,
    severity  TEXT NOT NULL,
    message   TEXT NOT NULL,
    value     TEXT
);
CREATE INDEX IF NOT EXISTS data_issues_run ON data_issues(run_id);

CREATE TABLE IF NOT EXISTS kpi_daily (
    date        TEXT NOT NULL,                -- YYYY-MM-DD
    store_code  TEXT NOT NULL,
    revenue     REAL NOT NULL,
    cogs        REAL NOT NULL,
    profit      REAL NOT NULL,
    orders      INTEGER NOT NULL,
    units       REAL NOT NULL,
    updated_run INTEGER NOT NULL,
    PRIMARY KEY (date, store_code)
);
"""


@dataclass(frozen=True)
class RunRecord:
    started_at: str
    finished_at: str
    status: str
    trigger: str
    source_hash: str | None
    reprocessed: bool
    files: list[dict]
    duration_ms: int
    rows_valid: int | None = None
    rows_rejected: int | None = None
    error_count: int | None = None
    warning_count: int | None = None
    error_message: str | None = None


class AnalyticsStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        # Mỗi thao tác mở một kết nối ngắn: an toàn khi API chạy nhiều luồng.
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    # --- Ghi ------------------------------------------------------------------------

    def save_run(
        self,
        run: RunRecord,
        *,
        snapshot: dict[str, Any] | None = None,
        as_of: str | None = None,
        issues: list[tuple[str, DataIssue]] | None = None,
        daily: list[dict] | None = None,
    ) -> tuple[int, int | None]:
        """Ghi một lần chạy và mọi thứ đi kèm trong MỘT giao dịch (transaction):
        hoặc ghi đủ, hoặc không ghi gì. Không bao giờ có snapshot mà thiếu nhật ký.

        Trả về (run_id, snapshot_version).
        """
        with self._connect() as db:
            cursor = db.execute(
                """INSERT INTO runs (started_at, finished_at, status, trigger, source_hash, reprocessed, files,
                                     rows_valid, rows_rejected, error_count, warning_count, duration_ms, error_message)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    run.started_at,
                    run.finished_at,
                    run.status,
                    run.trigger,
                    run.source_hash,
                    int(run.reprocessed),
                    json.dumps(run.files, ensure_ascii=False),
                    run.rows_valid,
                    run.rows_rejected,
                    run.error_count,
                    run.warning_count,
                    run.duration_ms,
                    run.error_message,
                ),
            )
            run_id = int(cursor.lastrowid)
            version = None
            if snapshot is not None:
                cursor = db.execute(
                    "INSERT INTO snapshots (run_id, created_at, as_of, source_hash, payload) VALUES (?, ?, ?, ?, ?)",
                    (run_id, run.finished_at, as_of, run.source_hash, "{}"),
                )
                version = int(cursor.lastrowid)
                # Ghi version vào chính payload để người đọc biết mình đang xem bản nào.
                payload = {**snapshot, "version": version, "run_id": run_id}
                db.execute(
                    "UPDATE snapshots SET payload = ? WHERE version = ?",
                    (json.dumps(payload, ensure_ascii=False, default=str), version),
                )
                db.execute("UPDATE runs SET snapshot_version = ? WHERE id = ?", (version, run_id))
            if issues:
                db.executemany(
                    'INSERT INTO data_issues (run_id, dataset, file, row, "column", code, severity, message, value) '
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        (run_id, issue.dataset, file, issue.row, issue.column, issue.code, issue.severity, issue.message,
                         None if issue.value is None else str(issue.value))
                        for file, issue in issues
                    ],
                )
            if daily:
                # Tính lại toàn bộ từ tệp nên thay hẳn bảng: ngày bị xóa khỏi tệp cũng biến mất ở đây.
                db.execute("DELETE FROM kpi_daily")
                db.executemany(
                    """INSERT INTO kpi_daily (date, store_code, revenue, cogs, profit, orders, units, updated_run)
                       VALUES (:date, :store_code, :revenue, :cogs, :profit, :orders, :units, :run_id)""",
                    [{**row, "run_id": run_id} for row in daily],
                )
            self._prune(db)
        return run_id, version

    def _prune(self, db: sqlite3.Connection) -> None:
        db.execute(
            "DELETE FROM snapshots WHERE version NOT IN (SELECT version FROM snapshots ORDER BY version DESC LIMIT ?)",
            (KEEP_SNAPSHOTS,),
        )
        db.execute(
            "DELETE FROM data_issues WHERE run_id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT ?)",
            (KEEP_ISSUE_RUNS,),
        )
        db.execute(
            """DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT ?)
                 AND id NOT IN (SELECT run_id FROM snapshots)""",
            (KEEP_RUNS,),
        )

    # --- Đọc ------------------------------------------------------------------------

    def latest_snapshot(self) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT payload FROM snapshots ORDER BY version DESC LIMIT 1").fetchone()
        return json.loads(row["payload"]) if row else None

    def latest_version(self) -> int | None:
        """Rẻ: Dashboard hỏi số này mỗi 30 giây, chỉ tải snapshot khi số tăng."""
        with self._connect() as db:
            row = db.execute("SELECT MAX(version) AS version FROM snapshots").fetchone()
        return row["version"]

    def latest_snapshot_meta(self) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT version, run_id, created_at, as_of, source_hash FROM snapshots ORDER BY version DESC LIMIT 1"
            ).fetchone()
        return dict(row) if row else None

    def recent_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM runs ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["files"] = json.loads(item["files"])
            item["reprocessed"] = bool(item["reprocessed"])
            result.append(item)
        return result

    def run_issues(self, run_id: int) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                'SELECT dataset, file, row, "column", code, severity, message, value FROM data_issues '
                "WHERE run_id = ? ORDER BY dataset, row",
                (run_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def latest_issues(self) -> dict[str, Any]:
        """Lỗi dữ liệu của lần gần nhất có đọc lại tệp (lần chỉ tính lại KPI không kiểm tra lại tệp)."""
        with self._connect() as db:
            row = db.execute(
                "SELECT id, finished_at FROM runs WHERE status = 'success' AND reprocessed = 1 ORDER BY id DESC LIMIT 1"
            ).fetchone()
        if not row:
            return {"run_id": None, "checked_at": None, "issues": []}
        return {"run_id": row["id"], "checked_at": row["finished_at"], "issues": self.run_issues(row["id"])}

    def daily_kpis(self, store_code: str | None = None, start: str | None = None, end: str | None = None) -> list[dict]:
        """Chỉ số theo ngày; store_code=None là cộng cả chuỗi."""
        conditions, params = [], []
        if store_code:
            conditions.append("store_code = ?")
            params.append(store_code)
        if start:
            conditions.append("date >= ?")
            params.append(start)
        if end:
            conditions.append("date < ?")
            params.append(end)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        with self._connect() as db:
            rows = db.execute(
                f"""SELECT date, SUM(revenue) AS revenue, SUM(cogs) AS cogs, SUM(profit) AS profit,
                           SUM(orders) AS orders, SUM(units) AS units
                      FROM kpi_daily {where} GROUP BY date ORDER BY date""",
                params,
            ).fetchall()
        return [dict(row) for row in rows]
