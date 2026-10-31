# Phase 7: hoàn thiện nền tảng (thiết kế đã chốt)

Mục tiêu: bù các chức năng nền còn thiếu sau lần đánh giá phần mềm sau Phase 6, gồm kiểm tra dữ liệu đầu vào, chủ nhà thuốc kiêm dược sĩ, sao lưu, xác thực hai lớp, đơn đặt hàng gửi nhà cung cấp, và khởi động bằng một lệnh.

## Quyết định

| Mã | Quyết định |
|---|---|
| D28 | **Kiểm tra dữ liệu đầu vào** chạy ở **máy chủ** (zod + kiểm tra trùng trong service). Form giao diện chỉ kiểm tra lại để báo lỗi sớm, không thay thế máy chủ. Lỗi trùng trả 409 với mã lỗi riêng và thông báo chỉ rõ bản ghi đang dùng giá trị đó. Tiền luôn là số nguyên đồng. |
| D29 | **Chủ nhà thuốc kiêm dược sĩ**: giữ tách vai trò theo GPP, Quản lý không tự có quyền bán. Chủ có chứng chỉ hành nghề thì gán thêm vai trò Dược sĩ cho chính mình tại cửa hàng đó. Vì `PUT /users/{id}/roles` cấm tự đổi vai trò (chống tự gỡ hay tự nâng quyền) mà nhà thuốc một chủ không có ai làm hộ, mở lối hẹp `POST /users/me/pharmacist-role`: chỉ **thêm** vai trò Dược sĩ, người làm phải quản lý nhân sự tại cửa hàng đó (vốn đã tạo được tài khoản dược sĩ khác cho mình, nên không lọt quyền mới), vẫn bắt căn cứ bằng cấp và số chứng chỉ hành nghề, ghi nhật ký `USER_SELF_PHARMACIST`. Mục Quầy bán vẫn hiện với người quản lý nhân sự; mở ra là trang giải thích kèm nút "Thêm vai trò Dược sĩ cho tôi". Ghi trong [Hướng dẫn sử dụng](huong-dan-su-dung.md). |
| D30 | **Sao lưu trong phần mềm**, không cần cài `pg_dump`. Một bản sao lưu là một tệp nén gồm toàn bộ bảng dữ liệu và thư mục `storage/`. Tự động mỗi ngày lúc 23:00 giờ Việt Nam, giữ 14 bản gần nhất. Thư mục đặt bằng biến `BACKUP_DIR`; trên Windows đề xuất `D:\sao-luu-nha-thuoc`. Trang Sao lưu dữ liệu (công cụ của Quản trị → Cài đặt, vì nhóm Quản trị đã đủ 6 mục; chỉ quản lý toàn chuỗi vì bản sao lưu chứa dữ liệu cả chuỗi) cho xem danh sách, sao lưu ngay, tải về; mỗi lần tạo và tải ghi nhật ký. **Phục hồi chỉ bằng lệnh** `npm run db:restore -- <tệp>` có bước xác nhận, không có nút trên giao diện vì phục hồi ghi đè toàn bộ dữ liệu. |
| D31 | **Xác thực hai lớp (MFA)** bằng mã TOTP 6 số (RFC 6238) từ ứng dụng Google Authenticator / Microsoft Authenticator. **Tùy chọn cho mọi người**; chủ nhà thuốc bật được cài đặt "bắt buộc với Quản lý". 10 mã dự phòng dùng một lần. Quản lý chuỗi đặt lại được MFA cho nhân viên, có ghi nhật ký. Không thêm thư viện: tự cài thuật toán bằng `node:crypto`, mã QR dùng component của antd. |
| D32 | **Đơn đặt hàng** là chứng từ mới: Nháp → Đã gửi → Nhận một phần / Đã nhận đủ, hoặc Đã hủy. Tạo từ "Đề xuất đặt hàng" (tách theo nhà cung cấp) hoặc tạo tay. Gửi bằng cách in / lưu PDF / tải Excel (gửi qua Zalo), và gửi email nếu cấu hình máy chủ thư SMTP. Nhà cung cấp có thêm ô email. Hàng về thì tạo phiếu nhập từ đơn, tự điền hàng và số lượng còn thiếu. |
| D33 | **Khởi động bằng một lệnh**: `docker compose up -d` chạy đủ CSDL, máy chủ, analytics-service và giao diện (nginx phục vụ bản build và chuyển tiếp `/api`). Migration chạy tự động khi máy chủ khởi động. Cách chạy từng phần bằng `npm run dev` vẫn giữ cho phát triển. Kèm hướng dẫn cài đặt cho máy Windows. |

