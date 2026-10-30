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

## Bất thường Level 2 và gộp sự kiện (Phase 3, bước 3.3)

Code: `analytics-service/app/analytics/anomaly_stats.py` (Z-score), `anomaly_events.py` (gộp).
Lệnh `python main.py anomalies` giờ in cả hai cấp.

```
z = (giá trị − trung vị) / (1,4826 × MAD)        MAD = trung vị |mẫu − trung vị|
```

Trung vị/MAD thay cho trung bình/độ lệch chuẩn: một ngày mất điện nằm trong mẫu kéo trung bình lệch và che bất thường
khác; trung vị gần như không đổi. 1,4826 đưa MAD về cùng thang với độ lệch chuẩn. Ngưỡng |z| > 3,5 (Iglewicz & Hoaglin).

| Đối tượng | Mẫu so | Điều kiện thêm |
|---|---|---|
| Doanh thu bán lẻ mỗi cửa hàng (tụt và tăng vọt) | 8 cùng thứ trước | Lệch ≥ 30% (đủ lớn, không chỉ hiếm); số đơn cũng lệch bất thường (Poisson < 1%) |
| Từng thuốc ở từng cửa hàng (chỉ tăng vọt; tụt đã có R2) | 28 ngày trước | Số lần bán trong ngày hiếm tới mức xác suất < 0,001% (~2.500 phép kiểm mỗi lần chạy) |

**Gộp.** Cùng nơi, cùng ngày, cùng chiều mà cả R1 và Z-score phát hiện thì là một bất thường có hai bằng chứng
(`[R1+z]`). Các ngày bất thường cùng loại cách nhau ≤ 2 ngày gộp thành một **đợt**, lấy ngày lệch nhiều nhất làm đại diện.

**Cảnh báo.** Đợt kết thúc trong 7 ngày gần nhất đi vào khối Cảnh báo: "bất thường giảm" (trung bình), "bất thường
tăng vọt" (thấp), "tồn kho tăng bất thường" (thấp, mục tồn kho). Luật cũ của bước 2.5 "doanh thu hôm nay giảm ≥ 20% so
với hôm qua" được thay bằng R1 (so cùng thứ, cùng giờ, có kiểm định số đơn).

Đo trên 8 bộ dữ liệu mẫu ngẫu nhiên: ngày mất điện 8/8, Amoxicillin ngừng bán 8/8, khẩu trang tăng vọt 7/8 (bộ còn lại
đợt tăng chỉ ×2,3, xác suất ngẫu nhiên 2–4%, không đủ bằng chứng), báo giả ngoài CH03: 0.

## Dự báo Level 1 và backtest (Phase 3, bước 3.4)

Code: `analytics-service/app/analytics/forecast.py`. Lệnh xem: `python main.py forecast [--store CH03] [--horizon 30]`.

| Mô hình | Dự báo ngày t | Vai trò |
|---|---|---|
| Lặp lại tuần trước | = cùng thứ tuần trước | Mức chuẩn: mô hình khác phải thắng nó |
| Trung bình 4 tuần theo thứ | = trung bình 4 cùng thứ gần nhất | Level 1 (§17 "Moving Average") |
| Trung bình 28 ngày | = trung bình 28 ngày, mọi ngày như nhau | Phẳng |

**Backtest:** đứng ở 4 thời điểm quá khứ (cách nhau 7 ngày, mỗi lần còn ≥ 28 ngày phía trước), dự báo 7 ngày, so với thật.

```
WAPE              = Σ|thật − dự báo| / Σ thật                  (không chia cho 0 khi có ngày bán 0)
WAPE tổng 7 ngày  = Σ|tổng 7 ngày thật − tổng 7 ngày dự báo| / Σ thật
Lệch (bias)       = Σ(dự báo − thật) / Σ thật                   (dương: dự báo cao hơn thật)
```

Mô hình có sai số thấp nhất được dùng; chưa đủ dữ liệu để thử (dưới 35 ngày) thì dùng trung bình theo thứ và ghi rõ
"chưa đo được độ chính xác".

**Tách bán buôn.** Đơn bán buôn (khoảng 22% doanh thu mẫu) là vài đơn lớn thất thường, không ai đoán được ngày nào có.
Dự báo = phần bán lẻ (mô hình chọn qua backtest) + bán buôn trung bình 28 ngày. Độ chính xác báo cáo là của phần bán lẻ;
mức thay đổi so với 7 ngày qua cũng so bán lẻ với bán lẻ (tuần qua không có đơn bán buôn thì so tổng ra "tăng gấp đôi" giả).

**Doanh thu** chọn theo WAPE từng ngày (dùng vẽ biểu đồ). **Nhu cầu thuốc** chọn theo WAPE tổng 7 ngày: số bán từng ngày
của một thuốc dao động rất mạnh (vài lần bán, mỗi lần 10–60 viên), nhưng quyết định nhập hàng cần tổng 7 ngày.

Đo trên dữ liệu mẫu (đến hết 29/10):

