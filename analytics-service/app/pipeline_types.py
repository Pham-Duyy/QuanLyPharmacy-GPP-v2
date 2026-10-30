"""Kiểu dùng chung giữa pipeline và nguồn dữ liệu (tách riêng để hai bên import lẫn nhau không vòng)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path


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
