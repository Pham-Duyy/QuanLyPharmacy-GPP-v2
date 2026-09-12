# RESTful API Specification for GPP Pharmacy Management System

> Tài liệu này được chuẩn bị để đưa cho Claude Code review trước khi triển khai.
>
> **Phạm vi review:** kiểm tra tính nhất quán của API, mô hình nghiệp vụ, transaction tồn kho, bảo mật, phân quyền, khả năng mở rộng và mức độ phù hợp với PostgreSQL/MongoDB.
>
> **Không triển khai code trong bước review này.** Hãy trả về các phát hiện theo mức độ: Critical, High, Medium, Low; nêu rõ endpoint hoặc quy tắc liên quan và đề xuất chỉnh sửa.

## 1. Bối cảnh hệ thống

- Frontend: React kết hợp Vite.
- Backend: Node.js với Express.
- Cơ sở dữ liệu: đang cân nhắc giữa PostgreSQL và MongoDB; quyết định cuối cùng sẽ được đưa ra sau khi hoàn thành thiết kế dữ liệu.
- API trao đổi dữ liệu bằng JSON.
- Hệ thống phục vụ quản lý nhà thuốc theo quy trình GPP.
- Các nghiệp vụ quan trọng gồm quản lý thuốc, lô và hạn dùng, nhập kho, bán hàng, tồn kho, đơn thuốc, khách hàng, báo cáo và AI hỗ trợ dược sĩ.

## 2. Yêu cầu review dành cho Claude Code

Hãy review tài liệu theo các tiêu chí sau:

1. Phát hiện mâu thuẫn giữa các endpoint và trạng thái nghiệp vụ.
2. Kiểm tra các thao tác nhập, bán, trả hàng và điều chỉnh kho có cần transaction hay không.
3. Kiểm tra nguy cơ race condition, bán vượt tồn và xử lý đồng thời.
4. Xác định dữ liệu nào Backend phải tự tính lại thay vì tin từ Frontend.
5. Kiểm tra FEFO và khả năng truy vết lô thực tế đã xuất.
6. Kiểm tra authentication, authorization, refresh token và audit log.
7. Kiểm tra dữ liệu nhạy cảm của khách hàng, đơn thuốc và dị ứng.
8. Kiểm tra các API AI có tạo ra quyết định y khoa không an toàn hay không.
9. Đánh giá khả năng ánh xạ dữ liệu sang PostgreSQL và MongoDB.
10. Đề xuất phạm vi MVP và những endpoint nên để ở giai đoạn sau.
11. Không tự viết code. Không tự thay đổi tài liệu. Chỉ trả về báo cáo review và danh sách quyết định cần xác nhận.

## 3. Quy ước chung

| Mục | Quy ước |
|---|---|
| Base URL | `/api/v1` |
| Authentication | Bearer Token, JWT trong header `Authorization` |
| Phân trang | `?page=1&limit=20` |
| Tìm kiếm | `?search=paracetamol` |
| Sắp xếp | `?sortBy=created_at&order=desc` |
| Response thành công | `{ "success": true, "data": {}, "message": "..." }` |
| Response lỗi | `{ "success": false, "error": { "code": "...", "message": "...", "details": [] } }` |
| Content type | `application/json`; upload file dùng `multipart/form-data` |

### HTTP status dự kiến

| Status | Ý nghĩa |
|---|---|
| 200 | Thành công |
| 201 | Tạo mới thành công |
| 400 | Dữ liệu hoặc nghiệp vụ không hợp lệ |
| 401 | Chưa đăng nhập hoặc token hết hạn |
| 403 | Không có quyền |
| 404 | Không tìm thấy tài nguyên |
| 409 | Xung đột dữ liệu hoặc trạng thái |
| 422 | Dữ liệu đúng cú pháp nhưng không vượt qua validation nghiệp vụ, nếu đội thống nhất dùng mã này |
| 429 | Vượt giới hạn request |
| 500 | Lỗi server không mong muốn |

### Quy tắc chung cần xác nhận

- `page` và `limit` là số nguyên dương; `limit` có giới hạn tối đa.
- `sortBy` chỉ nhận trường nằm trong whitelist.
- Danh sách rỗng trả về `200` với `items: []`.
- Response lỗi có mã nghiệp vụ ổn định, ví dụ `INSUFFICIENT_STOCK`, `BATCH_EXPIRED`, `PRESCRIPTION_REQUIRED`, `ORDER_ALREADY_CONFIRMED`.
- Các request tạo phiếu nhập và hóa đơn cần hỗ trợ `Idempotency-Key` để chống tạo trùng khi retry.
- Mọi response nên có `requestId` để tra log.
- Ngày giờ lưu và trao đổi theo ISO 8601; cần thống nhất timezone.