| Chuỗi | Sai số | Ghi chú |
|---|---|---|
| Doanh thu toàn chuỗi (gồm bán buôn trong chuỗi) | 16% | |
| Doanh thu bán lẻ toàn chuỗi | **9,8%** | Trung bình 4 tuần theo thứ thắng |
| Doanh thu bán lẻ CH03 | 26%, **lệch +16%** | Cửa hàng đang sụt: mô hình trung bình luôn đoán cao. Việc của Holt-Winters (3.5) |
| Nhu cầu thuốc, tổng 7 ngày, bán lẻ | trung vị 30%, 3/4 số thuốc dưới 46% | Gần giới hạn tự nhiên: ~15 lần bán/tuần thì riêng phần ngẫu nhiên đã ~20–25% |

## Holt-Winters, khoảng tin cậy, ngày hết hàng (Phase 3, bước 3.5)

Code: `analytics-service/app/analytics/forecast.py` (tự viết bằng numpy, quyết định D11).

```
mức_t      = α·(y_t − mùa_{t−7}) + (1−α)·(mức_{t−1} + φ·xu_hướng_{t−1})
xu_hướng_t = β·(mức_t − mức_{t−1}) + (1−β)·φ·xu_hướng_{t−1}
mùa_t      = γ·(y_t − mức_t) + (1−γ)·mùa_{t−7}
dự_báo_{t+h} = mức_t + (φ + φ² + … + φ^h)·xu_hướng_t + mùa_{t+h−7}
```

- α, β, γ chọn trong lưới 3 × 3 × 3 theo sai số dự báo một bước trên dữ liệu học; cả 27 tổ hợp chạy cùng lúc bằng mảng numpy.
- φ = 0,9: **xu hướng tắt dần**. Cửa hàng đang sụt thì dự báo 30 ngày không lao xuống 0 như đường thẳng kéo dài.
- Holt-Winters là ứng viên thứ tư trong backtest: thắng mới được dùng.

| Chuỗi | Level 1 tốt nhất | Holt-Winters |
|---|---|---|
| Doanh thu bán lẻ toàn chuỗi | 9,8% | **9,1%** |
| CH03 (sụt từ 10/10), lần thử bắt đầu 16/10 | lệch +29% | **+5%** |
| CH03, lần thử bắt đầu 23/10 | lệch +38% | **+12%** |
| CH03, lần thử bắt đầu 09/10 (sụt ngay hôm sau) | +53% | +50%: không mô hình nào đoán được cú sụt chưa có dấu hiệu |

Nhu cầu thuốc: Holt-Winters được chọn cho 42/180 chuỗi; sai số tổng 7 ngày trung vị vẫn ~30% (phần còn lại là dao động ngẫu nhiên).

**Khoảng tin cậy ~80%:** phân vị 10% và 90% của sai số backtest (sai số = dự báo − thật, nên thật = dự báo − sai số). Không giả
định phân phối chuẩn. Chưa backtest được thì không đưa khoảng. Tổng 7 ngày của nhu cầu thuốc: ± sai số tổng 7 ngày.

**Ngày dự kiến hết hàng:** cộng dồn nhu cầu dự báo từng ngày (30 ngày), ngày đầu tiên tổng vượt tồn bán được. Khác "tồn / ADS"
ở bước 2.3: tính được cuối tuần và xu hướng. Dữ liệu mẫu: CH02 Paracetamol hết sau 2 ngày, CH01 Amlodipin sau 4 ngày.

**FEFO dùng tốc độ bán dự báo** (trung bình 30 ngày tới) thay cho trung bình 30 ngày qua (`rate_source: forecast`). Lô chỉ
"có nguy cơ" khi phần không kịp bán ≥ 5% lô (1 viên trong lô 50 viên là sai số làm tròn).

**Bộ nhớ đệm `forecast_cache`:** dự báo chỉ dùng ngày đã trọn, nên khóa = dấu vân tay (ngày cuối đã trọn + tổng theo ngày ×
cửa hàng × thuốc × loại bán + tham số mô hình). Thêm hóa đơn hôm nay không đổi khóa: dùng lại, pipeline 3,6 giây thay vì 6,1 giây.
Sang ngày mới hoặc sửa số ngày cũ thì tính lại. Ngày hết hàng tính lại mỗi lần chạy vì tệp tồn kho có thể đổi.

## Phân loại ABC–XYZ (Phase 5, bước 5.1)

Mã: `analytics-service/app/analytics/classify.py`; ngưỡng trong `app/config.py`. Lệnh: `python main.py abc [--store CH01]`.

