"""Cấu hình chung của analytics-service.

Mọi đường dẫn và ngưỡng đặt ở đây, không viết cứng trong code xử lý, để đổi
một chỗ là cả hệ thống đổi theo.
"""

from __future__ import annotations

import os
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
# Số phiên bản tệp tồn kho giữ trong stock_history (luật R3 chỉ cần hai).
KEEP_STOCK_VERSIONS = 10

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

# --- Phân tích sản phẩm, tồn kho (Phase 2, quyết định D9) ---------------------------

# Tốc độ bán trung bình/ngày (ADS) và "bán chậm", "lâu không bán" đều nhìn 30 ngày gần nhất.
SALES_LOOKBACK_DAYS = 30

# Số dòng mỗi danh sách xếp hạng.
PRODUCT_TOP_N = 10

# "Giảm mạnh nhất" chỉ xét thuốc kỳ trước có từ ngần này đơn: tránh "giảm 100%"
# vì kỳ trước bán đúng một hộp.
DECLINE_MIN_ORDERS = 5

# "Lợi nhuận thấp" xếp theo biên lợi nhuận; chỉ xét thuốc có từ ngần này đơn trong kỳ.
LOW_MARGIN_MIN_ORDERS = 3

# Trạng thái tồn kho (bước 2.3): đủ bán dưới ngần này ngày là "sắp hết", trên là "tồn cao".
LOW_STOCK_DAYS = 7
HIGH_STOCK_DAYS = 90

# Hạn dùng 5 mức (bước 2.4; master prompt §14): số ngày còn lại tới hạn dùng.
#   < 0 đã hết hạn | 0–7 nguy cấp | 8–30 cảnh báo | 31–90 theo dõi | > 90 bình thường
EXPIRY_CRITICAL_DAYS = 7
EXPIRY_WARNING_DAYS = 30
EXPIRY_MONITOR_DAYS = 90
# Chỉ coi lô là "có nguy cơ" khi phần không kịp bán từ ngần này phần lô trở lên: 1 viên trong lô 50 viên
# là sai số làm tròn của tốc độ bán, không đáng một cảnh báo.
EXPIRY_RISK_MIN_SHARE = 0.05

# (Bước 2.5 từng có luật "doanh thu hôm nay giảm ≥ 20% so với hôm qua"; từ bước 3.3 thay bằng
# luật R1 + Z-score: so với cùng thứ, cùng giờ, có kiểm định số đơn.)

# --- Bất thường, dự báo (Phase 3; quyết định D10–D13) -------------------------------

# Cần ít nhất ngần này ngày đã trọn (4 tuần: mỗi thứ trong tuần có 4 lần) mới phát hiện bất thường, dự báo.
MIN_HISTORY_DAYS = 28
# Chuỗi theo ngày dài nhất dùng cho bất thường, dự báo (đủ 8 tuần mẫu + 14 ngày xét + dư).
SERIES_MAX_DAYS = 120

# Luật R1: doanh thu giảm từ ngần này % so với trung bình R1_WEEKS cùng thứ trước (cùng giờ nếu là hôm nay).
R1_DROP_PCT = 30.0
R1_WEEKS = 4
# ...và mức nền (trung bình các cùng thứ) có từ ngần này đơn: ít đơn thì % dao động mạnh.
R1_MIN_ORDERS = 10
# ...và SỐ ĐƠN cũng thấp tới mức ngẫu nhiên khó gây ra (Poisson, xác suất < R1_MAX_P). Doanh thu có
# "đuôi dài": hôm có hay không có khách mua máy đo huyết áp lệch ±20–30% dù lượng khách như thường;
# sự cố thật (mất điện, đóng cửa, thiếu người) thì luôn ít khách hơn hẳn.
R1_MAX_P = 0.01
# Số ngày đã trọn gần nhất được xét bất thường (ngoài hôm nay).
ANOMALY_LOOKBACK_DAYS = 14

# Luật R2: số lượng bán 7 ngày gần nhất của một thuốc giảm từ ngần này % so với trung bình
# một tuần của 28 ngày trước đó, VÀ số lần bán thấp tới mức dao động ngẫu nhiên khó gây ra
# (kiểm định Poisson, xác suất < R2_MAX_P). Ví dụ: thuốc thường bán 10 lần/tuần mà tuần này
# 5 lần thì khoảng 7% số tuần vẫn tự nhiên như vậy: không báo. Thường 18 lần mà còn 2: báo.
# 0,1% (không phải 1%) vì mỗi tuần kiểm ~180 cặp (cửa hàng, thuốc): 1% sẽ cho ~2 báo động giả/tuần.
# Mức kỳ vọng được điều chỉnh theo mức chung của cửa hàng: cả cửa hàng giảm 35% (R1 đã báo)
# thì chỉ báo thuốc giảm HƠN HẲN mức đó.
R2_DROP_PCT = 50.0
R2_RECENT_DAYS = 7
R2_BASE_DAYS = 28
R2_MIN_WEEKLY_LINES = 5
R2_MAX_P = 0.001

