"""File Monitor: theo dõi thư mục dữ liệu, tự chạy pipeline khi tệp được lưu.

Hai nguồn kích hoạt:
1. Sự kiện (watchdog): hệ điều hành báo ngay khi tệp đổi. Có debounce: chờ
   yên lặng vài giây vì một lần bấm Lưu của Excel sinh nhiều sự kiện.
2. Polling dự phòng: gọi pipeline định kỳ để bắt sự kiện bị lỡ (OneDrive, ổ
   mạng) và làm mới KPI theo giờ. Pipeline tự so size/mtime nên rất rẻ.

Thiết kế luồng: watchdog chạy ở luồng riêng và CHỈ ghi lại "có sự kiện lúc X".
Pipeline luôn chạy ở vòng lặp chính, một luồng duy nhất, nên không bao giờ có
hai lần ghi SQLite cùng lúc.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from app.config import (
    MONITOR_DEBOUNCE_SECONDS,
    MONITOR_MAX_RETRIES,
    MONITOR_POLL_SECONDS,
    MONITOR_RETRY_SECONDS,
)
from app.pipeline import Pipeline, PipelineResult
from app.processor import SCHEMAS

WATCHED_STEMS = {schema.file_stem for schema in SCHEMAS.values()}
WATCHED_SUFFIXES = {".xlsx", ".csv"}
# Chỉ sự kiện làm đổi nội dung. watchdog còn báo "opened", "closed_no_write" khi có
# người MỞ ĐỂ ĐỌC tệp, kể cả chính pipeline, nếu nhận cả chúng sẽ tự kích hoạt vòng lặp.
CHANGE_EVENTS = {"created", "modified", "moved", "deleted", "closed"}


def is_relevant(path: str | Path) -> bool:
    """sales.xlsx, medicines.csv… là tệp cần theo dõi; tệp tạm của Excel thì không.

    Excel tạo "~$sales.xlsx" (tệp khóa khi đang mở) và tệp tạm tên ngẫu nhiên
    không có đuôi khi lưu; cả hai đều bị bỏ qua.
    """
    name = Path(path).name
    if name.startswith(("~$", ".~", ".")):
        return False
    stem, suffix = Path(name).stem.lower(), Path(name).suffix.lower()
    return stem in WATCHED_STEMS and suffix in WATCHED_SUFFIXES


@dataclass
class MonitorStats:
    events: int = 0
    runs: dict[str, int] = field(default_factory=lambda: {"processed": 0, "refreshed": 0, "unchanged": 0, "failed": 0})
    last_result: PipelineResult | None = None
    last_latency_ms: int | None = None


class Monitor:
    def __init__(
        self,
        folder: Path,
        pipeline: Pipeline,
        *,
        debounce_seconds: float = MONITOR_DEBOUNCE_SECONDS,
        poll_seconds: float = MONITOR_POLL_SECONDS,
        retry_seconds: float = MONITOR_RETRY_SECONDS,
        max_retries: int = MONITOR_MAX_RETRIES,
        use_events: bool = True,
        logger: logging.Logger | None = None,
    ):
        self.folder = Path(folder)
        self.pipeline = pipeline
        self.debounce_seconds = debounce_seconds
        self.poll_seconds = poll_seconds
        self.retry_seconds = retry_seconds
        self.max_retries = max_retries
        self.use_events = use_events
        self.log = logger or logging.getLogger("analytics")
        self.stats = MonitorStats()

        self._lock = threading.Lock()
        self._first_event_at: float | None = None  # sự kiện đầu tiên của đợt thay đổi đang chờ
        self._last_event_at: float | None = None
        self._retries = 0
        self._retry_at: float | None = None
        self._stop = threading.Event()
        self._observer = None
        self._last_poll = time.monotonic()

    # --- Nhận sự kiện (chạy ở luồng của watchdog) ---------------------------------------

    def notify(self, path: str | Path, kind: str = "modified") -> None:
        """Ghi nhận một sự kiện. Chỉ cập nhật mốc thời gian, không xử lý gì ở đây."""
        if not is_relevant(path):
            return
        now = time.monotonic()
        with self._lock:
            self.stats.events += 1
            if self._first_event_at is None:
                self._first_event_at = now
            self._last_event_at = now
        self.log.debug("Sự kiện %s: %s", kind, Path(path).name)

    def _start_observer(self) -> None:
        if not self.use_events:
            self.log.info("Chỉ dùng polling mỗi %.0f giây (không theo dõi sự kiện)", self.poll_seconds)
            return
        try:
            from watchdog.events import FileSystemEventHandler
            from watchdog.observers import Observer
        except ImportError:
            self.log.warning("Chưa cài watchdog: chuyển sang chỉ dùng polling mỗi %.0f giây", self.poll_seconds)
            return

        monitor = self

        class Handler(FileSystemEventHandler):
            def on_any_event(self, event):  # noqa: ANN001 - kiểu sự kiện của watchdog
                if event.is_directory or event.event_type not in CHANGE_EVENTS:
                    return
                monitor.notify(event.src_path, event.event_type)
                # Excel lưu bằng cách đổi tên tệp tạm thành sales.xlsx: đích của "moved" mới là tệp thật.
                destination = getattr(event, "dest_path", "")
                if destination:
                    monitor.notify(destination, event.event_type)

        try:
            observer = Observer()
            observer.schedule(Handler(), str(self.folder), recursive=False)
            observer.start()
            self._observer = observer
            self.log.info("Theo dõi sự kiện trong %s (debounce %.1f giây)", self.folder, self.debounce_seconds)
        except OSError as error:  # ví dụ ổ mạng không hỗ trợ sự kiện
            self.log.warning("Không theo dõi sự kiện được (%s): chỉ dùng polling", error)

    # --- Vòng lặp chính -----------------------------------------------------------------

    def _files_stable(self) -> bool:
        """Kích thước các tệp đứng yên qua hai lần đo: Excel đã ghi xong."""

        def sizes() -> dict[str, int]:
            result = {}
            for path in self.folder.iterdir():
                if is_relevant(path):
                    try:
                        result[path.name] = path.stat().st_size
                    except FileNotFoundError:  # đúng lúc Excel đổi tên tệp
                        result[path.name] = -1
            return result

        first = sizes()
        time.sleep(min(0.5, self.debounce_seconds / 2))
        return first == sizes() and -1 not in first.values()

    def _run(self, trigger: str, latency_from: float | None = None) -> PipelineResult:
        result = self.pipeline.run(trigger=trigger)  # type: ignore[arg-type]
        self.stats.runs[result.status] += 1
        self.stats.last_result = result
        if result.status == "unchanged":
            self.log.debug("Polling: tệp không đổi")
        elif result.status == "failed":
            self.log.error("Pipeline thất bại (%s): %s", trigger, result.message)
        else:
            latency = ""
            if latency_from is not None:
                self.stats.last_latency_ms = round((time.monotonic() - latency_from) * 1000)
                latency = f", từ lúc lưu tệp tới lúc có snapshot: {self.stats.last_latency_ms} ms"
            quality = ""
            if result.results.get("sales"):
                sales = result.results["sales"]
                valid = f"{sales.rows_valid:,}".replace(",", ".")
                quality = f", {valid} dòng hợp lệ, {sales.error_count} lỗi"
            self.log.info(
                "%s: snapshot version %s (%s, %s ms%s%s)",
                result.message,
                result.snapshot_version,
                trigger,
                result.duration_ms,
                quality,
                latency,
            )
        return result

    def tick(self) -> None:
        """Một vòng kiểm tra; vòng lặp chính gọi liên tục. Tách riêng để dễ test."""
        now = time.monotonic()
        with self._lock:
            first, last = self._first_event_at, self._last_event_at

        if last is not None and now - last >= self.debounce_seconds and (self._retry_at is None or now >= self._retry_at):
            if not self._files_stable():
                self.log.debug("Tệp còn đang được ghi, chờ thêm")
                with self._lock:
                    self._last_event_at = time.monotonic()
                return
            with self._lock:
                # Sự kiện đến trong lúc đo độ ổn định thì để vòng sau.
                if self._last_event_at != last:
                    return
                self._first_event_at = self._last_event_at = None
            self.log.info("Phát hiện tệp thay đổi, bắt đầu xử lý")
            result = self._run("monitor", latency_from=first)
            self._last_poll = time.monotonic()
            if result.status == "failed" and self._retries < self.max_retries:
                # Thường là Excel còn giữ khóa tệp: thử lại sau ít giây.
                self._retries += 1
                self._retry_at = time.monotonic() + self.retry_seconds
                with self._lock:
                    if self._last_event_at is None:
                        self._first_event_at = self._last_event_at = time.monotonic()
                self.log.warning("Sẽ thử lại lần %s/%s sau %.0f giây", self._retries, self.max_retries, self.retry_seconds)
            else:
                self._retries, self._retry_at = 0, None
            return

        if now - self._last_poll >= self.poll_seconds:
            self._last_poll = now
            self._run("refresh")

    def run_forever(self, stop: threading.Event | None = None) -> None:
        """Chạy tới khi stop được bật hoặc nhấn Ctrl+C."""
        stop = stop or self._stop
        self._start_observer()
        # Lần đầu: xử lý ngay để có snapshot, không đợi tới lượt polling.
        self._last_poll = time.monotonic()
        self._run("monitor")
        try:
            while not stop.is_set():
                self.tick()
                stop.wait(0.25)
        finally:
            self.close()

    def stop(self) -> None:
        self._stop.set()

    def close(self) -> None:
        if self._observer is not None:
            self._observer.stop()
            self._observer.join(timeout=5)
            self._observer = None
