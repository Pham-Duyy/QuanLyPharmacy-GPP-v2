# analytics-service

Dịch vụ Python của **Pharmacy Intelligent Analytics**: theo dõi tệp dữ liệu, xử lý,
tính chỉ số kinh doanh. Không gọi LLM. Kiến trúc: [docs/analytics/architecture.md](../docs/analytics/architecture.md).

Hiện có: bước 1.1 (schema, dữ liệu mẫu) và 1.2 (xử lý dữ liệu).

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
python scripts/generate_sample_data.py        # sinh data/samples/medicines.xlsx và sales.xlsx
python main.py process                         # xử lý và in báo cáo lỗi dữ liệu
python main.py process --issues-csv data/reports/issues.csv
python -m pytest -q                            # chạy test
```

Dữ liệu mẫu cố ý có 12 dòng lỗi bán hàng và 2 dòng lỗi danh mục; báo cáo phải chỉ ra đủ.
`python scripts/generate_sample_data.py --errors 0` để có dữ liệu sạch.

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
scripts/generate_sample_data.py
tests/test_processor.py
main.py                  lệnh chạy
```
