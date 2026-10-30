# Schema dữ liệu và luật kiểm tra

Nguồn sự thật trong code: `analytics-service/app/processor/schemas.py` (cột) và
`validator.py` (luật). Tài liệu này mô tả lại cho người dùng và cho báo cáo.

## Quy ước chung

- Dòng 1 là tiêu đề. Tiêu đề dùng tên chuẩn (tiếng Anh) hoặc tên tiếng Việt quen dùng
  (`Mã thuốc`, `Số lượng`…), không phân biệt hoa thường, có dấu hay không.
- Nhận `.xlsx` (sheet đầu tiên) và `.csv` (dấu phẩy hoặc chấm phẩy, UTF-8).
- Số: `1200`, `1.234.567` (kiểu Việt Nam), `1,234,567.5`, `12,5`; bỏ qua chữ `đ`, `VNĐ`.
- Cách đọc dấu chấm được quyết định cho **cả cột**: cột có ô như `1289.31`, `1.5` (dấu chấm
  không đứng trước đúng 3 chữ số) hoặc `1,234,567` thì dấu chấm là thập phân, nên `599.765` là
  599,765. Cột chỉ có dạng `1.500`, `1.234.567`, `12,5` thì theo kiểu Việt Nam: `1.500` là 1500.
  Ô số thật của Excel không bị ảnh hưởng.
- Ngày: ô ngày của Excel, `dd/mm/yyyy`, `dd/mm/yyyy HH:MM`, `yyyy-mm-dd HH:MM`.
- Mã (thuốc, cửa hàng, lô) được viết hoa và bỏ khoảng trắng thừa.

## medicines.xlsx: danh mục thuốc

| Cột | Bắt buộc | Kiểu | Tên tiếng Việt chấp nhận |
|---|---|---|---|
| medicine_code | ✔ | mã, duy nhất | Mã thuốc, Mã sản phẩm |
| medicine_name | ✔ | chữ | Tên thuốc, Tên sản phẩm |
| category | ✔ | chữ | Nhóm thuốc, Nhóm hàng, Danh mục |
| unit | ✔ | chữ | Đơn vị, Đơn vị tính, ĐVT |
| manufacturer | | chữ | Nhà sản xuất |
| is_prescription | | Y/N, Có/Không | Kê đơn |
| min_stock | | số ≥ 0 | Tồn tối thiểu |
| max_stock | | số ≥ 0 | Tồn tối đa |
| pack_size | | số nguyên ≥ 1 | Quy cách, Đóng gói: số đơn vị bán nhỏ nhất mỗi đơn vị đặt (hộp 10 vỉ × 10 viên = 100). Trống: 1 |
| lead_time_days | | số nguyên 0–60 | Thời gian chờ, Ngày chờ hàng. Trống: 2 ngày |
| supplier | | chữ | Nhà cung cấp, NCC thường đặt. Trống: lấy theo lô nhập gần nhất trong tệp tồn |

## sales.xlsx: chi tiết bán hàng (mỗi dòng một mặt hàng trong một hóa đơn)

| Cột | Bắt buộc | Kiểu | Ghi chú |
|---|---|---|---|
| sale_id | ✔ | mã | Mã hóa đơn |
| line_no | ✔ | số ≥ 1 | Thứ tự dòng trong hóa đơn; (`sale_id`, `line_no`) không được trùng |
| sale_datetime | ✔ | ngày giờ | Không ở tương lai, không trước năm 2000 |
| sale_type | ✔ | `retail` / `wholesale` | Nhận cả "Bán lẻ", "Bán buôn", "Bán sỉ" |
| store_code | ✔ | mã | Mã cửa hàng |
| medicine_code | ✔ | mã | Phải có trong medicines |
| batch_code | | mã | Số lô, dùng cho FEFO |
| quantity | ✔ | số > 0 | Đơn vị bán nhỏ nhất; trả hàng không ghi số âm ở đây |
| selling_price | ✔ | số ≥ 0 | Đơn giá sau giảm |
| purchase_price | | số ≥ 0 | Giá vốn một đơn vị; thiếu thì bước sau tra theo lô |
| customer_id | | mã | Không bao giờ gửi cho LLM |
| payment_method | | cash/transfer/card/debt | Nhận "Tiền mặt", "Chuyển khoản", "Thẻ", "Công nợ" |

## Luật kiểm tra

**Lỗi (error)**: dòng bị loại khỏi phân tích. **Cảnh báo (warning)**: dòng vẫn dùng, cần xem lại.