## 4. Authentication

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| POST | `/auth/login` | Đăng nhập, trả access token và refresh token | Public |
| POST | `/auth/refresh-token` | Làm mới access token | Public |
| POST | `/auth/logout` | Thu hồi refresh token | Authenticated |
| GET | `/auth/me` | Lấy người dùng hiện tại | Authenticated |
| PUT | `/auth/change-password` | Đổi mật khẩu | Authenticated |

### Yêu cầu bảo mật cần xác nhận

- Access token có thời hạn ngắn; refresh token phải được lưu an toàn và có thể thu hồi.
- Không lưu password dạng plaintext; dùng cơ chế băm mật khẩu phù hợp.
- Cân nhắc refresh-token rotation.
- Có khóa tài khoản hoặc rate limit sau nhiều lần đăng nhập sai.
- Cân nhắc MFA cho Admin và dược sĩ phụ trách.
- Backend, không phải Frontend, là nơi quyết định quyền truy cập.

## 5. Users và phân quyền

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/users` | Danh sách nhân viên, phân trang và tìm kiếm | Admin |
| GET | `/users/:id` | Chi tiết nhân viên | Admin |
| POST | `/users` | Tạo tài khoản nhân viên | Admin |
| PUT | `/users/:id` | Cập nhật nhân viên | Admin |
| DELETE | `/users/:id` | Vô hiệu hóa tài khoản, soft delete | Admin |

Vai trò ban đầu:

- `admin`
- `pharmacist`
- `sales_staff`
- `warehouse_staff`
- `auditor`, nếu cần

Ngoài role, cần xác định các permission nghiệp vụ như xem tồn kho, điều chỉnh tồn kho, duyệt phiếu nhập, hủy hóa đơn, xem dữ liệu khách hàng, xem doanh thu và sử dụng AI.

## 6. Categories

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/categories` | Danh sách nhóm thuốc | Authenticated |
| GET | `/categories/:id` | Chi tiết nhóm thuốc | Authenticated |
| POST | `/categories` | Tạo nhóm thuốc | Admin, Pharmacist |
| PUT | `/categories/:id` | Cập nhật nhóm thuốc | Admin, Pharmacist |
| DELETE | `/categories/:id` | Ẩn hoặc xóa khi không còn sản phẩm phụ thuộc | Admin |

## 7. Products và thuốc

> Product là thông tin sản phẩm tổng quát. Batch là lô tồn kho cụ thể có số lô và hạn dùng riêng.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/products` | Danh sách, phân trang, lọc category và tìm kiếm theo tên, hoạt chất, SKU | Authenticated |
| GET | `/products/:id` | Chi tiết sản phẩm, các lô và tồn kho tổng hợp | Authenticated |
| POST | `/products` | Tạo sản phẩm | Admin, Pharmacist |
| PUT | `/products/:id` | Cập nhật sản phẩm | Admin, Pharmacist |
| DELETE | `/products/:id` | Ẩn sản phẩm, không xóa vật lý nếu đã có giao dịch | Admin |
| GET | `/products/by-barcode/:sku` | Tra cứu nhanh bằng mã vạch | Authenticated |
| GET | `/products/:id/batches` | Các lô của sản phẩm | Authenticated |
| GET | `/products/expiring-soon?days=30` | Sản phẩm hoặc lô sắp hết hạn | Authenticated |
| GET | `/products/low-stock?threshold=10` | Sản phẩm dưới ngưỡng tồn | Authenticated |

Cần bổ sung hoặc xác định rõ: đơn vị cơ bản, đơn vị quy đổi, hoạt chất, hàm lượng, dạng bào chế, số đăng ký, nhà sản xuất, điều kiện bảo quản, thuốc kê đơn, VAT, giá bán theo thời điểm và trạng thái thu hồi.

## 8. Batches

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/batches` | Danh sách lô, lọc theo sản phẩm, sắp hết hạn hoặc đã hết hạn | Authenticated |
| GET | `/batches/:id` | Chi tiết lô và tồn kho | Authenticated |
| POST | `/batches` | Tạo lô khi có nghiệp vụ hợp lệ | Admin, Pharmacist |
| PUT | `/batches/:id` | Cập nhật metadata lô theo quyền | Admin, Pharmacist |

