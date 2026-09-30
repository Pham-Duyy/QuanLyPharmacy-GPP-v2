# Kịch bản demo — mô hình bốn vai trò

Trình bày một ca làm việc theo đúng phân quyền mới: **Quản lý phân công → Dược sĩ bán → Quản lý xem báo cáo**. Quản lý không bán hàng; mọi thao tác bán do dược sĩ làm.

Đã diễn thử trọn kịch bản ngày 30/09/2026 trên bản sao của CSDL demo (không chạm CSDL thật). Kết quả ở mục [Diễn thử](#diễn-thử-ngày-30092026).

## Nhân vật

| Tài khoản | Họ tên hiển thị | Vai trò | Phạm vi |
|---|---|---|---|
| `demochu` | Chủ nhà thuốc (demo) | Quản lý (`admin`) | NT01 |
| `demo` | Dược sĩ trình bày | Dược sĩ (`pharmacist`) | NT01 |

Quản lý **không** có quyền bán (`invoice.create`, `sale.prescription_drug`): không thấy Quầy bán trên sidebar, mở thẳng `/ban-hang` cũng bị chặn. Không cấp lại quyền bán cho Quản lý để giống kịch bản cũ.

Dược sĩ có sẵn quyền tạo đơn thuốc và bán thuốc kê đơn, nhưng **không** tự có quyền xác nhận đơn. Quyền đó là quyền bổ sung, Quản lý cấp tại từng cửa hàng.

## Điều kiện trước buổi demo

Làm và kiểm tra lại trước giờ trình bày:

1. **Liên thông CSDL Dược phải đang tắt.** Cấu hình liên thông trên CSDL demo còn bật từ đợt thử với máy chủ mô phỏng (tài khoản giả `0101234567-001`). Máy chủ mô phỏng đã gỡ, nên hóa đơn bán trong buổi demo sẽ được bộ chạy nền (5 phút một lượt) đưa vào hàng đợi và gửi tới **sandbox thật** của csdlduoc bằng tài khoản giả. Xem hồ sơ rà soát dữ liệu liên thông giả; chỉ demo khi đã xử lý xong, hoặc ít nhất đã tắt liên thông ở màn Liên thông CSDL Dược.
2. **Mật khẩu `demo`.** Ngày 30/09/2026 lúc 23:24, tài khoản `admin` đã đặt lại mật khẩu `demo`, nên tài khoản này đang dùng mật khẩu tạm và bắt buộc đổi ở lần đăng nhập tới. Đăng nhập `demo` một lần trước buổi demo, đổi sang mật khẩu sẽ dùng khi trình bày.
3. **`demo` chưa có quyền bổ sung.** Ở màn Nhân viên, chi tiết của Dược sĩ trình bày không có dòng "quyền bổ sung". Nếu còn từ lần demo trước, gỡ đi để bước 1 bắt đầu từ trạng thái gốc.
4. Khách **Chị Lan (demo)** (KH00004, 0901234567) còn, không ghi dị ứng. Amoxicillin 500mg còn hàng tại NT01.
5. Chạy đủ bộ: `docker compose up -d`, `npm run dev` trong `server/` và `client/`. Mở hai cửa sổ trình duyệt riêng (hoặc một cửa sổ ẩn danh) để đăng nhập hai tài khoản cùng lúc.

Kịch bản tạo đơn thuốc mới ngay trong buổi demo, không dùng đơn `DT-NT01-20260926-0902` có sẵn: đơn đó kê ngày 26/09 và có thể đã quá hạn dùng đơn vào hôm trình bày.

## Bước 1 — Quản lý phân công

Cửa sổ 1, đăng nhập `demochu`. Màn đầu tiên là **Tổng quan**.

1. Chỉ ra sidebar của Quản lý: Tổng quan, Giao dịch bán, Hàng hóa, Mua hàng, Khách hàng, Hồ sơ GPP, Báo cáo, Quản trị — **không có Quầy bán**.
2. **Quản trị → Nhân viên** → bấm dòng **Dược sĩ trình bày** → **Đổi vai trò**.
3. Giữ nguyên dòng vai trò *Dược sĩ — NT01 — Nhà thuốc GPP số 1*. Điền:
   - **Căn cứ đã kiểm tra bằng cấp chuyên môn:** `DỮ LIỆU DEMO — hồ sơ mô phỏng, không phải văn bằng thật`
   - **Quyền bổ sung tại cửa hàng:** chỉ chọn **Xác nhận hoặc từ chối đơn thuốc**.
   - **Không** tích "Phân công chịu trách nhiệm chuyên môn tại cửa hàng này".
4. Chỉ ra cảnh báo vàng: lưu sẽ đăng xuất mọi phiên của người được đổi vai trò. → **Lưu vai trò**.
5. Chi tiết tài khoản hiện: *1 quyền bổ sung tại cửa hàng* và *Căn cứ chuyên môn: DỮ LIỆU DEMO — …*

Điểm cần nói: quyền bổ sung chỉ có hiệu lực tại NT01, nằm trong danh sách cố định, phải ghi căn cứ; căn cứ ở đây là hồ sơ mô phỏng và được ghi rõ như vậy.

## Bước 2 — Dược sĩ lập đơn, xác nhận, bán

Cửa sổ 2, đăng nhập `demo` (phiên cũ đã bị đăng xuất ở bước 1). Màn đầu tiên là **Quầy bán**.

**Lập và xác nhận đơn thuốc** — Giao dịch bán → **Đơn thuốc** → **Tạo đơn thuốc**:

| Ô | Giá trị |
|---|---|
| Tên bác sĩ kê đơn | `BS. Mô Phỏng (dữ liệu demo)` |
| Cơ sở khám chữa bệnh | `Phòng khám mô phỏng (dữ liệu demo)` |
| Ngày kê đơn | hôm nay |
| Chẩn đoán | `Viêm họng cấp (dữ liệu demo)` |

1. Xóa dòng trống mặc định. Ở ô tìm sản phẩm, gõ `Amoxicillin` → chọn **Amoxicillin 500mg**: dòng hiện "Đã khớp sản phẩm trong danh mục".
2. SL `10`, Liều dùng `Ngày 2 lần, mỗi lần 1 viên, sau ăn` → **Tạo đơn nháp**.
3. Bấm đơn vừa tạo → nút **Xác nhận đơn** hiện ra (có được nhờ quyền bổ sung ở bước 1) → bấm → "Đã xác nhận đơn thuốc".

**Bán theo đơn** — **Quầy bán**:

1. Khách hàng: gõ `Chị Lan` → chọn **Chị Lan (demo)**. Khung *Điểm của khách* hiện 40 điểm.
2. Đơn thuốc: chọn đơn vừa xác nhận.
3. Tìm `Amoxicillin` → **Thêm**, số lượng `10`. Dòng thuốc hiện *10 Viên còn lại theo đơn*, không còn cảnh báo "Cần chọn đơn thuốc".
4. Kiểm tra an toàn: *Không phát hiện vấn đề chặn bán*, kèm ghi chú hệ thống chưa có nguồn dữ liệu tương tác cho Amoxicillin — nói rõ đây là giới hạn dữ liệu, không phải "an toàn".
5. Tiền mặt → **Thanh toán** (F9) → *Thanh toán thành công*, 25.000 đ.

Điểm cần nói: thuốc kê đơn chỉ bán được khi gắn đơn đã xác nhận; số lượng bị giới hạn theo đơn.

## Bước 3 — Quản lý xem báo cáo

Quay lại cửa sổ 1 (`demochu`).

1. **Giao dịch bán → Hóa đơn**: hóa đơn vừa bán đứng đầu, khách *Chị Lan (demo)*, người bán *Dược sĩ trình bày*; thẻ *Doanh thu hôm nay* tính cả hóa đơn này. Quản lý xem, in lại, hủy được hóa đơn nhưng không lập được hóa đơn mới.
2. **Báo cáo** → tab **Nhân viên** → *Doanh thu theo người bán*: dòng *Dược sĩ trình bày — 1 hóa đơn — 25.000 ₫*. Nếu CSDL đã có hóa đơn cũ trong kỳ, các dòng khác (ví dụ *Quản trị hệ thống*) là dữ liệu trước khi đổi mô hình vai trò.

## Sau buổi demo

- Gỡ quyền bổ sung và căn cứ mô phỏng khỏi `demo` (Nhân viên → Đổi vai trò → bỏ quyền, xóa ô căn cứ → Lưu), để hồ sơ nhân sự không còn dữ liệu mô phỏng và lần demo sau bắt đầu lại từ trạng thái gốc.
- **Không xóa** đơn thuốc và hóa đơn đã tạo trong buổi demo: đó là chứng từ nghiệp vụ. Muốn loại khỏi số liệu thì hủy hóa đơn bằng chức năng hủy (cần quyền `invoice.void`), không xóa trong CSDL.

## Nếu có sự cố

| Hiện tượng | Nguyên nhân thường gặp | Xử lý |
|---|---|---|
| `demo` không thấy nút **Xác nhận đơn** | Chưa đăng nhập lại sau khi đổi vai trò, hoặc quyền bổ sung chưa lưu | Đăng xuất, đăng nhập lại; kiểm tra chi tiết tài khoản ở bước 1 |
| Quầy bán báo "Cần chọn đơn thuốc" | Chưa chọn đơn, hoặc đơn chưa xác nhận | Chọn đơn ở ô *Đơn thuốc* trên Quầy bán |
| Không chọn được đơn ở Quầy bán | Đơn còn nháp, hoặc đã bán hết số lượng theo đơn | Xác nhận đơn; lập đơn mới nếu đã bán hết |
| `demo` đăng nhập bị đòi đổi mật khẩu | Mật khẩu tạm chưa đổi (điều kiện 2) | Đổi mật khẩu rồi tiếp tục |

## Diễn thử ngày 30/09/2026

Chạy tự động bằng trình duyệt trên **bản sao** CSDL demo (`pharmacy_gpp_dientap`, máy chủ cổng 3100, giao diện cổng 5199). Bản sao đã tắt liên thông và sao lưu tự động. Mật khẩu `demo` trong bản sao được đặt lại để đăng nhập được. Bản sao đã xóa sau khi diễn thử. CSDL thật không thay đổi.

| Kiểm tra | Kết quả |
|---|---|
| Trước: `demo` chưa có `prescription.verify` tại NT01 | Đạt |
| Quản lý không thấy Quầy bán, mở `/ban-hang` bị chặn | Đạt |
| Quản lý không có `invoice.create`, `sale.prescription_drug` | Đạt |
| Lưu vai trò: chi tiết hiện 1 quyền bổ sung và căn cứ "DỮ LIỆU DEMO" | Đạt |
| Sau khi lưu: `demo` có thêm đúng `prescription.verify`, không mất quyền nào | Đạt |
| `demo` đăng nhập lại, vào thẳng Quầy bán | Đạt |
| Tạo đơn nháp, xác nhận đơn (`DT-NT01-20260930-0001`) | Đạt |
| Quầy bán gắn đơn, không còn cảnh báo thiếu đơn, thanh toán (`HD-NT01-20260930-0001`, 25.000 đ) | Đạt |
| Hóa đơn hiện ở màn Hóa đơn của Quản lý, người bán là Dược sĩ trình bày | Đạt |
| Báo cáo → Nhân viên có dòng Dược sĩ trình bày 1 hóa đơn 25.000 ₫, không có Quản lý là người bán | Đạt |
| Không có lỗi 500, không có lỗi JavaScript | Đạt |
