# Schema dữ liệu và luật kiểm tra

Nguồn sự thật trong code: `analytics-service/app/processor/schemas.py` (cột) và
`validator.py` (luật). Tài liệu này mô tả lại cho người dùng và cho báo cáo.

## Quy ước chung

- Dòng 1 là tiêu đề. Tiêu đề dùng tên chuẩn (tiếng Anh) hoặc tên tiếng Việt quen dùng
  (`Mã thuốc`, `Số lượng`…), không phân biệt hoa thường, có dấu hay không.
- Nhận `.xlsx` (sheet đầu tiên) và `.csv` (dấu phẩy hoặc chấm phẩy, UTF-8).
- Số: `1200`, `1.234.567` (kiểu Việt Nam), `1,234,567.5`, `12,5`; bỏ qua chữ `đ`, `VNĐ`.
  Dấu chấm theo sau đúng 3 chữ số được hiểu là phân cách nghìn: `1.500` là 1500.
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

## inventory.xlsx, purchases.xlsx (Phase 2)

Sẽ bổ sung ở Phase 2: tồn theo lô (`store_code`, `medicine_code`, `batch_code`, `quantity`,
`purchase_price`, `selling_price`, `expiry_date`, `received_date`, `supplier_id`) và phiếu nhập.