Số lô và sản phẩm nên có ràng buộc duy nhất phù hợp. Không được sửa tùy tiện các trường ảnh hưởng đến lịch sử giao dịch sau khi lô đã phát sinh nhập hoặc xuất.

## 9. Inventory

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/inventory` | Tồn kho, lọc theo sản phẩm, lô, hết hạn | Authenticated |
| GET | `/inventory/summary` | Tổng hợp tồn theo sản phẩm | Authenticated |
| GET | `/inventory/stock-report` | Báo cáo nhập - xuất - tồn | Admin, Pharmacist |
| POST | `/inventory-adjustments` | Tạo phiếu điều chỉnh sau kiểm kê | Admin, Pharmacist |
| GET | `/inventory-adjustments/:id` | Xem chi tiết điều chỉnh | Admin, Pharmacist |
| POST | `/inventory-adjustments/:id/approve` | Duyệt điều chỉnh nếu cần phân tách người lập và người duyệt | Admin, Pharmacist |

Không nên dùng `PUT /inventory/:id` để sửa trực tiếp số tồn. Mọi thay đổi phải tạo giao dịch có số lượng trước điều chỉnh, số lượng thực tế, chênh lệch, lý do, người thực hiện, người duyệt và thời gian.

## 10. Suppliers

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/suppliers` | Danh sách nhà cung cấp | Authenticated |
| GET | `/suppliers/:id` | Chi tiết và lịch sử nhập hàng | Authenticated |
| POST | `/suppliers` | Tạo nhà cung cấp | Admin, Pharmacist |
| PUT | `/suppliers/:id` | Cập nhật nhà cung cấp | Admin, Pharmacist |
| DELETE | `/suppliers/:id` | Vô hiệu hóa nhà cung cấp | Admin |

## 11. Purchase Orders và nhập kho

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/purchase-orders` | Danh sách, lọc theo nhà cung cấp, ngày và trạng thái | Admin, Pharmacist |
| GET | `/purchase-orders/:id` | Chi tiết phiếu nhập | Admin, Pharmacist |
| POST | `/purchase-orders` | Tạo phiếu ở trạng thái `DRAFT` hoặc `PENDING`, chưa cộng tồn | Admin, Pharmacist |
| PUT | `/purchase-orders/:id` | Sửa phiếu khi chưa duyệt | Admin, Pharmacist |
| PATCH | `/purchase-orders/:id/confirm` | Duyệt phiếu, tạo hoặc liên kết lô và cộng tồn trong một transaction | Admin |
| DELETE | `/purchase-orders/:id` | Hủy phiếu khi chưa duyệt | Admin |

### Quy tắc transaction nhập kho

1. Tạo phiếu không làm thay đổi tồn kho.
2. Chỉ khi confirm, Backend mới kiểm tra dữ liệu và thực hiện nghiệp vụ.
3. Transaction phải bao gồm cập nhật trạng thái phiếu, tạo hoặc liên kết batch, cộng tồn và ghi inventory transaction.
4. Nếu một bước lỗi, rollback toàn bộ.
5. Phiếu đã confirm không được sửa hoặc xóa trực tiếp.
6. Hủy phiếu đã duyệt, nếu cần, phải là nghiệp vụ hoàn tác riêng và có audit log.

## 12. Customers

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/customers` | Tìm kiếm theo tên hoặc số điện thoại | Authenticated |
| GET | `/customers/:id` | Chi tiết khách hàng | Authenticated |
| POST | `/customers` | Tạo khách hàng | Authenticated |
| PUT | `/customers/:id` | Cập nhật khách hàng | Authenticated |
| GET | `/customers/:id/invoices` | Lịch sử hóa đơn | Authenticated |
| GET | `/customers/:id/allergy-check` | Kiểm tra dữ liệu dị ứng đã lưu | Authorized |

Dữ liệu dị ứng, lịch sử mua hàng và đơn thuốc là dữ liệu nhạy cảm. Cần giới hạn quyền xem, ghi audit log khi truy cập và xác định chính sách lưu trữ.

## 13. Doctors và Prescriptions