| Mã lỗi | Mức | Áp dụng | Khi nào |
|---|---|---|---|
| missing_required | error | mọi tệp | Cột bắt buộc để trống |
| invalid_value | error / warning | mọi tệp | Có giá trị nhưng không đọc được (ngày 31/02, chữ trong ô số). Cột bắt buộc: error |
| invalid_code | error | mọi tệp | Mã thuốc/cửa hàng có ký tự lạ hoặc dài quá 20 |
| duplicate_row | error | mọi tệp | Trùng khóa với một dòng phía trên (giữ dòng đầu) |
| unknown_column | warning | mọi tệp | Cột không có trong schema (bỏ qua) |
| negative_value | error | medicines | Tồn tối thiểu/tối đa âm |
| min_above_max | warning | medicines | Tồn tối thiểu lớn hơn tối đa |
| invalid_pack_size | warning | medicines | Quy cách nhỏ hơn 1: gợi ý đặt hàng dùng 1 |
| lead_time_out_of_range | warning | medicines | Thời gian chờ ngoài 0–60 ngày: dùng mặc định 2 |
| non_positive_quantity | error | sales | Số lượng ≤ 0 |
| fractional_quantity | warning | sales | Số lượng có phần lẻ |
| negative_price | error | sales | Giá bán hoặc giá vốn âm |
| zero_price | warning | sales | Giá bán bằng 0 |
| below_cost | warning | sales | Giá bán thấp hơn giá vốn |
| future_date | error | sales | Ngày bán sau giờ hiện tại (cho lệch 1 giờ) |
| date_too_old | error | sales | Ngày bán trước năm 2000 |
| invalid_batch | warning | sales | Số lô có ký tự lạ hoặc dài quá 30 |
| unknown_medicine | error | sales | Mã thuốc không có trong medicines |

Thiếu hẳn một cột bắt buộc, hoặc tệp hỏng, thì cả tệp không xử lý (`LoadError`).

## inventory.xlsx (Phase 2, quyết định D7)

Tồn hiện tại theo lô. Khóa: (`store_code`, `medicine_code`, `batch_code`). "Tồn tính đến" = giờ lưu tệp.

| Cột | Bắt buộc | Kiểu | Ý nghĩa |
|---|---|---|---|
| store_code | ✔ | mã | Cửa hàng, trùng mã trong phần mềm |
| medicine_code | ✔ | mã | Phải có trong medicines |
| batch_code | ✔ | mã | Số lô |
| quantity | ✔ | số ≥ 0 | Số lượng còn |
| expiry_date | ✔ | ngày | Hạn dùng |
| purchase_price | | số ≥ 0 | Giá nhập, để tính giá trị tồn |
| received_date | | ngày | Ngày nhập |
| supplier | | chữ | Nhà cung cấp |

Tiêu đề tiếng Việt được nhận: Mã CH, Mã thuốc, Số lô, SL tồn, Hạn dùng (HSD), Giá nhập, Ngày nhập, Nhà cung cấp (NCC).
Cột kiểu ngày bỏ phần giờ: hạn dùng tính theo ngày. Lô **đã hết hạn vẫn hợp lệ**: đó là thứ cần cảnh báo.

Ngoài luật chung (missing_required, invalid_value, invalid_code):

| Luật | Mức | Ý nghĩa |
|---|---|---|
| duplicate_row | error | Trùng (cửa hàng, thuốc, lô) |
| negative_value | error | Số lượng hoặc giá nhập âm |
| expiry_before_received | error | Hạn dùng trước ngày nhập |
| future_date | error | Ngày nhập ở tương lai |
| date_too_old | error | Hạn dùng trước năm 2000 |
| unknown_medicine | error | Mã thuốc không có trong medicines |
| zero_quantity | warning | Số lượng 0: bỏ qua dòng (không tính là dòng lỗi) |
| fractional_quantity | warning | Số lượng có phần lẻ |
| expiry_too_far | warning | Hạn dùng quá 10 năm (gõ nhầm năm) |
| invalid_batch | warning | Số lô có ký tự lạ hoặc dài quá 30 |
| unknown_store | warning | Mã cửa hàng không có trong tệp bán hàng |

Không có tệp tồn kho thì phần bán hàng vẫn chạy. Thứ tự xử lý: medicines → sales → inventory.

Phiếu nhập (`purchases.xlsx`) để Phase 5 (gợi ý đặt hàng).