# Luật R3: giữa hai lần lưu tệp tồn kho, tồn một thuốc tăng hơn ngần này lần lượng bán 30 ngày.
R3_RATIO = 3.0

# Level 2 (bước 3.3): Z-score bền vững z = (giá trị − trung vị) / (1,4826 × MAD), |z| > Z_THRESHOLD là bất thường.
# 3,5 là ngưỡng chuẩn cho Z-score bền vững (Iglewicz & Hoaglin).
Z_THRESHOLD = 3.5
# Doanh thu: so với Z_WEEKS cùng thứ trước (cần ít nhất R1_WEEKS lần).
Z_WEEKS = 8
# Từng thuốc: so với Z_PRODUCT_BASE_DAYS ngày trước đó (bán lẻ tẻ nên không tách theo thứ),
# và số lần bán trong ngày phải cao tới mức ngẫu nhiên khó gây ra (Poisson, xác suất < Z_PRODUCT_MAX_P).
# 0,001% vì mỗi lần chạy kiểm ~180 cặp × 14 ngày ≈ 2.500 phép: 0,01% vẫn còn ~1 báo giả mỗi vài lần.
Z_PRODUCT_BASE_DAYS = 28
Z_PRODUCT_MAX_P = 0.00001
# Các ngày bất thường cùng loại cách nhau không quá ngần này ngày được gộp thành một đợt.
EPISODE_GAP_DAYS = 2
# Cảnh báo chỉ nêu đợt bất thường kết thúc trong ngần này ngày gần nhất (cũ hơn vẫn xem được ở danh sách).
ANOMALY_ALERT_DAYS = 7

# --- Dự báo (bước 3.4; quyết định D12) ------------------------------------------------

# Tầm dự báo (ngày). Độ chính xác đo ở tầm 7 ngày.
FORECAST_HORIZON_DAYS = 7
FORECAST_LONG_DAYS = 30
# Backtest: giả vờ đứng ở BACKTEST_FOLDS thời điểm quá khứ cách nhau 7 ngày, dự báo 7 ngày tiếp theo, so với số thật.
BACKTEST_FOLDS = 4
# Mô hình trung bình theo thứ dùng ngần này tuần; mô hình phẳng dùng ngần này ngày.
WEEKDAY_MEAN_WEEKS = 4
FLAT_MEAN_DAYS = 28

# Holt-Winters (bước 3.5): lưới tham số thử; chọn tổ hợp có sai số một bước thấp nhất trên dữ liệu học.
HW_ALPHAS = (0.1, 0.2, 0.4)   # tốc độ cập nhật MỨC
HW_BETAS = (0.01, 0.05, 0.15)  # tốc độ cập nhật XU HƯỚNG
HW_GAMMAS = (0.05, 0.15, 0.3)  # tốc độ cập nhật MÙA VỤ 7 ngày
# Xu hướng "tắt dần" (damped trend): mỗi ngày tới chỉ giữ 90% xu hướng của ngày trước. Dự báo 30 ngày
# của cửa hàng đang sụt không lao xuống 0 như đường thẳng kéo dài (Gardner & McKenzie).
HW_DAMPING = 0.9
# Khoảng tin cậy từ sai số backtest: phân vị 10% và 90% (khoảng 80%).
INTERVAL_QUANTILES = (0.1, 0.9)
# Số lần giữ dự báo đã tính trong forecast_cache.
KEEP_FORECASTS = 5

# --- Phân loại ABC–XYZ (Phase 5, bước 5.1; quyết định D20) ------------------------------

# ABC theo doanh thu ngần này ngày đã trọn gần nhất (cả bán lẻ và bán buôn).
ABC_DAYS = 90
# Ngưỡng tỷ trọng cộng dồn: thuốc nằm trong 80% doanh thu đầu là A, tới 95% là B, còn lại C.
# Thuốc làm vượt ngưỡng vẫn thuộc nhóm trên (ví dụ cộng dồn 78% → 83%: vẫn là A).
ABC_SHARES = (0.80, 0.95)
# XYZ theo hệ số biến thiên (độ lệch chuẩn / trung bình) của số lượng bán lẻ mỗi tuần, XYZ_WEEKS tuần trọn
# gần nhất; tuần trước lần bán đầu tiên không tính. Ít hơn XYZ_MIN_WEEKS tuần thì chưa xếp.
XYZ_WEEKS = 12
XYZ_MIN_WEEKS = 4
XYZ_LIMITS = (0.5, 1.0)  # ≤ 0,5: X ổn định; ≤ 1,0: Y dao động; > 1,0: Z thất thường
# Mức phục vụ (xác suất không hết hàng trong một chu kỳ đặt) theo ô ABC–XYZ, dùng cho tồn an toàn (bước 5.2).
# Thuốc chưa xếp được XYZ dùng cột Y.
SERVICE_LEVELS = {
    "AX": 0.98, "AY": 0.97, "AZ": 0.95,
    "BX": 0.95, "BY": 0.95, "BZ": 0.93,
    "CX": 0.93, "CY": 0.92, "CZ": 0.90,
}