### Doctors

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/doctors` | Danh sách bác sĩ | Authenticated |
| GET | `/doctors/:id` | Chi tiết bác sĩ | Authenticated |
| POST | `/doctors` | Tạo bác sĩ | Admin, Pharmacist |
| PUT | `/doctors/:id` | Cập nhật bác sĩ | Admin, Pharmacist |

### Prescriptions

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/prescriptions` | Danh sách, lọc theo khách hàng, bác sĩ và ngày | Authenticated |
| GET | `/prescriptions/:id` | Chi tiết đơn thuốc | Authorized |
| POST | `/prescriptions` | Tạo đơn thuốc hoặc tiếp nhận ảnh đơn | Authenticated |
| PUT | `/prescriptions/:id` | Cập nhật trước khi xác nhận | Authorized |
| POST | `/prescriptions/:id/scan` | Gửi ảnh cho OCR, không tự động xác nhận đơn | Authenticated |

Kết quả OCR phải có trạng thái `PENDING_REVIEW` cho đến khi dược sĩ xác nhận. Cần lưu phiên bản ảnh, kết quả trích xuất, độ tin cậy và người xác nhận.

## 14. Invoices và bán hàng

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/invoices` | Danh sách hóa đơn, lọc theo ngày, khách hàng và nhân viên | Authenticated |
| GET | `/invoices/:id` | Chi tiết hóa đơn và các lô thực tế đã xuất | Authenticated |
| POST | `/invoices` | Tạo hóa đơn, chọn FEFO, trừ kho trong transaction | Authenticated |
| POST | `/invoices/:id/return` | Trả hàng hoặc hoàn tác theo chính sách | Admin, Pharmacist |
| GET | `/invoices/:id/print` | Xuất hóa đơn PDF | Authenticated |

### Quy tắc tạo hóa đơn

Frontend chỉ nên gửi `productId`, `quantity` và thông tin nghiệp vụ cần thiết. Backend phải tự:

1. Kiểm tra sản phẩm còn hoạt động.
2. Kiểm tra thuốc kê đơn và đơn thuốc đã được xác nhận.
3. Kiểm tra khách hàng và tiền sử dị ứng nếu áp dụng.
4. Lấy giá bán hiện hành từ Backend.
5. Chọn lô chưa hết hạn theo FEFO nếu Frontend không chỉ định lô.
6. Khóa dữ liệu tồn kho phù hợp trong transaction.
7. Kiểm tra đủ tồn kho và không bán vượt số lượng.
8. Tính lại tiền, giảm giá và thuế.
9. Trừ kho và ghi các inventory transactions.
10. Lưu lô thực tế đã xuất trong từng invoice item.
11. Ghi audit log.

Nếu bất kỳ bước nào thất bại, toàn bộ transaction phải rollback. Không tin `unitPrice`, tổng tiền, tồn kho hoặc trạng thái do Frontend gửi lên.

### Trả hàng

API trả hàng cần quy định rõ trả toàn bộ hay từng dòng, số lượng trả, lý do, người duyệt, việc đưa hàng lại vào kho hay khu vực cách ly và cách xử lý thuốc đã không còn đảm bảo điều kiện bảo quản.

## 15. Dashboard và Reports

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/dashboard/summary` | Doanh thu hôm nay, số hóa đơn, hàng sắp hết hạn và tồn thấp | Admin, Pharmacist |
| GET | `/reports/revenue` | Doanh thu theo khoảng thời gian và ngày/tháng | Admin |
| GET | `/reports/top-selling` | Sản phẩm bán chạy | Admin |
| GET | `/reports/import-export` | Báo cáo nhập - xuất - tồn | Admin |
| GET | `/reports/expiry-warning` | Hàng hết hạn hoặc sắp hết hạn | Admin, Pharmacist |

Các báo cáo phải thống nhất timezone, khoảng ngày bao gồm hay loại trừ, trạng thái hóa đơn được tính và cách xử lý hóa đơn trả/hủy.

## 16. AI Integration

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| POST | `/ai/ocr-prescription` | OCR ảnh đơn thuốc, trả kết quả cần dược sĩ xác nhận | Authenticated |
| POST | `/ai/drug-interaction-check` | Kiểm tra tương tác bằng dữ liệu thuốc và luật đáng tin cậy, AI hỗ trợ giải thích | Authenticated |
| POST | `/ai/allergy-check` | Kiểm tra dị ứng từ hồ sơ khách hàng và danh sách thuốc | Authorized |
| GET | `/ai/inventory-forecast` | Dự báo nhu cầu nhập hàng | Admin |
| POST | `/ai/chatbot` | Chatbot tư vấn thông tin cơ bản cho khách hàng | Public, rate-limited |

### Nguyên tắc an toàn AI