| Chỉ số | Cách tính |
|---|---|
| Doanh thu ABC | Tổng doanh thu (bán lẻ + bán buôn) `ABC_DAYS` = 90 ngày đã trọn gần nhất |
| Nhóm ABC | Xếp thuốc theo doanh thu giảm dần; tỷ trọng cộng dồn **trước** thuốc đó < 80% → A, < 95% → B, còn lại C. Thuốc làm vượt ngưỡng vẫn ở nhóm trên. Thuốc còn tồn mà không bán → C |
| Nhu cầu tuần | Số lượng **bán lẻ** mỗi tuần, 12 tuần trọn gần nhất (tuần kết thúc hôm qua). Bán buôn không tính: một đơn sỉ không nói gì về nhu cầu ở quầy |
| CV | Độ lệch chuẩn (mẫu) / trung bình nhu cầu tuần. Tuần trước lần bán đầu tiên không tính (không phải "bán 0"); dưới 4 tuần thì chưa xếp |
| Nhóm XYZ | CV ≤ 0,5 → X ổn định; ≤ 1,0 → Y dao động; > 1,0 → Z thất thường |
| Mức phục vụ | Theo ô: AX 98%, AY 97%, AZ 95%, BX 95%, BY 95%, BZ 93%, CX 93%, CY 92%, CZ 90%; chưa xếp XYZ dùng cột Y. Dùng cho tồn an toàn ở bước 5.2 |

Snapshot có `classification` cho toàn chuỗi và từng cửa hàng: tóm tắt A/B/C (số thuốc, doanh thu, tỷ trọng), ma trận 9 ô, danh sách thuốc (doanh thu, cộng dồn, CV, ô, mức phục vụ).

Đo trên dữ liệu mẫu (61 thuốc, 3 cửa hàng): toàn chuỗi A 29 thuốc (81,3% doanh thu), B 16 (13,8%), C 16 (4,9%); gần như mọi thuốc là X (CV 0,1–0,4), vài thuốc Y ở từng cửa hàng. Dữ liệu mẫu tự sinh nên doanh thu dàn đều và nhu cầu đều hơn thực tế: với dữ liệu thật thường thấy A khoảng 20% số thuốc và nhiều thuốc bán lẻ tẻ ở Y, Z. Test dùng dữ liệu dựng tay để phủ đủ X, Y, Z. Tính 4 phạm vi mất khoảng 0,1 giây.

## Gợi ý đặt hàng theo dự báo (Phase 5, bước 5.2)

Mã: `analytics-service/app/analytics/reorder.py`; tham số trong `app/config.py`. Lệnh: `python main.py reorder [--store CH01]`.
Chỉ gợi ý, không tạo chứng từ. Trang "Đề xuất đặt hàng" của phần mềm (§10.5) giữ nguyên (quyết định D18).

| Đại lượng | Cách tính |
|---|---|
| Kỳ cần đủ P | `lead_time_days` (danh mục, trống = 2) + `REORDER_COVER_DAYS` = 7 |
| Nhu cầu P ngày | Cộng dự báo từng ngày (bước 3.5, gồm bán buôn trung bình). Thuốc chưa có dự báo: tốc độ bán 30 ngày qua |
| Tồn an toàn | z(mức phục vụ ô ABC–XYZ, bước 5.1) × 1,25 × sai số tổng 7 ngày (backtest; chưa đo được thì 50%) × nhu cầu 7 ngày × √(P/7); **không vượt nhu cầu P ngày** |
| Mức cần có | max(nhu cầu P + tồn an toàn, tồn tối thiểu); không quá tồn tối đa; hàng nhóm C không quá 30 ngày bán dự báo |
| Tồn dùng được | Tồn bán được − phần các lô sẽ hết hạn trước khi bán kịp (FEFO theo dự báo, chỉ lô ≤ 90 ngày) |
| Số đặt | Mức cần có − tồn dùng được, làm tròn lên theo `pack_size` |
| Giá, nhà cung cấp | Lô nhập gần nhất của thuốc ở cửa hàng đó; hết sạch thì lô gần nhất ở cả chuỗi; không có thì giá vốn gần nhất trong tệp bán. Nhà cung cấp ghi ở danh mục được ưu tiên |
| Lý do (gấp → thường) | Hết hàng · Hết trước khi hàng kịp về (ngày dự kiến hết ≤ thời gian chờ) · Dưới tồn tối thiểu · Cần bổ sung cho kỳ tới |

Tại sao chặn tồn an toàn ≤ nhu cầu P: thuốc vừa hết hàng có số bán tụt về 0 vì không có hàng để bán (nhu cầu bị "che"), backtest đo sai số rất cao (Amlodipin CH02: 56%) và công thức đẩy tồn an toàn lên 1.671 viên, hơn cả nhu cầu 1.271.

Đo trên dữ liệu mẫu (30/10 22:00): 10 dòng, 15,2 triệu đ, 5 nhà cung cấp; 4 hết hàng, 1 hết trước khi hàng về, 1 dưới tối thiểu, 4 bổ sung. Cách tính của trang Đề xuất đặt hàng (tốc độ bán 30 ngày × 9 ngày, không tồn an toàn) ra 6 dòng: bỏ sót Bisoprolol, Cefixim, Metronidazol, Que test COVID (dự kiến hết sau 14–22 ngày, tồn còn hơn 9 ngày bán nhưng thấp hơn mức cần khi tính tồn an toàn). Tính gợi ý mất ~0,3 giây; cả pipeline ~5 giây.

Giới hạn: tệp tồn kho chỉ là ảnh chụp hiện tại nên chưa mô phỏng lại được "nếu đặt theo gợi ý thì có hết hàng không" trên quá khứ; nguồn PostgreSQL (bước 5.5) có lịch sử nhập để đo.

