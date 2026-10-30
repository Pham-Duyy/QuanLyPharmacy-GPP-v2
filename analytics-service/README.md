# analytics-service

Dịch vụ Python của **Pharmacy Intelligent Analytics**: theo dõi tệp dữ liệu, xử lý,
tính chỉ số kinh doanh. Không gọi LLM. Kiến trúc: [docs/analytics/architecture.md](../docs/analytics/architecture.md).

Hiện có: bước 1.1 (schema, dữ liệu mẫu), 1.2 (xử lý dữ liệu), 1.3 (KPI Engine), 1.4 (pipeline + SQLite), 1.5 (File Monitor), 1.6 (Analytics API), 1.7 (Bảng điều hành trên web); Phase 2: 2.1 (tệp tồn kho theo lô), 2.2 (phân tích sản phẩm).

## Cài đặt (một lần)

Cần Python 3.11 trở lên.

**Windows (PowerShell):**

```powershell
cd analytics-service
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Nếu báo *running scripts is disabled*, chạy một lần `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` rồi kích hoạt lại.

**macOS / Linux:**

```bash
cd analytics-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Mỗi lần mở cửa sổ dòng lệnh mới, kích hoạt lại môi trường (`.venv\Scripts\Activate.ps1` hoặc `source .venv/bin/activate`).

## Chạy thử

```bash
python scripts/generate_sample_data.py        # sinh data/samples/medicines.xlsx, sales.xlsx, inventory.xlsx
python main.py process                         # xử lý và in báo cáo lỗi dữ liệu
python main.py process --issues-csv data/reports/issues.csv
python main.py kpi                             # KPI hôm nay / tuần này / tháng này, toàn chuỗi
python main.py kpi --store CH03 --as-of "2026-10-29 21:00"
python main.py kpi --json                      # kết quả dạng JSON
python main.py products                        # top doanh thu/lợi nhuận, biên thấp, giảm mạnh, bán chậm, không bán được
python main.py products --store CH03 --period week
python main.py run                             # chạy pipeline, lưu snapshot vào data/analytics.db
python main.py run --force                     # đọc lại tệp dù không đổi
python main.py status                          # nhật ký các lần chạy
python -m pytest -q                            # chạy test
```

## Theo dõi tệp tự động (bước 1.5)

Cửa sổ 1, chuẩn bị dữ liệu trong thư mục được theo dõi rồi bật Monitor:

```bash
python scripts/generate_sample_data.py --out data/inbox --format csv
python main.py watch                           # Ctrl+C để dừng
```

Cửa sổ 2, giả lập nhân viên thêm hóa đơn (hoặc tự mở tệp bằng Excel, sửa, Lưu):

```bash
python scripts/simulate_sales.py --every 10 --orders 5
```

Monitor tự phát hiện mỗi lần lưu, chờ 2 giây cho tệp ghi xong rồi xử lý; `python main.py status`
cho thấy các lần chạy có nguồn `monitor`. Log ở `data/logs/monitor.log`.

## Analytics API (bước 1.6)

```bash
python main.py serve                           # API + Monitor; mở http://127.0.0.1:8000/docs
python main.py serve --no-monitor              # chỉ API, đọc snapshot có sẵn
```

Trang `/docs` liệt kê mọi endpoint, bấm "Try it out" để gọi thử. Ví dụ:
`http://127.0.0.1:8000/api/analytics/summary?store=CH03`,
`http://127.0.0.1:8000/api/analytics/sales-trend?grain=week`.

Dữ liệu mẫu cố ý có 12 dòng lỗi bán hàng, 2 dòng lỗi danh mục và 7 dòng lỗi tồn kho; báo cáo phải chỉ ra đủ.
`python scripts/generate_sample_data.py --errors 0` để có dữ liệu sạch.

## Bảng điều hành trên web (bước 1.7)

Cần ba cửa sổ dòng lệnh (PostgreSQL đã chạy như khi dùng phần mềm):

```bash
# 1. analytics-service
python main.py serve
# 2. thư mục server
npm run dev
# 3. thư mục client
npm run dev
```

Đăng nhập, mở **Báo cáo → Bảng điều hành**. Mở `data/inbox/sales.xlsx` bằng Excel, thêm dòng, Lưu:
trong vòng 60 giây số liệu trên trang tự đổi. `store_code` trong tệp phải trùng mã cửa hàng trong phần mềm
thì người chỉ được xem một cửa hàng mới thấy số của cửa hàng đó.

## Tồn kho theo lô (Phase 2, bước 2.1)

Đặt thêm `inventory.xlsx` (hoặc `.csv`) vào `data/inbox`: mỗi dòng là một lô đang có trong kho
(cửa hàng, mã thuốc, số lô, số lượng còn, hạn dùng; giá nhập, ngày nhập, nhà cung cấp không bắt buộc).
Không có tệp này thì phần bán hàng vẫn chạy như cũ. Cột và luật kiểm tra:
[docs/analytics/data-schema.md](../docs/analytics/data-schema.md#inventoryxlsx-phase-2-quyết-định-d7).

Tồn kho mẫu tính từ tốc độ bán thật và cố ý có: lô đã hết hạn còn trong kho (CH01 Metronidazol,
CH03 Loperamid), lô sắp hết hạn mà bán không kịp (CH02 Siro Prospan, CH03 Acetylcystein), thuốc sắp hết
(CH02 Paracetamol, CH01 Amlodipin), hết hàng (CH03 Vitamin C), tồn quá nhiều (CH01 Omega-3) và máy xông
TB010 chưa bán được cái nào. Các bước 2.3, 2.4 phải phát hiện ra đúng những chỗ này.

## Cấu trúc

```
app/
  config.py              đường dẫn, múi giờ
  processor/
    schemas.py           cột của từng tệp (hợp đồng dữ liệu)
    loader.py            đọc .xlsx/.csv, đổi tiêu đề về tên chuẩn
    cleaner.py           đổi giá trị thô về đúng kiểu (số, ngày, mã…)
    validator.py         luật nghiệp vụ, đánh dấu dòng lỗi
    service.py           nối các bước: process_file, process_folder
  analytics/
    periods.py           kỳ báo cáo: hôm nay, tuần này, tháng này và kỳ so sánh
    kpi.py               công thức KPI, tăng trưởng (docs/analytics/kpi.md)
    breakdown.py         chuỗi theo ngày/tuần/tháng, cơ cấu theo nhóm thuốc, cửa hàng…
    products.py          xếp hạng sản phẩm (bước 2.2)
    stock.py             tồn bán được: lô còn hạn
  store/sqlite_store.py  Analytics Store: runs, snapshots, data_issues, kpi_daily
  pipeline.py            Processor → KPI → Store, phát hiện tệp thay đổi
  monitor/watcher.py     theo dõi thư mục: sự kiện + debounce + polling dự phòng
  logging_setup.py       log ra màn hình và data/logs/
  analytics/daily.py     gộp kpi_daily thành chuỗi ngày/tuần/tháng
  api/routes.py          Analytics API (FastAPI), chỉ đọc
scripts/generate_sample_data.py, scripts/simulate_sales.py
tests/test_processor.py, test_kpi.py, test_products.py, test_pipeline.py, test_monitor.py, test_api.py
main.py                  lệnh chạy
```
