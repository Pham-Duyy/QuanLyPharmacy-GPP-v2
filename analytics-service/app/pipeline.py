"""Pipeline: Processor → Analytics Engine → Analytics Store.

Đây là "dây chuyền" mà Monitor (bước 1.5) sẽ gọi mỗi khi tệp thay đổi.
Hai việc có giá khác nhau được tách riêng:
- Đọc + làm sạch tệp: tốn kém (giây). Chỉ làm khi nội dung tệp đổi.
- Tính KPI từ dữ liệu đã sạch: rẻ (mili giây). Làm lại khi snapshot đã cũ,
  vì "hôm nay", "tuần này" trôi theo đồng hồ dù tệp không đổi.

Không bước nào gọi LLM.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal

import pandas as pd

from app.analytics import kpi_summary, prepare_sales, sales_breakdown, sales_trend
from app.analytics.breakdown import bucket_start
from app.analytics.periods import Window, period_windows
from app.config import SNAPSHOT_REFRESH_SECONDS, TIMEZONE, TREND_DAYS
from app.processor import MEDICINES, SALES, LoadError, ProcessResult, process_folder
from app.processor.service import find_file, now_local
from app.store import AnalyticsStore, RunRecord

Trigger = Literal["manual", "monitor", "refresh"]
Status = Literal["processed", "refreshed", "unchanged", "failed"]


@dataclass(frozen=True)
class FileFingerprint:
    """Dấu nhận biết một tệp. So size + mtime trước (gần như miễn phí);
    chỉ khi khác mới tính sha256 (đọc cả tệp) để chắc nội dung thật sự đổi."""

    name: str
    size: int
    mtime: float
    sha256: str

    def to_dict(self) -> dict:
        return {"name": self.name, "size": self.size, "mtime": self.mtime, "sha256": self.sha256}


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass
class PipelineResult:
    status: Status
    message: str
    run_id: int | None = None
    snapshot_version: int | None = None
    duration_ms: int = 0
    results: dict[str, ProcessResult] = field(default_factory=dict)


@dataclass
class _Cache:
    """Dữ liệu đã làm sạch của lần đọc gần nhất, giữ trong bộ nhớ của tiến trình."""

    source_hash: str
    results: dict[str, ProcessResult]
    sales: pd.DataFrame


class Pipeline:
    def __init__(self, folder: Path, store: AnalyticsStore, *, refresh_seconds: int = SNAPSHOT_REFRESH_SECONDS):
        self.folder = Path(folder)
        self.store = store
        self.refresh_seconds = refresh_seconds
        self._cache: _Cache | None = None
        # Dấu nhận biết của bộ tệp đã có snapshot, và thời điểm của snapshot đó.
        self._known: dict[str, FileFingerprint] = {}
        self._known_hash: str | None = None
        self._snapshot_at: pd.Timestamp | None = None
        self._restore_from_store()

    def _restore_from_store(self) -> None:
        """Khởi động lại tiến trình vẫn nhớ tệp nào đã xử lý: đọc từ snapshot gần nhất,
        nên tệp không đổi thì không phải đọc lại chỉ vì vừa khởi động."""
        snapshot = self.store.latest_snapshot()
        if not snapshot or "source" not in snapshot:
            return
        self._known = {name: FileFingerprint(**data) for name, data in snapshot["source"].items()}
        self._known_hash = self._combined_hash(self._known)
        self._snapshot_at = pd.Timestamp(snapshot["as_of"])

    # --- Phát hiện thay đổi -----------------------------------------------------------

    def _fingerprints(self) -> dict[str, FileFingerprint]:
        found: dict[str, FileFingerprint] = {}
        for schema in (MEDICINES, SALES):
            path = find_file(self.folder, schema)
            if path is None:
                continue
            stat = path.stat()
            previous = self._known.get(schema.name)
            if previous and previous.name == path.name and previous.size == stat.st_size and previous.mtime == stat.st_mtime:
                found[schema.name] = previous  # size + mtime y nguyên: không cần đọc tệp để tính hash
            else:
                found[schema.name] = FileFingerprint(path.name, stat.st_size, stat.st_mtime, sha256_of(path))
        return found

    @staticmethod
    def _combined_hash(fingerprints: dict[str, FileFingerprint]) -> str:
        joined = "|".join(f"{name}:{fingerprint.sha256}" for name, fingerprint in sorted(fingerprints.items()))
        return hashlib.sha256(joined.encode()).hexdigest()

    # --- Chạy -----------------------------------------------------------------------

    def run(self, *, trigger: Trigger = "manual", as_of: pd.Timestamp | None = None, force: bool = False) -> PipelineResult:
        started = time.perf_counter()
        started_at = _now_text()
        moment = as_of or now_local()

        try:
            fingerprints = self._fingerprints()
            if "sales" not in fingerprints:
                raise LoadError(f"Không thấy sales.xlsx hoặc sales.csv trong {self.folder}")
            source_hash = self._combined_hash(fingerprints)
            same_source = self._known_hash == source_hash

            if same_source and not force and self._snapshot_at is not None:
                age = (moment - self._snapshot_at).total_seconds()
                if 0 <= age < self.refresh_seconds:
                    return PipelineResult("unchanged", "Tệp không đổi, snapshot còn mới: bỏ qua", duration_ms=_elapsed(started))

            # Dữ liệu sạch trong bộ nhớ chỉ dùng lại được khi đúng bộ tệp này.
            reprocessed = force or self._cache is None or self._cache.source_hash != source_hash
            if reprocessed:
                results = process_folder(self.folder, now=moment)
                medicines = results["medicines"].data if "medicines" in results else None
                sales = prepare_sales(results["sales"].data, medicines)
                self._cache = _Cache(source_hash, results, sales)
            cache = self._cache
            snapshot = build_snapshot(cache.sales, cache.results, moment, fingerprints)
            daily = daily_kpis(cache.sales)
        except (LoadError, FileNotFoundError, PermissionError) as error:
            # Tệp hỏng hoặc đang bị khóa: ghi nhận lỗi, GIỮ snapshot tốt gần nhất.
            run_id, _ = self.store.save_run(
                RunRecord(
                    started_at=started_at,
                    finished_at=_now_text(),
                    status="failed",
                    trigger=trigger,
                    source_hash=None,
                    reprocessed=True,
                    files=[],
                    duration_ms=_elapsed(started),
                    error_message=str(error),
                )
            )
            return PipelineResult("failed", str(error), run_id=run_id, duration_ms=_elapsed(started))

        results = cache.results
        issues = [(result.file, issue) for result in results.values() for issue in result.issues] if reprocessed else []
        files = [
            {**fingerprint.to_dict(), "rows_read": results[name].rows_read, "rows_valid": results[name].rows_valid}
            for name, fingerprint in fingerprints.items()
        ]
        run_id, version = self.store.save_run(
            RunRecord(
                started_at=started_at,
                finished_at=_now_text(),
                status="success",
                trigger=trigger,
                source_hash=cache.source_hash,
                reprocessed=reprocessed,
                files=files,
                duration_ms=_elapsed(started),
                rows_valid=results["sales"].rows_valid,
                rows_rejected=sum(result.rows_rejected for result in results.values()),
                error_count=sum(result.error_count for result in results.values()),
                warning_count=sum(result.warning_count for result in results.values()),
            ),
            snapshot=snapshot,
            as_of=moment.isoformat(),
            issues=issues,
            daily=daily if reprocessed else None,
        )
        self._snapshot_at = moment
        self._known, self._known_hash = fingerprints, cache.source_hash
        status: Status = "processed" if reprocessed else "refreshed"
        message = "Đã đọc lại tệp và tính KPI" if reprocessed else "Tệp không đổi: tính lại KPI theo giờ hiện tại"
        return PipelineResult(status, message, run_id, version, _elapsed(started), results)


def _now_text() -> str:
    """Giờ Việt Nam có ghi múi giờ, ví dụ 2026-10-30T16:25:09+07:00."""
    return datetime.now(TIMEZONE).isoformat(timespec="seconds")


def _elapsed(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)


# --- Nội dung snapshot ---------------------------------------------------------------


def build_snapshot(
    sales: pd.DataFrame,
    results: dict[str, ProcessResult],
    as_of: pd.Timestamp,
    fingerprints: dict[str, FileFingerprint],
) -> dict:
    """Mọi thứ Dashboard cần, tính sẵn. Dữ liệu sau as_of không được tính."""
    sales = sales[sales["sale_datetime"] < as_of]
    stores = sorted(sales["store_code"].dropna().unique().tolist())
    month = period_windows(as_of, "month").current
    trend_window = Window(as_of.normalize() - pd.Timedelta(days=TREND_DAYS - 1), as_of)
    twelve_months = Window((as_of.normalize() - pd.DateOffset(months=11)).replace(day=1), as_of)

    def scoped(store: str | None) -> pd.DataFrame:
        return sales if store is None else sales[sales["store_code"] == store]

    return {
        "generated_at": _now_text(),
        "as_of": as_of.isoformat(),
        "source": {name: fingerprint.to_dict() for name, fingerprint in fingerprints.items()},
        "data_quality": {
            name: {
                "file": result.file,
                "rows_read": result.rows_read,
                "rows_valid": result.rows_valid,
                "rows_rejected": result.rows_rejected,
                "errors": result.error_count,
                "warnings": result.warning_count,
                "by_code": result.issue_summary(),
            }
            for name, result in results.items()
        },
        "stores": stores,
        # "ALL" là toàn chuỗi; còn lại theo mã cửa hàng.
        "kpi": {"ALL": kpi_summary(sales, as_of), **{store: kpi_summary(sales, as_of, store) for store in stores}},
        "trend": {
            "daily": {"ALL": sales_trend(sales, trend_window, "day"), **{s: sales_trend(scoped(s), trend_window, "day") for s in stores}},
            "monthly": {"ALL": sales_trend(sales, twelve_months, "month")},
        },
        "breakdown_month": {
            "category": sales_breakdown(sales, month, "category"),
            "sale_type": sales_breakdown(sales, month, "sale_type"),
            "store": sales_breakdown(sales, month, "store_code"),
            "payment_method": sales_breakdown(sales, month, "payment_method"),
            "top_medicines": sales_breakdown(sales, month, "medicine_code", limit=20),
        },
    }


def daily_kpis(sales: pd.DataFrame) -> list[dict]:
    """Doanh thu, giá vốn, lợi nhuận, số đơn, số lượng theo ngày × cửa hàng, cho bảng kpi_daily."""
    frame = sales.assign(date=bucket_start(sales["sale_datetime"], "day").dt.strftime("%Y-%m-%d"))
    frame["revenue_with_cost"] = frame["revenue"].where(frame["cogs"].notna(), 0)
    grouped = frame.groupby(["date", "store_code"]).agg(
        revenue=("revenue", "sum"),
        revenue_with_cost=("revenue_with_cost", "sum"),
        cogs=("cogs", "sum"),
        orders=("sale_id", "nunique"),
        units=("quantity", "sum"),
    )
    grouped["profit"] = grouped["revenue_with_cost"] - grouped["cogs"]
    return [
        {
            "date": date,
            "store_code": store,
            "revenue": round(float(row.revenue), 2),
            "cogs": round(float(row.cogs), 2),
            "profit": round(float(row.profit), 2),
            "orders": int(row.orders),
            "units": round(float(row.units), 2),
        }
        for (date, store), row in grouped.iterrows()
    ]
