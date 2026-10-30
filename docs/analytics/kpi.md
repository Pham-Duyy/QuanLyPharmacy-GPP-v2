# KPI Engine: công thức và quy ước

Code: `analytics-service/app/analytics/` (`periods.py`, `kpi.py`, `breakdown.py`).
Toàn bộ là phép tính tất định trên pandas, **không gọi LLM**.

## Chỉ số

Tính trên các dòng bán hàng đã qua bước kiểm tra dữ liệu (dòng lỗi bị loại).

| Chỉ số | Công thức | Ghi chú |
|---|---|---|
| Doanh thu (Revenue) | Σ quantity × selling_price | `selling_price` là đơn giá sau giảm |
| Giá vốn (COGS) | Σ quantity × purchase_price | Chỉ trên dòng có giá vốn |
| Lợi nhuận gộp (Profit) | Doanh thu (của dòng có giá vốn) − COGS | |
| Biên lợi nhuận (Margin) | Profit / Doanh thu có giá vốn × 100 | Không có doanh thu: không tính |
| Số đơn (Orders) | Số `sale_id` khác nhau | Một hóa đơn nhiều dòng vẫn là một đơn |
| Số lượng bán (Units) | Σ quantity | Đơn vị bán nhỏ nhất (viên, gói…) |
| Giá trị đơn trung bình (AOV) | Doanh thu / Số đơn | |
| Độ phủ giá vốn | Doanh thu có giá vốn / Doanh thu × 100 | Dưới 100% thì lợi nhuận chỉ phản ánh phần có giá vốn |
| Tăng trưởng (Growth) | (Kỳ này − Kỳ trước) / \|Kỳ trước\| × 100 | Kỳ trước = 0: không tính (trả `null`) |

**Vì sao dòng thiếu giá vốn không tính là giá vốn 0:** coi giá vốn bằng 0 sẽ biến cả doanh thu
dòng đó thành lợi nhuận, làm biên lợi nhuận cao giả. Hệ thống tính lợi nhuận trên phần có giá vốn
và báo rõ độ phủ.

## Kỳ báo cáo

Giờ Việt Nam. Tuần bắt đầu thứ Hai. Khoảng thời gian là nửa mở `[bắt đầu, kết thúc)`.
Dữ liệu sau thời điểm tính (`as_of`) không được tính.

| Kỳ | Kỳ hiện tại | Kỳ so sánh (cùng độ dài, dùng tính tăng trưởng) | Kỳ trước trọn vẹn (để hiển thị) |
|---|---|---|---|
| Ngày | 00:00 hôm nay → as_of | 00:00 hôm qua → cùng giờ hôm qua | Cả ngày hôm qua |
| Tuần | thứ Hai 00:00 → as_of | thứ Hai tuần trước → cùng thời điểm tuần trước | Cả tuần trước |
| Tháng | ngày 1 00:00 → as_of | ngày 1 tháng trước → cùng ngày giờ tháng trước | Cả tháng trước |

Ví dụ as_of = thứ Sáu 30/10/2026 15:00, kỳ tuần: so 26/10 00:00 → 30/10 15:00 với
19/10 00:00 → 23/10 15:00. Nếu so với *cả* tuần trước, giữa tuần lúc nào cũng thấy "giảm".

Tháng trước ngắn hơn (ví dụ 31/10 so với tháng 9 chỉ có 30 ngày) thì kỳ so sánh dừng ở hết tháng trước.

## Chuỗi thời gian và cơ cấu

- `sales_trend(window, grain)`: doanh thu, lợi nhuận, số đơn, số lượng theo ngày/tuần/tháng.
  Kỳ không có giao dịch vẫn có mặt với giá trị 0.
- `sales_breakdown(window, by)`: theo `category` (nhóm thuốc), `sale_type` (bán lẻ/bán buôn),
  `store_code`, `medicine_code`, `payment_method`; xếp giảm dần theo doanh thu, kèm tỷ trọng %.

## Kiểm chứng

`analytics-service/tests/test_kpi.py`:
- Bộ dữ liệu nhỏ có đáp án tính tay: doanh thu 28.000, giá vốn 15.000, lợi nhuận 7.000,
  biên 31,82%, độ phủ 78,57%, tăng trưởng so với cùng giờ hôm qua…
- Đối chiếu kiểu PivotTable: một cách tính thứ hai bằng vòng lặp Python thuần (không pandas)
  trên dữ liệu mẫu 70 ngày, cho 3 thời điểm tính × 3 kỳ × 3 khoảng; mọi chỉ số khớp tới 0,01 đ.

Kiểm tra bằng Excel: mở `data/samples/sales.xlsx`, thêm cột `= quantity × selling_price`,
tạo PivotTable lọc theo `sale_datetime` của kỳ cần xem; tổng phải bằng `python main.py kpi`
(trừ các dòng lỗi mà Processor đã loại, xem `python main.py process`).

## Phân tích sản phẩm (Phase 2, bước 2.2)

Code: `analytics-service/app/analytics/products.py`. Lệnh xem: `python main.py products [--store CH01] [--period week]`.
Gộp theo thuốc bằng đúng công thức ở trên (lợi nhuận, biên chỉ trên dòng có giá vốn).

| Danh sách | Phạm vi thời gian | Cách xếp | Điều kiện |
|---|---|---|---|
| Doanh thu cao nhất | hôm nay / tuần / tháng | doanh thu giảm dần | |
| Lợi nhuận cao nhất | như trên | lợi nhuận giảm dần | |
| Biên lợi nhuận thấp nhất | như trên | biên tăng dần | ≥ 3 đơn trong kỳ, có giá vốn |
| Giảm doanh thu mạnh nhất | như trên, so với kỳ trước **cùng độ dài** | tăng trưởng tăng dần | kỳ trước ≥ 5 đơn; kỳ này không bán = −100% |
| Bán chậm | 30 ngày gần nhất | doanh thu tăng dần | còn tồn bán được và có bán |
| Không bán được | 30 ngày gần nhất | chưa bán bao giờ trước, rồi lâu nhất | còn tồn bán được, 0 đơn trong 30 ngày |

- "Bán chậm" xếp theo **tiền**, không theo số lượng: 20 viên và 2 máy đo huyết áp không so được với nhau.
- Có `inventory.xlsx`: chỉ xét thuốc còn tồn bán được (lô còn hạn), vì đó là vốn đang đọng.
  Chưa có: xét thuốc từng bán ở phạm vi đó (`basis = "sales_history"`), không có số tồn.
- Giá trị tồn = Σ số lượng × giá nhập; lô thiếu giá nhập thì giá trị để trống, không đoán bằng 0.
- Toàn chuỗi cộng mọi cửa hàng: một thuốc "chết" ở CH03 nhưng bán chạy ở CH01 không hiện ở toàn chuỗi
  (xem theo từng cửa hàng để thấy).
- Ngưỡng ở `app/config.py`: `SALES_LOOKBACK_DAYS`, `PRODUCT_TOP_N`, `DECLINE_MIN_ORDERS`, `LOW_MARGIN_MIN_ORDERS`.

