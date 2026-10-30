"""Cấu hình chung của analytics-service.

Mọi đường dẫn và ngưỡng đặt ở đây, không viết cứng trong code xử lý, để đổi
một chỗ là cả hệ thống đổi theo.
"""

from __future__ import annotations

from pathlib import Path
from zoneinfo import ZoneInfo

# Thư mục gốc của analytics-service (chứa main.py).
BASE_DIR = Path(__file__).resolve().parent.parent

# Thư mục nhân viên thả/cập nhật tệp Excel; bước 1.5 sẽ theo dõi thư mục này.
INBOX_DIR = BASE_DIR / "data" / "inbox"

# Dữ liệu mẫu do scripts/generate_sample_data.py sinh ra.
SAMPLES_DIR = BASE_DIR / "data" / "samples"

# Mọi khái niệm "hôm nay", "tuần này" đều tính theo giờ Việt Nam.
TIMEZONE = ZoneInfo("Asia/Ho_Chi_Minh")

# Giờ bán hàng lệch đồng hồ máy một chút vẫn chấp nhận; xa hơn là ngày tương lai, bị loại.
FUTURE_TOLERANCE_HOURS = 1
