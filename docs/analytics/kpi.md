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

## Phân tích tồn kho (Phase 2, bước 2.3)

Code: `analytics-service/app/analytics/inventory.py`. Lệnh xem: `python main.py inventory [--store CH01] [--status low]`.

```
Tồn hiện tại   = Σ số lượng các lô CÒN HẠN (lô hết hạn không bán được, bước 2.4 xử lý riêng)
ADS            = số lượng bán 30 ngày gần nhất / 30
Số ngày tồn    = Tồn hiện tại / ADS          (ADS = 0: không tính)
Giá trị tồn    = Σ số lượng × giá nhập       (thiếu giá nhập: để trống, không đoán)
```

| Trạng thái | Điều kiện (xét theo thứ tự) |
|---|---|
| Hết hàng | tồn = 0 nhưng 30 ngày qua có bán |
| Tồn chết | còn tồn, 30 ngày không bán |
| Sắp hết | tồn < `min_stock` hoặc số ngày tồn < 7 |
| Tồn cao | tồn > `max_stock` hoặc số ngày tồn > 90 |
| Bình thường | còn lại |

- "Sắp hết" xét trước "tồn cao": dưới mức tối thiểu thì phải nhập dù đang bán chậm.
- `min_stock > max_stock` (danh mục gõ nhầm, Processor cảnh báo `min_above_max`): bỏ cả hai mức, chỉ xét số ngày tồn.
- Trạng thái luôn tính **theo cửa hàng**. Toàn chuỗi là danh sách mọi cửa hàng, không cộng tồn các nơi:
  CH01 còn 300 hộp không cứu được CH02 đang hết.
- Tồn lấy từ tệp tại lúc lưu (quyết định D7); hàng bán sau lúc đó chưa được trừ.
- Dòng tồn kho bị Processor loại vì lỗi thì không được tính: một lô ghi số âm có thể làm thuốc hiện "hết hàng".
  Xem khung Chất lượng dữ liệu khi thấy kết quả lạ.

## Hạn dùng và FEFO (Phase 2, bước 2.4)

Code: `analytics-service/app/analytics/expiry.py`. Lệnh xem: `python main.py expiry [--store CH02]`.

| Mức | Số ngày còn lại (hạn − hôm nay) |
|---|---|
| Đã hết hạn | < 0 |
| Nguy cấp | 0–7 (hạn đúng hôm nay là 0: chưa hết hạn) |
| Cảnh báo | 8–30 |
| Theo dõi | 31–90 |
| Bình thường | > 90 |

**FEFO.** Mỗi thuốc ở mỗi cửa hàng: xếp lô còn hạn theo hạn gần trước (lô số 1 bán trước), giả định bán đúng
thứ tự đó với tốc độ ADS 30 ngày:

```
đã_dùng = 0
mỗi lô theo hạn tăng dần:
    bán_được   = min(số lượng, max(0, ngày_còn_lại − đã_dùng) × ADS)
    có_nguy_cơ = số lượng − bán_được        (× giá nhập = tiền có thể mất)
    đã_dùng   += số lượng / ADS
```

Ví dụ ADS 10: lô A 50 hộp còn 7 ngày bán hết sau 5 ngày, an toàn; lô B 200 hộp còn 12 ngày chỉ còn 7 ngày bán,
được 70, **130 hộp có nguy cơ**. Chỉ nhìn "lô B còn 12 ngày" thì không thấy.

- Chỉ kết luận "có nguy cơ" cho lô còn ≤ 90 ngày; xa hơn thì đoán tốc độ bán không đáng tin.
- Thận trọng: số ngày để bán = số ngày còn lại, không cộng phần còn lại của hôm nay.
- Lô đã hết hạn không được bán, không chiếm thời gian bán của lô sau; tiền của nó tính riêng ở mức "Đã hết hạn".
- Không ai mua (ADS = 0): cả lô còn ≤ 90 ngày là nguy cơ.
- Số lượng nguy cơ làm tròn tới đơn vị; lô thiếu giá nhập thì tổng tiền để trống.

## Bất thường theo luật (Phase 3, bước 3.2)

Code: `analytics-service/app/analytics/anomaly.py`. Lệnh xem: `python main.py anomalies [--store CH01]`.

| Luật | So sánh | Điều kiện chống báo giả |
|---|---|---|
| R1 doanh thu giảm > 30% | Hôm nay đến giờ này với trung bình 4 cùng thứ trước **cùng giờ**; 14 ngày đã trọn gần nhất với trung bình 4 cùng thứ trước | Nền ≥ 10 đơn; **số đơn** cũng thấp tới mức ngẫu nhiên khó gây ra (Poisson, xác suất < 1%) |
| R2 lượng bán một thuốc giảm > 50% | 7 ngày đã trọn gần nhất với trung bình một tuần của 28 ngày trước đó, theo cửa hàng | Thuốc có từ đầu khoảng nền, ≥ 5 dòng bán/tuần; **số lần bán** thấp tới mức xác suất ngẫu nhiên < 0,1%, so với kỳ vọng đã điều chỉnh theo mức chung của cửa hàng |
| R3 tồn tăng bất thường | Tồn giữa hai lần lưu `inventory.xlsx` (bảng `stock_history`) | Tăng > 3 lần lượng bán 30 ngày và ≥ `min_stock`; chỉ ở mức "thấp", cần xem lại |

Vì sao có các điều kiện phụ (đã đo trên 8 bộ dữ liệu mẫu ngẫu nhiên):

- **Chỉ tính bán lẻ.** Một đơn bán buôn (10 máy đo huyết áp = 8 triệu) bằng cả ngày bán lẻ; rơi vào tuần nền là
  "trung bình" đội lên, mọi ngày sau trông như tụt. Chưa loại bán buôn: R2 báo 15 thuốc, R1 báo nhiều ngày giả.
- **Kiểm định Poisson cho số đơn / số lần bán.** X ~ Poisson(λ) mô tả số lần một việc ngẫu nhiên xảy ra khi trung bình
  là λ; P(X ≤ k) cho biết "bán ≤ k lần" hiếm cỡ nào. Thuốc thường bán 10 lần/tuần mà còn 5: P ≈ 7%, tự nhiên, không báo.
  Thường 18 lần mà còn 2: P < 0,001%, báo. Ngưỡng R2 là 0,1% vì mỗi tuần kiểm ~180 cặp (cửa hàng, thuốc).
- **R1 cần số đơn thấp, không chỉ doanh thu thấp.** Doanh thu có "đuôi dài": hôm có hay không có khách mua máy đo huyết
  áp lệch ±20–30% dù lượng khách như thường. Sự cố thật (mất điện, đóng cửa) luôn đi kèm ít khách hơn hẳn.
- **R2 so với mức chung của cửa hàng.** Cửa hàng giảm 35% (R1 đã báo) thì mọi thuốc giảm theo; chỉ báo thuốc giảm hơn hẳn.

Kết quả trên 8 bộ dữ liệu mẫu: R1 ở CH01 bắt đúng ngày mất điện và không gì khác; R2 bắt đúng Amoxicillin CH02 ngừng bán
và không thuốc nào khác; CH03 sụt 35% (câu chuyện thật) được R1 báo 0–5 ngày.