## Lộ trình

| Bước | Nội dung | Trạng thái |
|---|---|---|
| 7.1 | Rà kiểm tra dữ liệu đầu vào ở mọi API tạo/sửa: trùng, số âm/bằng 0, tiền nguyên đồng, ngày, chuỗi, số điện thoại; test cho từng lỗi; bộ test đầu cuối chạy lại được (D28) | Xong |
| 7.2 | Chủ nhà thuốc kiêm dược sĩ: trang Quầy bán giải thích, tự thêm vai trò Dược sĩ, Hướng dẫn sử dụng (D29) | Xong |
| 7.3 | Sao lưu trong phần mềm, lịch tự động, trang Sao lưu, lệnh phục hồi (D30) | Xong |
| 7.4 | Xác thực hai lớp TOTP, mã dự phòng, đặt lại, cài đặt bắt buộc (D31) | Xong |
| 7.5 | Đơn đặt hàng gửi nhà cung cấp, email SMTP, tạo phiếu nhập từ đơn (D32) | Xong |
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

## Sao lưu (7.3)

Bản trước (gỡ ngày 01/10/2026, migration `20261001090000_remove_backups`) bị bỏ; bản này làm lại theo D30, không dùng bảng riêng: danh sách đọc thẳng từ thư mục sao lưu.

- **Định dạng**: một tệp gzip, mỗi dòng một bản ghi. Mỗi hàng là chuỗi `to_jsonb(row)` do PostgreSQL sinh; phục hồi đưa thẳng lại cho PostgreSQL qua `jsonb_populate_recordset`, không qua JSON của JavaScript, nên số lớn, ngày giờ, số thập phân giữ nguyên. Dòng cuối ghi tổng số dòng và tệp để phát hiện tệp cắt cụt.
- **Nhất quán**: đọc mọi bảng trong một giao dịch `REPEATABLE READ`, nên sao lưu lúc đang bán hàng vẫn ra một ảnh chụp đúng. Ghi ra `.part` rồi mới đổi tên.
- **Phục hồi**: một giao dịch; tạm gỡ khóa ngoại, xóa dữ liệu, nạp lại, đặt lại sequence, tạo lại khóa ngoại (PostgreSQL kiểm tra lại toàn bộ), thu hồi mọi phiên đăng nhập. Không cần quyền superuser. Thư mục ảnh thay sau khi CSDL xong; thư mục cũ giữ lại bên cạnh (`storage.truoc-phuc-hoi-*`).
- **Đo trên dữ liệu chạy thử** (71 bảng, 19.904 dòng, 390 ảnh): sao lưu 4,5 giây, tệp 1,2 MB; phục hồi 7 giây. Đã thử sửa, xóa dữ liệu sau khi sao lưu rồi phục hồi: dữ liệu, số thứ tự mã khách, 173 khóa ngoại trở về đúng.

Test: `server/src/modules/backup/backup.test.ts` (sao lưu – phục hồi khứ hồi, tệp cắt cụt không làm mất dữ liệu, sai phiên bản bị từ chối, quyền, dò đường dẫn, nhật ký).

## Xác thực hai lớp (7.4)

