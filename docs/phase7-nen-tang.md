# Phase 7: hoàn thiện nền tảng (thiết kế đã chốt)

Mục tiêu: bù các chức năng nền còn thiếu sau lần đánh giá phần mềm sau Phase 6, gồm kiểm tra dữ liệu đầu vào, chủ nhà thuốc kiêm dược sĩ, sao lưu, xác thực hai lớp, đơn đặt hàng gửi nhà cung cấp, và khởi động bằng một lệnh.

## Quyết định

| Mã | Quyết định |
|---|---|
| D28 | **Kiểm tra dữ liệu đầu vào** chạy ở **máy chủ** (zod + kiểm tra trùng trong service). Form giao diện chỉ kiểm tra lại để báo lỗi sớm, không thay thế máy chủ. Lỗi trùng trả 409 với mã lỗi riêng và thông báo chỉ rõ bản ghi đang dùng giá trị đó. Tiền luôn là số nguyên đồng. |
| D29 | **Chủ nhà thuốc kiêm dược sĩ**: giữ tách vai trò theo GPP, Quản lý không tự có quyền bán. Chủ có chứng chỉ hành nghề thì gán thêm vai trò Dược sĩ cho chính mình tại cửa hàng đó. Vì `PUT /users/{id}/roles` cấm tự đổi vai trò (chống tự gỡ hay tự nâng quyền) mà nhà thuốc một chủ không có ai làm hộ, mở lối hẹp `POST /users/me/pharmacist-role`: chỉ **thêm** vai trò Dược sĩ, người làm phải quản lý nhân sự tại cửa hàng đó (vốn đã tạo được tài khoản dược sĩ khác cho mình, nên không lọt quyền mới), vẫn bắt căn cứ bằng cấp và số chứng chỉ hành nghề, ghi nhật ký `USER_SELF_PHARMACIST`. Mục Quầy bán vẫn hiện với người quản lý nhân sự; mở ra là trang giải thích kèm nút "Thêm vai trò Dược sĩ cho tôi". Ghi trong [Hướng dẫn sử dụng](huong-dan-su-dung.md). |
| D30 | **Sao lưu trong phần mềm**, không cần cài `pg_dump`. Một bản sao lưu là một tệp nén gồm toàn bộ bảng dữ liệu và thư mục `storage/`. Tự động mỗi ngày lúc 23:00 giờ Việt Nam, giữ 14 bản gần nhất. Thư mục đặt bằng biến `BACKUP_DIR`; trên Windows đề xuất `D:\sao-luu-nha-thuoc`. Trang Quản trị → Sao lưu cho xem danh sách, sao lưu ngay, tải về. **Phục hồi chỉ bằng lệnh** `npm run db:restore -- <tệp>` có bước xác nhận, không có nút trên giao diện vì phục hồi ghi đè toàn bộ dữ liệu. |
| D31 | **Xác thực hai lớp (MFA)** bằng mã TOTP 6 số (RFC 6238) từ ứng dụng Google Authenticator / Microsoft Authenticator. **Tùy chọn cho mọi người**; chủ nhà thuốc bật được cài đặt "bắt buộc với Quản lý". 10 mã dự phòng dùng một lần. Quản lý chuỗi đặt lại được MFA cho nhân viên, có ghi nhật ký. Không thêm thư viện: tự cài thuật toán bằng `node:crypto`, mã QR dùng component của antd. |
| D32 | **Đơn đặt hàng** là chứng từ mới: Nháp → Đã gửi → Nhận một phần / Đã nhận đủ, hoặc Đã hủy. Tạo từ "Đề xuất đặt hàng" (tách theo nhà cung cấp) hoặc tạo tay. Gửi bằng cách in / lưu PDF / tải Excel (gửi qua Zalo), và gửi email nếu cấu hình máy chủ thư SMTP. Nhà cung cấp có thêm ô email. Hàng về thì tạo phiếu nhập từ đơn, tự điền hàng và số lượng còn thiếu. |
| D33 | **Khởi động bằng một lệnh**: `docker compose up -d` chạy đủ CSDL, máy chủ, analytics-service và giao diện (nginx phục vụ bản build và chuyển tiếp `/api`). Migration chạy tự động khi máy chủ khởi động. Cách chạy từng phần bằng `npm run dev` vẫn giữ cho phát triển. Kèm hướng dẫn cài đặt cho máy Windows. |

## Lộ trình

