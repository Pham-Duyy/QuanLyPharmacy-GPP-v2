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

# --- Analytics Store (bước 1.4) ---------------------------------------------------

# Tệp SQLite chứa kết quả đã tính; Dashboard và AI Agent chỉ đọc từ đây.
ANALYTICS_DB = BASE_DIR / "data" / "analytics.db"

# Tệp không đổi vẫn tính lại KPI sau ngần này giây, vì "hôm nay", "tuần này"
# trôi theo đồng hồ (qua nửa đêm thì "hôm nay" phải về 0).
SNAPSHOT_REFRESH_SECONDS = 300

# Giới hạn dung lượng: chỉ giữ lịch sử gần đây.
KEEP_SNAPSHOTS = 30
KEEP_RUNS = 200
KEEP_ISSUE_RUNS = 20

# Số ngày của chuỗi doanh thu theo ngày trong snapshot (biểu đồ đường).
TREND_DAYS = 90

# --- Monitor (bước 1.5) -------------------------------------------------------------

LOG_DIR = BASE_DIR / "data" / "logs"

# Gặp sự kiện tệp thay đổi thì chờ yên lặng ngần này giây mới xử lý: một lần
# bấm Lưu trong Excel sinh ra nhiều sự kiện liên tiếp (tệp tạm, đổi tên, xóa).
MONITOR_DEBOUNCE_SECONDS = 2.0

# Polling dự phòng: bắt sự kiện bị lỡ (OneDrive, ổ mạng) và làm mới KPI theo giờ.
MONITOR_POLL_SECONDS = 30.0

# Tệp đang bị khóa (Excel đang ghi): thử lại sau ngần này giây, tối đa số lần.
MONITOR_RETRY_SECONDS = 5.0
MONITOR_MAX_RETRIES = 3