- **TOTP tự cài** (`server/src/lib/totp.ts`, không thêm thư viện), khớp bảng kiểm thử của RFC 4226 và RFC 6238. Mã QR dựng bằng component `QRCode` của antd ở trình duyệt; khóa không gửi đi đâu khác.
- **Lưu trữ**: migration `20261102090000_mfa` thêm `users.mfa_secret_enc`, `mfa_pending_secret_enc`, `mfa_enabled_at`, `mfa_last_step` (chặn dùng lại mã) và bảng `mfa_recovery_codes` (HMAC, dùng một lần). Khóa mã hóa như mật khẩu liên thông (AES-256-GCM, dẫn xuất từ `JWT_SECRET`).
- **Đăng nhập hai bước**: đúng mật khẩu nhận vé 5 phút (ký bằng khóa riêng), vé + mã mới có phiên. Sai mã cộng vào bộ đếm sai mật khẩu; bước mật khẩu không xóa bộ đếm khi tài khoản có MFA, nên không thử mã vô hạn được.
- **Bắt buộc với Quản lý**: cài đặt toàn chuỗi `mfaRequiredForManagers` (Cài đặt → Bảo mật). Quản lý chưa bật thì máy chủ trả `403 MFA_SETUP_REQUIRED` cho mọi API trừ hồ sơ, đổi mật khẩu, đăng xuất, màn bật MFA; giao diện hiện màn bật MFA thay cho cả phần mềm (giống cổng đổi mật khẩu tạm). Đang bắt buộc thì Quản lý không tắt được.
- **Đặt lại**: quản lý nhân sự đặt lại MFA cho người mình quản lý ở trang Nhân viên; không tự đặt lại cho mình.
- **Rủi ro đã biết**: khóa MFA và mã dự phòng đều dẫn xuất từ `JWT_SECRET`. Đổi `JWT_SECRET` thì cả mã 6 số lẫn mã dự phòng không dùng được nữa; quản lý phải đặt lại MFA cho từng người (người đặt lại cũng cần đăng nhập được, nên đổi `JWT_SECRET` khi chính sách bắt buộc đang tắt). Ghi trong contract §3.

Test: `server/src/lib/totp.test.ts` (bảng kiểm thử RFC), `server/src/modules/auth/mfa.test.ts` (bật, đăng nhập hai bước, chặn dùng lại mã, mã dự phòng, giới hạn thử, tắt, đặt lại, bắt buộc với Quản lý, quyền), `client/src/features/auth/mfa-api.test.ts`. Đã chạy thử trên trình duyệt: bật bằng mã tính từ khóa, đăng nhập hai bước, mã sai, mã dự phòng, bật bắt buộc rồi bị đưa vào màn bật MFA, đặt lại cho nhân viên.

## Đơn đặt hàng (7.5)

- **Lưu trữ**: migration `20261103090000_purchase_orders` (bảng `purchase_orders`, `purchase_order_lines`, cột `suppliers.email`, `goods_receipts.purchase_order_id`) và `20261103100000_receipt_line_passed` (cột `goods_receipt_lines.passed`: dòng không đạt vẫn vào lô biệt trữ nên không suy ra được từ lô).
- **Số đã nhận không lưu riêng**: tính từ dòng đạt của phiếu nhập đã xác nhận gắn với đơn, nên không lệch với tồn kho. Xác nhận phiếu thì tính lại trạng thái đơn trong cùng giao dịch.
- **Quyền**: dùng lại quyền phiếu nhập, không thêm quyền mới. Lập, sửa nháp: `goods_receipt.create` (dược sĩ, nhân viên kho, quản lý). Gửi và hủy là cam kết mua: `goods_receipt.confirm` (quản lý).
- **Email**: thư viện `nodemailer` 10.3.1, ghim đúng phiên bản. Các bản 10.1.3 trở về trước có lỗ hổng đã công bố (GHSA-p6gq-j5cr-w38f, GHSA-8m3c-c648-2xjj); mọi bản đã vá đều mới phát hành dưới hai tuần, chọn bản mới nhất vì bản vá quan trọng hơn độ "chín" của phiên bản. Phần mềm còn tắt đọc tệp và tải URL trong thư (`disableFileAccess`, `disableUrlAccess`). Chưa đặt `SMTP_HOST` thì chỉ in / tải Excel.
- **Mẫu in**: thêm loại "Đơn đặt hàng" vào Cài đặt → Mẫu in phiếu (khổ A4/A5, tiêu đề, lời cuối, chữ ký).

Test: `server/src/modules/inventory/purchase-orders.test.ts` (lập, sửa, quyền gửi, email qua transport giả, chưa cấu hình SMTP, in, Excel, nhận một phần / nhận đủ, dòng không đạt không tính, chặn lập phiếu từ đơn nháp hoặc sai nhà cung cấp, không thấy đơn cửa hàng khác), `client/src/features/purchase-orders/purchase-orders-api.test.ts`. Chạy thử trên trình duyệt: lập đơn tay, gửi (tự gửi), tải Excel, xem trước bản in, lập phiếu nhập từ đơn.