- AI chỉ hỗ trợ, không tự quyết định bán thuốc, chẩn đoán, kê đơn hoặc thay thế thuốc.
- Cảnh báo tương tác và dị ứng cần dựa trên cơ sở dữ liệu thuốc hoặc luật xác định; LLM không phải nguồn sự thật duy nhất.
- OCR phải trả độ tin cậy và đánh dấu phần không đọc rõ.
- Dược sĩ phải xác nhận trước khi kết quả AI ảnh hưởng đến giao dịch.
- Không gửi dữ liệu cá nhân không cần thiết sang AI provider bên ngoài.
- Cần log model/version, nguồn dữ liệu, prompt hoặc input đã được kiểm soát, kết quả và người xác nhận.
- Chatbot public phải có rate limit, giới hạn request, từ chối chẩn đoán/kê đơn và hướng người dùng đến cơ sở y tế khi có dấu hiệu nguy hiểm.

## 17. Audit log

Audit log nên được áp dụng cho các thao tác:

- Đăng nhập, đăng xuất, đổi mật khẩu và thay đổi quyền.
- Tạo, sửa, vô hiệu hóa thuốc hoặc nhà cung cấp.
- Confirm, hủy hoặc hoàn tác phiếu nhập.
- Điều chỉnh tồn kho.
- Tạo, trả hoặc hủy hóa đơn.
- Xem hoặc thay đổi dữ liệu nhạy cảm.
- Xác nhận kết quả OCR hoặc cảnh báo AI.

Mỗi log tối thiểu cần có actor, action, resource, resource ID, timestamp, request ID, IP hoặc client metadata phù hợp, và before/after value khi cần. Không ghi password, token hoặc dữ liệu nhạy cảm không cần thiết vào log.

## 18. Đề xuất phạm vi MVP

### MVP nên bao gồm

1. Đăng nhập và phân quyền.
2. Danh mục thuốc.
3. Quản lý lô và hạn dùng.
4. Nhà cung cấp.
5. Phiếu nhập và confirm phiếu nhập.
6. Tồn kho và kiểm kê có audit.
7. Hóa đơn bán hàng theo FEFO.
8. Trả hàng hoặc hoàn tác hóa đơn theo chính sách.
9. Audit log.
10. Dashboard cơ bản.

### Nên để sau MVP

- OCR đơn thuốc.
- Chatbot public.
- Dự báo tồn kho bằng AI.
- Tư vấn thuốc tự động.
- Tích hợp thanh toán bên thứ ba.
- Báo cáo nâng cao.

## 19. Quyết định cần chốt trước khi triển khai

1. PostgreSQL hay MongoDB sau khi hoàn thành ERD.
2. Đơn vị thuốc và quy tắc quy đổi giữa viên, vỉ, hộp.
3. Trạng thái đầy đủ của purchase order, invoice, prescription và inventory adjustment.
4. Chính sách FEFO và xử lý ngoại lệ chỉ định batch.
5. Chính sách trả hàng và hàng cách ly.
6. Giá bán, VAT, chiết khấu và lịch sử giá.
7. Refresh token, MFA và mô hình permission.
8. Dữ liệu nào được phép gửi đến AI provider.
9. Nguồn dữ liệu thuốc dùng cho tương tác và dị ứng.
10. Quy trình dược sĩ xác nhận kết quả AI.
11. Chính sách lưu trữ và bảo vệ dữ liệu khách hàng.
12. Cách tính báo cáo đối với hóa đơn trả, hủy hoặc hoàn tiền.

## 20. Kết luận sơ bộ

API hiện bao phủ đầy đủ các nhóm nghiệp vụ chính, nhưng cần xem đây là bản nháp của API contract. Ba điểm phải được chốt trước khi triển khai là:

1. Tạo phiếu nhập không cộng tồn; chỉ confirm mới thực hiện transaction nhập kho.
2. Backend tự chọn lô theo FEFO, tự tính giá và tổng tiền khi bán.
3. Điều chỉnh tồn kho phải là giao dịch có lý do, phê duyệt và audit log; không sửa trực tiếp một số tồn.

Với đặc điểm quan hệ giữa thuốc, lô, tồn kho, phiếu nhập, hóa đơn và audit log, PostgreSQL là ứng viên mạnh cho dữ liệu nghiệp vụ. Quyết định cuối cùng vẫn cần dựa trên ERD, quy mô dữ liệu, năng lực vận hành và yêu cầu linh hoạt của đội dự án.
