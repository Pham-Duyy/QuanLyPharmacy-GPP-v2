"""Ghi log ra màn hình và ra tệp (tự xoay vòng, không phình mãi)."""

from __future__ import annotations

import logging
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path

from app.config import LOG_DIR, TIMEZONE


def setup_logging(name: str = "analytics", log_file: Path | None = None, level: int = logging.INFO) -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:  # gọi lại nhiều lần (test) không nhân đôi dòng log
        return logger
    logger.setLevel(level)
    formatter = logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    # Giờ trong log luôn là giờ Việt Nam, kể cả khi máy chủ đặt múi giờ khác.
    formatter.converter = lambda seconds: datetime.fromtimestamp(seconds, TIMEZONE).timetuple()

    console = logging.StreamHandler()
    console.setFormatter(formatter)
    logger.addHandler(console)

    path = log_file or LOG_DIR / f"{name}.log"
    path.parent.mkdir(parents=True, exist_ok=True)
    # Tối đa 5 tệp × 1 MB; tệp cũ nhất tự bị xóa.
    file_handler = RotatingFileHandler(path, maxBytes=1_000_000, backupCount=5, encoding="utf-8")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)
    return logger
