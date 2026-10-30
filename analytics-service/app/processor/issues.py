"""Lỗi dữ liệu (data issue) phát hiện khi xử lý tệp.

Một dòng sai không làm hỏng cả tệp: dòng đó được ghi lại ở đây kèm vị trí và
lý do, phần còn lại vẫn được phân tích.
- error: dòng bị loại khỏi phân tích (ví dụ số lượng âm).
- warning: dòng vẫn dùng nhưng đáng xem lại (ví dụ bán dưới giá vốn).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal

Severity = Literal["error", "warning"]


@dataclass(frozen=True)
class DataIssue:
    dataset: str
    # Số dòng như người dùng thấy trong Excel (dòng 1 là tiêu đề); None là lỗi cả tệp.
    row: int | None
    column: str | None
    code: str
    severity: Severity
    message: str
    value: Any = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["value"] = None if self.value is None else str(self.value)
        return data