# --- Gợi ý đặt hàng (Phase 5, bước 5.2; quyết định D19, D20) ----------------------------

# Mặc định khi tệp medicines không ghi pack_size / lead_time_days (cột tùy chọn).
REORDER_DEFAULT_PACK = 1
REORDER_DEFAULT_LEAD_DAYS = 2
LEAD_TIME_MAX_DAYS = 60
# Mỗi lần đặt mua đủ bán ngần này ngày (chu kỳ đặt hàng), cộng thêm thời gian chờ hàng về.
REORDER_COVER_DAYS = 7
# Thuốc chưa đo được sai số dự báo (ít lịch sử): coi sai số tổng 7 ngày là 50%.
REORDER_FALLBACK_ERROR = 0.5
# Sai số tuyệt đối trung bình → độ lệch chuẩn: σ ≈ 1,25 × MAE khi sai số gần phân phối chuẩn.
MAE_TO_SIGMA = 1.25
# Trần tồn sau khi đặt theo nhóm ABC (số ngày bán dự báo): hàng C đặt ít để khỏi đọng vốn, hết hạn.
REORDER_MAX_DAYS = {"C": 30}
# Tồn an toàn không vượt ngần này lần nhu cầu của kỳ: thuốc vừa hết hàng có số bán tụt về 0 (nhu cầu bị
# "che"), backtest đo ra sai số rất cao và đẩy tồn an toàn lên quá mức.
SAFETY_MAX_SHARE = 1.0

# --- Chuyển hàng giữa cửa hàng trước khi mua (Phase 5, bước 5.3) ------------------------

# Một lần chuyển phải bù được ít nhất ngần này phần của lượng đang thiếu, không thì không đáng một chuyến.
TRANSFER_MIN_SHARE = 0.2

# --- Nguồn dữ liệu (Phase 5, bước 5.5; quyết định D22) ----------------------------------

# files: thư mục tệp (data/inbox). postgres: đọc thẳng CSDL phần mềm qua view analytics_src.
ANALYTICS_SOURCE = os.environ.get("ANALYTICS_SOURCE", "files")
# Chuỗi kết nối tài khoản CHỈ ĐỌC analytics_reader (server/prisma/sql/analytics-reader.sql),
# ví dụ postgresql://analytics_reader:mat-khau@localhost:5432/pharmacy_gpp
ANALYTICS_PG_DSN = os.environ.get("ANALYTICS_PG_DSN")

# --- ML bên thách đấu (Phase 5, bước 5.6; quyết định D21) -------------------------------

# Mô hình học máy dự báo nhu cầu thuốc: TẮT mặc định, bật bằng ANALYTICS_ML=on (cần requirements-ml.txt).
# Đo ngoài mẫu trên dữ liệu mẫu 90 ngày (python main.py ml-check): không giảm sai số (30,3% → 30,5%,
# 30,0% → 30,2%, 28,0% → 28,1%) mà tính lâu gấp ~3 lần. Đo lại khi có dữ liệu thật dài hơn rồi mới bật.
ML_ENABLED = os.environ.get("ANALYTICS_ML", "off").lower() in ("on", "1", "true")
# Chỉ thay mô hình cổ điển cho thuốc nào mà ML có sai số tổng 7 ngày (backtest) thấp hơn ít nhất 10% (tương đối).
ML_MIN_IMPROVEMENT = 0.10
# Dữ liệu học: lấy mốc dự báo cách nhau ngần này ngày (đủ đa dạng, học nhanh).
ML_ORIGIN_STEP = 2
# Ngày lễ cố định (tháng-ngày) và mùng 1 Tết âm lịch các năm; ±ML_TET_WINDOW ngày quanh Tết tính là ngày lễ.
VN_FIXED_HOLIDAYS = ("01-01", "04-30", "05-01", "09-02")
VN_TET = ("2024-02-10", "2025-01-29", "2026-02-17", "2027-02-06", "2028-01-26", "2029-02-13", "2030-02-03")
ML_TET_WINDOW = 5