| Bước | Nội dung | Trạng thái |
|---|---|---|
| 7.1 | Rà kiểm tra dữ liệu đầu vào ở mọi API tạo/sửa: trùng, số âm/bằng 0, tiền nguyên đồng, ngày, chuỗi, số điện thoại; test cho từng lỗi; bộ test đầu cuối chạy lại được (D28) | Xong |
| 7.2 | Chủ nhà thuốc kiêm dược sĩ: trang Quầy bán giải thích, tự thêm vai trò Dược sĩ, Hướng dẫn sử dụng (D29) | Xong |
| 7.3 | Sao lưu trong phần mềm, lịch tự động, trang Sao lưu, lệnh phục hồi (D30) | Chưa làm |
| 7.4 | Xác thực hai lớp TOTP, mã dự phòng, đặt lại, cài đặt bắt buộc (D31) | Chưa làm |
| 7.5 | Đơn đặt hàng gửi nhà cung cấp, email SMTP, tạo phiếu nhập từ đơn (D32) | Chưa làm |
| 7.6 | Docker Compose chạy cả 3 thành phần, hướng dẫn cài đặt (D33) | Chưa làm |

## Kết quả rà soát 7.1

Cách rà: gửi 66 bộ dữ liệu biên vào các API tạo/sửa trên máy chủ đang chạy, ghi ca nào máy chủ nhận dữ liệu sai hoặc trả lỗi 500. Luật sau khi sửa ghi ở [contract §2.7a](api-contract.md).

| Chỗ | Lỗi tìm được | Sửa |
|---|---|---|
| Seed (`db:seed`, `db:demo`, `db:catalog`) | Tự đặt mã phiếu nhập, đơn thuốc mà không qua bộ đếm mã chứng từ. Ngày chạy seed, lập phiếu nhập mới báo "Dữ liệu đã tồn tại" | Lấy mã từ bộ đếm chung `nextDocumentCode` |
| Nhà cung cấp | Nhận trùng mã số thuế, trùng tên; mã số thuế 2 số; số điện thoại là chữ | Kiểm tra trùng (409), định dạng mã số thuế và số điện thoại |
| Khách hàng | Nhận số điện thoại "abc", "123"; "090 123 4567" và "+84901234567" không bị nhận ra là trùng với "0901234567" | Chuẩn hóa số điện thoại trước khi lưu và so trùng |
| Cửa hàng, nhân viên, người mua thuốc kiểm soát, người báo khiếu nại | Số điện thoại không kiểm tra | Cùng luật số điện thoại |
| Sản phẩm | "th0001" thành sản phẩm khác "TH0001"; tồn tối thiểu quá lớn gây lỗi 500 | Mã lưu chữ hoa, giới hạn số |
| Đơn vị tính | Hệ số quy đổi quá lớn gây lỗi 500; trùng tên/mã vạch chỉ báo câu chung; mã vạch nhận ký tự lạ | Giới hạn, báo rõ đơn vị/sản phẩm đang giữ mã vạch |
| Giá bán | Nhận thuế suất 7 %; nhận ngày hiệu lực ở quá khứ (làm sai lịch sử giá) | Chỉ 0/5/8/10 %, không lùi ngày |
| Nhóm sản phẩm, hoạt chất | Trùng tên ở nhóm gốc; "paracetamol" khác "Paracetamol" | Kiểm tra trùng không phân biệt hoa thường |
| Phiếu nhập | Số lượng quá lớn gây lỗi 500; nhận ngày hóa đơn, ngày nhận ở tương lai; NSX năm 1800, HSD năm 2200; hai dòng cùng lô | Giới hạn số lượng, chặn ngày tương lai và năm gõ nhầm, một lô một dòng |
| Hóa đơn bán | Giảm giá theo số tiền nhận số lẻ đồng; số lượng không có trần | Tiền giảm nguyên đồng, trần số lượng |
| Sổ nhiệt độ, đơn thuốc, thu hồi, khiếu nại, trả tiền NCC | Nhận ngày ở tương lai | Chặn |
| Kế hoạch xử lý cận hạn | Nhận hạn xử lý ở quá khứ | Chặn |
| Nhập Excel | Số điện thoại, mã số thuế kiểm tra lỏng; số không có trần; VAT bất kỳ | Cùng luật như nhập tay |
| Mọi form | Câu lỗi mặc định tiếng Anh ("Too big: expected int…") | Câu lỗi tiếng Việt |

Test: `server/src/lib/validators.test.ts`, `server/src/modules/input-validation.test.ts`, `client/src/ui/validators.test.ts`.

**Bộ test đầu cuối** ở `e2e/`: đăng nhập các tài khoản demo, mở 37 trang trên máy tính và điện thoại, báo lỗi JavaScript, lỗi API, trang tràn ngang. Cần phần mềm đang chạy và dữ liệu `db:demo`:

```bash
cd e2e
npm install
npm run setup     # tải trình duyệt Chromium, chỉ lần đầu
npm test
```
