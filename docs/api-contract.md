# API Contract – Phần mềm quản lý nhà thuốc GPP

| Mục | Giá trị |
|---|---|
| Phiên bản tài liệu | 2.1 |
| Phiên bản API | `/api/v1` |
| Ngày cập nhật | 12/09/2026 |
| Trạng thái | Toàn bộ quyết định đã chốt; sẵn sàng thiết kế ERD |
| Căn cứ | Bản gốc `docs/restful-api-review.md` và báo cáo review v1 (mã phát hiện C1–C3, H1–H9, M1–M12, L1–L12) |
| Thay thế | Nội dung contract trong `restful-api-review.md`. Bản gốc được giữ lại để tham chiếu. |

**Nhãn dùng trong tài liệu**

- **[Đã chốt]**: nhóm đã thống nhất ngay sau báo cáo review.
- **[Đã chốt – Pn]**: mục từng để “chờ xác nhận” ở bản 2.0, được nhóm xác nhận ngày 12/09/2026. Mã `Pn` giữ lại để tra ngược báo cáo review; nhật ký quyết định ở §23.
- Các con số cấu hình trong tài liệu (số ngày, ngưỡng, hạn mức) là **giá trị mặc định**, sửa được trong phần cài đặt hệ thống mà không phải sửa contract.

> Quy tắc triển khai: ba vấn đề Critical (C1, C2, C3) phải được xử lý trong contract và thiết kế dữ liệu **trước khi viết bất kỳ endpoint nhập kho hay bán hàng nào**.

---

## 0. Thay đổi so với bản gốc

| Thay đổi | Mã review | Nhãn |
|---|---|---|
| Chọn PostgreSQL cho dữ liệu nghiệp vụ | Mục 07 | Đã chốt |
| Mọi dòng số lượng có `unitId`; tồn lưu theo đơn vị nhỏ nhất; thêm tài nguyên đơn vị quy đổi | C2 | Đã chốt |
| Trạng thái lô `AVAILABLE`, `QUARANTINED`, `RECALLED`; thêm biệt trữ, mở khóa, thu hồi | C3 | Đã chốt |
| `Idempotency-Key` và chuyển trạng thái có điều kiện cho mọi action endpoint | C1 | Đã chốt |
| Thay `purchase-orders` bằng `goods-receipts`; đơn đặt hàng để sau MVP | M1 | Đã chốt |
| Vòng đời đơn thuốc và bước dược sĩ `verify` | H2 | Đã chốt |
| Tài nguyên `returns` riêng cho trả hàng | H3 | Đã chốt |
| Cột quyền ghi permission cụ thể thay cho “Authenticated”, “Authorized” | H1 | Đã chốt |
| Giá theo đơn vị, lịch sử giá, VAT, giảm giá | M5 | Đã chốt |
| Bỏ `POST /ai/chatbot` khỏi API v1 | H9 | Đã chốt |
| Thêm thẻ kho, API đọc audit log, sổ nhiệt độ – độ ẩm | M7 | Đã chốt |
| Múi giờ `Asia/Ho_Chi_Minh`, thời điểm lưu UTC, tiền VND số nguyên | M10 | Đã chốt |
| Dòng hóa đơn lưu dữ liệu tại thời điểm bán; bảng phân bổ lô | M3 | Đã chốt (hệ quả của C2, M5) |
| Bỏ `POST /batches`; thêm nghiệp vụ tồn đầu kỳ | H4 | Đã chốt – P3 |
| Điều chỉnh tồn áp dụng chênh lệch; người duyệt khác người lập | H5 | Đã chốt – P4 |
| Refresh token trong cookie `HttpOnly`, xoay vòng có phát hiện dùng lại | H6 | Đã chốt – P1 |
| Gộp kiểm tra tương tác, dị ứng thành `POST /sales/safety-check` tất định | H8 | Đã chốt – P7 |
| Tách permission dữ liệu nhạy cảm; chính sách OCR | H7 | Đã chốt – P8 |
| camelCase, ID dạng chuỗi, action dùng `POST`, cập nhật dùng `PATCH`, bảng mã lỗi | L1–L5, L7 | Đã chốt (quy ước) |

---

## 1. Bối cảnh và quyết định nền

- Frontend: React + Vite. Backend: Node.js + Express. **CSDL: PostgreSQL [Đã chốt]**.
- API trao đổi JSON; upload tệp dùng `multipart/form-data`.
- Phạm vi: một nhà thuốc bán lẻ theo GPP.
- Backend là nơi duy nhất quyết định quyền, giá, tồn, lô xuất và trạng thái. Không tin các giá trị này từ Frontend.

---

## 2. Quy ước chung

| Mục | Quy ước |
|---|---|
| Base URL | `/api/v1` |
| Xác thực | `Authorization: Bearer <accessToken>` (xem §3) |
| Đặt tên | JSON và query dùng camelCase (`productId`, `sortBy=createdAt`). CSDL dùng snake_case, ánh xạ ở tầng truy cập dữ liệu. |
| ID | Chuỗi. Client coi là giá trị mờ, không suy luận kiểu. Kiểu cụ thể quyết định khi thiết kế ERD. |
| Phân trang | `?page=1&limit=20`, `limit` tối đa 100. Thẻ kho và audit log dùng con trỏ: `?cursor=...&limit=50`. |
| Tìm kiếm | `?search=`; không phân biệt hoa thường và dấu tiếng Việt (“thuoc ho” khớp “thuốc ho”). |
| Sắp xếp | `?sortBy=createdAt&order=desc`; `sortBy` chỉ nhận trường trong whitelist của từng endpoint. |
| Hành động | `POST /{resource}/{id}/{action}`, ví dụ `/confirm`, `/approve`, `/void`. |
| Cập nhật | `PATCH` cho cập nhật một phần. Không dùng `DELETE` cho chứng từ nghiệp vụ; danh mục dùng `/deactivate`, `/activate`. |
| Request ID | Mọi response có `requestId` và header `X-Request-Id`. |

### 2.1 Thời gian, ngày và hạn dùng [Đã chốt]

- Thời điểm (timestamp) trao đổi theo ISO 8601 UTC, ví dụ `2026-09-11T08:30:00Z`; CSDL lưu kiểu `timestamptz`.
- Ngày nghiệp vụ (ngày bán, ngày báo cáo) tính theo múi giờ `Asia/Ho_Chi_Minh`, định dạng `YYYY-MM-DD`.
- Khoảng ngày trong truy vấn: `from` (bao gồm) đến `to` (loại trừ).
- Hạn dùng là kiểu ngày `YYYY-MM-DD`, không có giờ. Lô được coi là hết hạn khi `expiryDate` ≤ ngày hiện tại theo giờ Việt Nam.
- Nhãn chỉ in tháng/năm (`HSD 03/2027`) thì lưu ngày cuối tháng (`2027-03-31`). **[Đã chốt – P11]**

### 2.2 Tiền, số lượng và đơn vị [Đã chốt]

- Mọi **số tiền** (đơn giá bán, thành tiền, giảm giá, VAT, tổng tiền, tiền hoàn) là số nguyên VND.
- Giá vốn quy về đơn vị nhỏ nhất có thể lẻ (ví dụ 100.000 đ cho hộp 30 viên = 3.333,33 đ/viên). CSDL lưu `NUMERIC`; API trả dạng chuỗi thập phân và chỉ trả cho người có `stock.cost.read`.
- Mọi **số lượng** do client gửi đi kèm `unitId`. Backend quy đổi sang đơn vị nhỏ nhất (`baseQuantity`) trước khi chọn lô, trừ tồn hoặc so sánh.
- Mọi số lượng tồn trả về có `baseQuantity` và `baseUnit`.

### 2.3 Idempotency [Đã chốt]

- Header `Idempotency-Key` (UUID do client sinh cho mỗi lần thao tác, **không** sinh lại khi retry) **bắt buộc** với:
  - `POST /goods-receipts`, `POST /invoices`, `POST /invoices/{id}/returns`, `POST /recalls`, `POST /inventory/opening-balances`;
  - mọi action endpoint đổi trạng thái: `confirm`, `cancel`, `approve`, `reject`, `submit`, `verify`, `void`, `quarantine`, `release`, `close`.
- Máy chủ lưu khóa theo (khóa, người dùng, method + path, hash nội dung, response) trong 24 giờ.
  - Cùng khóa, cùng nội dung: trả lại đúng response đã lưu.
  - Cùng khóa, khác nội dung: `422 IDEMPOTENCY_KEY_REUSED`.
  - Request trước với cùng khóa đang xử lý: `409 REQUEST_IN_PROGRESS`.
  - Thiếu header: `400 IDEMPOTENCY_KEY_REQUIRED`.

### 2.4 Chuyển trạng thái có điều kiện [Đã chốt]

- Mọi action đổi trạng thái chạy trong **cùng một transaction** với các thao tác kho, tiền đi kèm.
- Việc chuyển trạng thái chỉ thành công khi trạng thái hiện tại đúng như bảng ở §5. Nếu không có bản ghi nào được cập nhật, trả `409 INVALID_STATE` kèm `currentStatus`.
- Dòng thẻ kho có ràng buộc duy nhất theo (loại chứng từ, dòng chứng từ, lô), để lần ghi lặp bị chặn ở tầng CSDL.

### 2.5 Khóa lạc quan khi sửa [Đã chốt – P2]

- Tài nguyên sửa được có trường `version`. `PATCH` phải gửi `version` hiện tại; lệch phiên bản trả `409 VERSION_CONFLICT`.
- Mỗi endpoint `PATCH` có danh sách trường được phép sửa; trường ngoài danh sách bị bỏ qua hoặc trả `422`.

### 2.6 Khung response

Thành công:

```json
{ "success": true, "data": { }, "requestId": "req_01J..." }
```

Danh sách:

```json
{
  "success": true,
  "data": {
    "items": [],
    "pagination": { "page": 1, "limit": 20, "total": 0 }
  },
  "requestId": "req_01J..."
}
```

Danh sách dùng con trỏ trả `"pagination": { "nextCursor": "..." }`.

Lỗi:

```json
{
  "success": false,
  "error": { "code": "INSUFFICIENT_STOCK", "message": "Không đủ tồn cho Paracetamol 500 mg", "details": [] },
  "requestId": "req_01J..."
}
```

### 2.7 Mã lỗi và HTTP status [Đã chốt]

| Status | Khi nào | Mã lỗi |
|---|---|---|
| 400 | Request sai cú pháp, thiếu header bắt buộc | `BAD_REQUEST`, `IDEMPOTENCY_KEY_REQUIRED` |
| 401 | Chưa đăng nhập, token hết hạn hoặc bị thu hồi | `UNAUTHENTICATED`, `TOKEN_EXPIRED` |
| 403 | Thiếu permission | `FORBIDDEN` |
| 404 | Không tìm thấy tài nguyên | `NOT_FOUND` |
| 409 | Xung đột trạng thái, phiên bản hoặc tồn kho | `INVALID_STATE`, `VERSION_CONFLICT`, `INSUFFICIENT_STOCK`, `REQUEST_IN_PROGRESS`, `BATCH_EXPIRY_MISMATCH` |
| 422 | Dữ liệu đúng cú pháp nhưng vi phạm validation hoặc quy tắc nghiệp vụ | `VALIDATION_ERROR`, `UNIT_NOT_IN_PRODUCT`, `PRICE_NOT_SET`, `BATCH_NOT_SELLABLE`, `PRESCRIPTION_REQUIRED`, `PRESCRIPTION_NOT_VERIFIED`, `PRESCRIPTION_EXPIRED`, `PRESCRIBED_QUANTITY_EXCEEDED`, `SAFETY_ACK_REQUIRED`, `DISCOUNT_LIMIT_EXCEEDED`, `RETURN_QUANTITY_EXCEEDED`, `RETURN_WINDOW_EXPIRED`, `RETURN_NOT_ALLOWED_FOR_RX`, `SELF_APPROVAL_NOT_ALLOWED`, `IDEMPOTENCY_KEY_REUSED` |
| 429 | Vượt giới hạn request | `RATE_LIMITED` |
| 500 | Lỗi không mong muốn | `INTERNAL_ERROR` |

---

## 3. Xác thực và phiên

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| POST | `/auth/login` | Đăng nhập; trả `accessToken` trong body và đặt refresh token | Public, có giới hạn |
| POST | `/auth/refresh` | Cấp access token mới, xoay vòng refresh token | Public (cần refresh token) |
| POST | `/auth/logout` | Thu hồi phiên hiện tại | Đã đăng nhập |
| GET | `/auth/me` | Người dùng hiện tại, vai trò và danh sách permission | Đã đăng nhập |
| POST | `/auth/change-password` | Đổi mật khẩu; bắt buộc gửi mật khẩu hiện tại | Đã đăng nhập |

Quy tắc:

- Mật khẩu băm bằng argon2id hoặc bcrypt; không bao giờ trả về hay ghi log.
- Access token sống 15 phút, Frontend chỉ giữ trong bộ nhớ. **[Đã chốt – P1]**
- Refresh token đặt trong cookie `HttpOnly`, `Secure`, `SameSite=Strict`, path `/api/v1/auth`; hết hạn sau 7 ngày không hoạt động; CSDL chỉ lưu bản băm theo từng phiên. **[Đã chốt – P1]**
- Mỗi lần refresh cấp refresh token mới. Nếu một refresh token đã dùng rồi bị gửi lại, thu hồi toàn bộ chuỗi phiên đó.
- Vô hiệu hóa tài khoản, đổi mật khẩu, đặt lại mật khẩu, đổi vai trò: thu hồi mọi refresh token của người đó.
- Đăng nhập sai nhiều lần: tăng dần thời gian chờ theo IP và tài khoản, không khóa cứng tài khoản.
- MFA: sau MVP.

---

## 4. Phân quyền

**[Đã chốt]** Cột “Quyền” của mọi endpoint ghi **permission**, không ghi vai trò. Backend kiểm tra permission. Một tài khoản có thể giữ nhiều vai trò.

### 4.1 Danh mục permission

| Permission | Ý nghĩa |
|---|---|
| `user.manage` | Quản lý tài khoản, vai trò |
| `catalog.read` | Xem danh mục sản phẩm, nhóm, đơn vị, hoạt chất, nhà cung cấp |
| `catalog.manage` | Tạo, sửa, ngừng dùng danh mục |
| `price.manage` | Tạo phiên bản giá mới |
| `stock.read` | Xem tồn kho, lô, thẻ kho |
| `stock.cost.read` | Xem giá vốn |
| `goods_receipt.read` | Xem phiếu nhập |
| `goods_receipt.create` | Tạo, sửa phiếu nhập nháp |
| `goods_receipt.confirm` | Xác nhận phiếu nhập (kiểm nhập), hủy phiếu nháp |
| `stock.adjust.create` | Lập phiếu điều chỉnh tồn |
| `stock.adjust.approve` | Duyệt, từ chối phiếu điều chỉnh |
| `stock.opening_balance` | Nhập tồn đầu kỳ |
| `batch.quarantine` | Biệt trữ, mở khóa lô |
| `recall.manage` | Tạo, đóng thông báo thu hồi; xem danh sách khách đã mua lô bị thu hồi |
| `invoice.read` | Xem hóa đơn, phiếu trả |
| `invoice.create` | Bán hàng, chạy kiểm tra an toàn |
| `invoice.void` | Hủy hóa đơn |
| `sale.prescription_drug` | Bán thuốc kê đơn và thuốc kiểm soát đặc biệt |
| `sale.batch_override` | Chỉ định lô khác thứ tự FEFO |
| `sale.discount` | Giảm giá trong hạn mức của vai trò |
| `sale.discount.override` | Giảm giá vượt hạn mức |
| `safety.ack` | Ghi nhận cảnh báo an toàn mức cao để tiếp tục bán |
| `return.create` | Nhận trả hàng |
| `prescription.read` | Xem đơn thuốc |
| `prescription.create` | Tạo, sửa đơn thuốc nháp, tải ảnh đơn |
| `prescription.verify` | Xác nhận hoặc từ chối đơn thuốc |
| `customer.read` | Xem thông tin cơ bản của khách |
| `customer.manage` | Tạo, sửa thông tin cơ bản của khách |
| `customer.sensitive` | Đọc, ghi hồ sơ sức khỏe (dị ứng, bệnh nền) và lịch sử mua của khách **[Đã chốt – P8]** |
| `storage_log.read` | Xem sổ nhiệt độ – độ ẩm |
| `storage_log.write` | Ghi sổ nhiệt độ – độ ẩm |
| `report.sales` | Báo cáo doanh thu, bán chạy |
| `report.inventory` | Báo cáo xuất – nhập – tồn, hạn dùng |
| `audit.read` | Đọc audit log |
| `ai.use` | Dùng tính năng AI |

### 4.2 Ma trận vai trò → permission [Đã chốt – P5]

| Permission | admin | pharmacist | sales_staff | warehouse_staff | auditor |
|---|:-:|:-:|:-:|:-:|:-:|
| `user.manage` | ✓ | | | | |
| `catalog.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `catalog.manage` | ✓ | ✓ | | | |
| `price.manage` | ✓ | | | | |
| `stock.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `stock.cost.read` | ✓ | | | | ✓ |
| `goods_receipt.read` | ✓ | ✓ | | ✓ | ✓ |
| `goods_receipt.create` | ✓ | ✓ | | ✓ | |
| `goods_receipt.confirm` | ✓ | ✓ | | | |
| `stock.adjust.create` | ✓ | ✓ | | ✓ | |
| `stock.adjust.approve` | ✓ | ✓ | | | |
| `stock.opening_balance` | ✓ | | | | |
| `batch.quarantine` | ✓ | ✓ | | | |
| `recall.manage` | ✓ | ✓ | | | |
| `invoice.read` | ✓ | ✓ | ✓ | | ✓ |
| `invoice.create` | ✓ | ✓ | ✓ | | |
| `invoice.void` | ✓ | ✓ | | | |
| `sale.prescription_drug` | | ✓ | | | |
| `sale.batch_override` | | ✓ | | | |
| `sale.discount` | ✓ | ✓ | ✓ | | |
| `sale.discount.override` | ✓ | | | | |
| `safety.ack` | | ✓ | | | |
| `return.create` | ✓ | ✓ | | | |
| `prescription.read` | | ✓ | ✓ | | |
| `prescription.create` | | ✓ | ✓ | | |
| `prescription.verify` | | ✓ | | | |
| `customer.read` | ✓ | ✓ | ✓ | | |
| `customer.manage` | ✓ | ✓ | ✓ | | |
| `customer.sensitive` | | ✓ | | | |
| `storage_log.read` | ✓ | ✓ | | ✓ | ✓ |
| `storage_log.write` | | ✓ | | ✓ | |
| `report.sales` | ✓ | | | | ✓ |
| `report.inventory` | ✓ | ✓ | | | ✓ |
| `audit.read` | ✓ | | | | ✓ |
| `ai.use` | | ✓ | ✓ | | |

Ghi chú:

- `sale.prescription_drug` chỉ gán cho vai trò `pharmacist` như ma trận trên. Nếu có nhân viên khác đủ điều kiện theo quy định, admin gán thêm vai trò `pharmacist` cho người đó, không gán lẻ permission ra ngoài ma trận. **[Đã chốt – P14]**
- Chủ nhà thuốc đồng thời là dược sĩ thì giữ cả `admin` và `pharmacist`.
- `auditor` chỉ có quyền đọc.

---

## 5. Vòng đời trạng thái

Mọi chuyển trạng thái tuân theo §2.3 (idempotency) và §2.4 (chuyển có điều kiện).

### 5.1 Lô thuốc (`batch`) [Đã chốt]

| Từ | Sang | Endpoint | Permission | Ảnh hưởng |
|---|---|---|---|---|
| (chưa có) | `AVAILABLE` | Xác nhận phiếu nhập, tồn đầu kỳ | `goods_receipt.confirm`, `stock.opening_balance` | Tạo lô, cộng tồn |
| `AVAILABLE` | `QUARANTINED` | `POST /batches/{id}/quarantine` | `batch.quarantine` | Ngừng bán cả lô |
| `QUARANTINED` | `AVAILABLE` | `POST /batches/{id}/release` | `batch.quarantine` | Bán lại được |
| `AVAILABLE`, `QUARANTINED` | `RECALLED` | `POST /recalls` | `recall.manage` | Ngừng bán vĩnh viễn |

- `RECALLED` là trạng thái cuối. Hàng còn lại được xuất khỏi kho bằng phiếu điều chỉnh lý do `RECALL_DISPOSAL` (MVP) hoặc trả nhà cung cấp (sau MVP).
- “Hết hạn” **không** phải trạng thái lưu, mà là điều kiện tính từ `expiryDate` (§2.1).
- **Lô bán được** khi và chỉ khi: `status = AVAILABLE`, chưa hết hạn, và số ngày hạn dùng còn lại ≥ `minRemainingShelfLifeDays`. Mặc định `minRemainingShelfLifeDays = 0`, tức chỉ chặn lô đã hết hạn; hệ thống cảnh báo khi lô còn dưới 30 ngày (`nearExpiryWarningDays = 30`). Cả hai giá trị sửa được trong cài đặt. Quy tắc này áp dụng cả khi người bán chỉ định lô. **[Đã chốt – P11]**
- Trạng thái lô áp cho **cả lô**. Nếu cần biệt trữ một phần số lượng (ví dụ hàng khách trả), phải thêm “ngăn biệt trữ” theo số lượng; để sau MVP. **[Đã chốt – P6]**

### 5.2 Phiếu nhập (`goods-receipt`) [Đã chốt]

| Từ | Sang | Endpoint | Permission | Ảnh hưởng |
|---|---|---|---|---|
| (mới) | `DRAFT` | `POST /goods-receipts` | `goods_receipt.create` | Không đổi tồn |
| `DRAFT` | `CONFIRMED` | `POST /goods-receipts/{id}/confirm` | `goods_receipt.confirm` | Tạo hoặc liên kết lô, cộng tồn, ghi thẻ kho |
| `DRAFT` | `CANCELLED` | `POST /goods-receipts/{id}/cancel` | `goods_receipt.confirm` | Không đổi tồn, giữ bản ghi |

Phiếu `CONFIRMED` không sửa, không hủy. Sai sót sau khi xác nhận xử lý bằng phiếu điều chỉnh (§10.3).

### 5.3 Hóa đơn (`invoice`) [Đã chốt]

| Từ | Sang | Endpoint | Permission | Ảnh hưởng |
|---|---|---|---|---|
| (mới) | `COMPLETED` | `POST /invoices` | `invoice.create` | Trừ tồn theo lô, ghi thẻ kho |
| `COMPLETED` | `VOIDED` | `POST /invoices/{id}/void` | `invoice.void` | Hoàn tồn về đúng các lô đã xuất |

- Chỉ hủy được khi hóa đơn chưa có phiếu trả nào và còn trong thời hạn cho phép (đề xuất: trong ngày bán). **[Đã chốt – P12]**
- Trả hàng không đổi `status`; hóa đơn có thêm trường dẫn xuất `returnStatus`: `NONE`, `PARTIAL`, `FULL`.

### 5.4 Đơn thuốc (`prescription`) [Đã chốt]

| Từ | Sang | Endpoint | Permission |
|---|---|---|---|
| (mới) | `DRAFT` | `POST /prescriptions` | `prescription.create` |
| `DRAFT` | `PENDING_REVIEW` | `POST /prescriptions/{id}/scan` (OCR, sau MVP) hoặc `POST /prescriptions/{id}/submit` | `prescription.create` |
| `DRAFT`, `PENDING_REVIEW` | `VERIFIED` | `POST /prescriptions/{id}/verify` | `prescription.verify` |
| `DRAFT`, `PENDING_REVIEW` | `REJECTED` | `POST /prescriptions/{id}/reject` | `prescription.verify` |
| `VERIFIED` | `PARTIALLY_DISPENSED` | Tự động khi bán một phần | (theo hóa đơn) |
| `VERIFIED`, `PARTIALLY_DISPENSED` | `DISPENSED` | Tự động khi đã bán đủ số lượng kê | (theo hóa đơn) |

- Chỉ sửa được ở `DRAFT` và `PENDING_REVIEW`.
- “Hết hiệu lực” là điều kiện tính từ `validUntil`, không phải trạng thái lưu. `validUntil = prescribedDate + prescriptionValidityDays`, **mặc định 5 ngày** theo quy định kê đơn (đơn thuốc có giá trị mua thuốc trong thời hạn tối đa 5 ngày kể từ ngày kê). Giá trị sửa được trong cài đặt và phải đối chiếu văn bản kê đơn đang có hiệu lực trước khi vận hành thật. Với đơn bệnh mạn tính kê dài ngày, người có `prescription.verify` nhập thẳng `validUntil` và hệ thống giữ nguyên giá trị đó. **[Đã chốt – P14]**
- Hủy hóa đơn hoặc trả hàng thì giảm lại số lượng đã bán theo đơn và cập nhật trạng thái tương ứng.

### 5.5 Phiếu điều chỉnh tồn (`stock-adjustment`)

| Từ | Sang | Endpoint | Permission | Ảnh hưởng |
|---|---|---|---|---|
| (mới) | `DRAFT` | `POST /stock-adjustments` | `stock.adjust.create` | Chụp tồn hệ thống lúc lập, không đổi tồn |
| `DRAFT` | `APPROVED` | `POST /stock-adjustments/{id}/approve` | `stock.adjust.approve` | Áp dụng **chênh lệch** vào tồn, ghi thẻ kho |
| `DRAFT` | `REJECTED` | `POST /stock-adjustments/{id}/reject` | `stock.adjust.approve` | Không đổi tồn |
| `DRAFT` | `CANCELLED` | `POST /stock-adjustments/{id}/cancel` | `stock.adjust.create` (người lập) | Không đổi tồn |

Người duyệt phải khác người lập (`422 SELF_APPROVAL_NOT_ALLOWED`). Áp dụng làm tồn âm thì trả `409 INSUFFICIENT_STOCK`. **[Đã chốt – P4]**

### 5.6 Thông báo thu hồi (`recall`) [Đã chốt]

| Từ | Sang | Endpoint | Permission | Ảnh hưởng |
|---|---|---|---|---|
| (mới) | `OPEN` | `POST /recalls` | `recall.manage` | Chuyển các lô khớp sang `RECALLED` |
| `OPEN` | `CLOSED` | `POST /recalls/{id}/close` | `recall.manage` | Chỉ khi tồn của các lô bị thu hồi bằng 0 |

---

## 6. Danh mục

### 6.1 Nhóm sản phẩm

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/categories` | Danh sách nhóm | `catalog.read` |
| GET | `/categories/{id}` | Chi tiết nhóm | `catalog.read` |
| POST | `/categories` | Tạo nhóm | `catalog.manage` |
| PATCH | `/categories/{id}` | Sửa nhóm | `catalog.manage` |
| POST | `/categories/{id}/deactivate` | Ngừng dùng; từ chối nếu còn sản phẩm đang dùng | `catalog.manage` |
| POST | `/categories/{id}/activate` | Dùng lại | `catalog.manage` |

### 6.2 Sản phẩm

Sản phẩm gồm cả thuốc và hàng không phải thuốc. Trường chính:

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `id` | string | |
| `code` | string | Mã nội bộ (SKU), duy nhất |
| `name` | string | |
| `productType` | enum | `DRUG`, `SUPPLEMENT`, `MEDICAL_DEVICE`, `COSMETIC`, `OTHER` |
| `drugClass` | enum \| null | Chỉ với `DRUG`: `OTC`, `RX` (kê đơn), `CONTROLLED` (kiểm soát đặc biệt) |
| `registrationNumber` | string \| null | Số đăng ký lưu hành |
| `activeIngredients` | array | `[{ ingredientId, strengthText }]` |
| `dosageForm`, `strengthText`, `packagingText` | string | Dạng bào chế, hàm lượng, quy cách |
| `manufacturer`, `countryOfOrigin` | string | |
| `storageCondition` | string | Điều kiện bảo quản |
| `categoryId` | string | |
| `baseUnitId` | string | Đơn vị nhỏ nhất (§6.3) |
| `minStockBaseQuantity` | integer | Ngưỡng tồn tối thiểu theo đơn vị nhỏ nhất |
| `isActive`, `version` | | |

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/products` | Lọc `categoryId`, `productType`, `drugClass`, `isActive`; tìm theo tên, hoạt chất, mã | `catalog.read` |
| GET | `/products/{id}` | Chi tiết, đơn vị, giá hiện hành, tồn tổng hợp | `catalog.read` |
| POST | `/products` | Tạo sản phẩm kèm đơn vị cơ bản | `catalog.manage` |
| PATCH | `/products/{id}` | Sửa (whitelist trường, có `version`) | `catalog.manage` |
| POST | `/products/{id}/deactivate` | Ngừng kinh doanh; không xóa vật lý | `catalog.manage` |
| POST | `/products/{id}/activate` | Kinh doanh lại | `catalog.manage` |
| GET | `/products/{id}/batches` | Các lô của sản phẩm | `stock.read` |

Đã bỏ khỏi bản gốc: `/products/expiring-soon`, `/products/low-stock` (thay bằng bộ lọc ở §8 và §10.1).

### 6.3 Đơn vị và quy đổi [Đã chốt]

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `id` | string | |
| `name` | string | Ví dụ `Hộp`, `Vỉ`, `Viên` |
| `conversionToBase` | integer ≥ 1 | Số đơn vị nhỏ nhất trong một đơn vị này. Đơn vị cơ bản có giá trị 1 |
| `barcodes` | string[] | Mã vạch in trên quy cách này |
| `isSellable` | boolean | Có bán lẻ theo đơn vị này không |
| `isDefaultSaleUnit` | boolean | Đơn vị mặc định khi quét hoặc chọn |

Ví dụ: Paracetamol 500 mg có `Viên` = 1, `Vỉ` = 10, `Hộp` = 100.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/products/{id}/units` | Danh sách đơn vị | `catalog.read` |
| POST | `/products/{id}/units` | Thêm đơn vị | `catalog.manage` |
| PATCH | `/products/{id}/units/{unitId}` | Sửa tên, mã vạch, `isSellable` | `catalog.manage` |
| GET | `/product-units/by-barcode/{barcode}` | Tra mã vạch, trả sản phẩm và đơn vị tương ứng | `catalog.read` |

Quy tắc:

- Mỗi sản phẩm có đúng một đơn vị có `conversionToBase = 1`.
- Không sửa `conversionToBase` sau khi đơn vị đã phát sinh giao dịch; muốn đổi thì tạo đơn vị mới và ngừng bán đơn vị cũ.
- Một mã vạch chỉ thuộc về một đơn vị trong toàn hệ thống.

### 6.4 Hoạt chất

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/active-ingredients` | Danh sách, tìm kiếm | `catalog.read` |
| POST | `/active-ingredients` | Tạo | `catalog.manage` |
| PATCH | `/active-ingredients/{id}` | Sửa | `catalog.manage` |

Hoạt chất dùng để tìm thuốc thay thế, kiểm tra trùng hoạt chất, dị ứng và tương tác.

### 6.5 Giá bán và VAT [Đã chốt]

Giá được quản lý theo **phiên bản**: mỗi lần đổi giá tạo một bản ghi mới, không sửa hay xóa bản cũ.

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `unitId` | string | Giá áp cho đơn vị nào |
| `salePrice` | integer (VND) | Giá niêm yết một đơn vị |
| `vatRatePercent` | number | Ví dụ `5`, `8`, `10` |
| `effectiveFrom` | timestamp | Có hiệu lực từ thời điểm này |
| `createdBy`, `createdAt` | | |

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/products/{id}/prices` | Lịch sử giá; lọc `unitId`; `?at=` để xem giá tại một thời điểm | `catalog.read` |
| POST | `/products/{id}/prices` | Tạo phiên bản giá mới cho một đơn vị | `price.manage` |

Quy tắc:

- Giá hiện hành của một đơn vị là phiên bản có `effectiveFrom` gần nhất nhưng không sau thời điểm bán.
- Bán một đơn vị chưa có giá: `422 PRICE_NOT_SET`.
- `salePrice` là giá đã gồm VAT; VAT trên hóa đơn được tách ngược từ giá, làm tròn đến đồng theo từng dòng. **[Đã chốt – P9]**

### 6.6 Giảm giá [Đã chốt]

- Giảm giá gửi dưới dạng `{ "type": "PERCENT" | "AMOUNT", "value": number, "reason": string }`, áp cho từng dòng hoặc cả hóa đơn.
- Backend tự tính số tiền giảm, không nhận số tiền giảm tính sẵn từ Frontend.
- Người có `sale.discount` chỉ được giảm trong hạn mức cấu hình cho vai trò (đề xuất: tối đa 5% với `sales_staff`, 10% với `pharmacist`). Vượt hạn mức cần `sale.discount.override`, nếu không trả `422 DISCOUNT_LIMIT_EXCEEDED`. **[Đã chốt – P10]**
- Hóa đơn lưu loại, giá trị, lý do và người áp dụng giảm giá.

---

## 7. Nhà cung cấp

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/suppliers` | Danh sách | `catalog.read` |
| GET | `/suppliers/{id}` | Chi tiết | `catalog.read` |
| GET | `/suppliers/{id}/goods-receipts` | Lịch sử nhập hàng | `goods_receipt.read` |
| POST | `/suppliers` | Tạo | `catalog.manage` |
| PATCH | `/suppliers/{id}` | Sửa | `catalog.manage` |
| POST | `/suppliers/{id}/deactivate` | Ngừng giao dịch | `catalog.manage` |
| POST | `/suppliers/{id}/activate` | Giao dịch lại | `catalog.manage` |

Trường chính: `name`, `taxCode`, `licenseNumber` (giấy chứng nhận đủ điều kiện kinh doanh dược), `address`, `phone`, `isActive`.

---

## 8. Lô thuốc

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `id` | string | |
| `productId` | string | |
| `batchNumber` | string | Số lô; duy nhất theo (`productId`, `batchNumber`) |
| `manufactureDate` | date \| null | |
| `expiryDate` | date | Bắt buộc |
| `status` | enum | `AVAILABLE`, `QUARANTINED`, `RECALLED` (§5.1) |
| `isExpired`, `isSellable` | boolean | Tính sẵn theo §2.1, §5.1 |
| `quantityOnHand` | object | `{ baseQuantity, baseUnit }` |
| `unitCost` | decimal string | Giá vốn trên đơn vị nhỏ nhất; chỉ trả khi có `stock.cost.read` |
| `sourceType`, `sourceId` | | Phiếu nhập hoặc tồn đầu kỳ đã tạo lô |

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/batches` | Lọc `productId`, `status`, `expiresBefore`, `sellable`, `includeEmpty` (mặc định `false`) | `stock.read` |
| GET | `/batches/{id}` | Chi tiết lô và tồn | `stock.read` |
| PATCH | `/batches/{id}` | Chỉ sửa `note`, `shelfLocation` (vị trí kệ) | `batch.quarantine` |
| POST | `/batches/{id}/quarantine` | `AVAILABLE` → `QUARANTINED`; bắt buộc `reason` | `batch.quarantine` |
| POST | `/batches/{id}/release` | `QUARANTINED` → `AVAILABLE`; bắt buộc `reason` | `batch.quarantine` |
| POST | `/batches/{id}/corrections` | Sửa `batchNumber`, `expiryDate`, `manufactureDate` do nhập sai; bắt buộc `reason` | `stock.adjust.approve` |

- **Không có `POST /batches`.** Lô chỉ sinh ra khi xác nhận phiếu nhập (§9) hoặc nhập tồn đầu kỳ (§10.4). **[Đã chốt – P3]**
- Nhập sai số lô hoặc hạn dùng là sai **thông tin**, còn hàng vẫn là hàng đó; vì vậy sửa trên chính lô, không di chuyển tồn. Mọi hóa đơn đã xuất từ lô tự động mang thông tin đã sửa. Audit log lưu giá trị trước và sau. Nếu số lô mới trùng một lô khác của cùng sản phẩm, trả `409` và xử lý thủ công. **[Đã chốt – P3]**

---

## 9. Phiếu nhập (goods receipts) [Đã chốt]

Phiếu nhập ghi nhận hàng **thực nhận** từ nhà cung cấp. Đơn đặt hàng gửi nhà cung cấp (purchase order) là tài nguyên riêng, để sau MVP.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/goods-receipts` | Lọc `supplierId`, `status`, `from`, `to` | `goods_receipt.read` |
| GET | `/goods-receipts/{id}` | Chi tiết, các dòng, lô đã tạo hoặc liên kết | `goods_receipt.read` |
| POST | `/goods-receipts` | Tạo phiếu `DRAFT`; cần `Idempotency-Key` | `goods_receipt.create` |
| PATCH | `/goods-receipts/{id}` | Sửa khi còn `DRAFT`; cần `version` | `goods_receipt.create` |
| POST | `/goods-receipts/{id}/confirm` | Kiểm nhập và xác nhận; cần `Idempotency-Key` | `goods_receipt.confirm` |
| POST | `/goods-receipts/{id}/cancel` | Hủy phiếu `DRAFT`; bắt buộc `reason` | `goods_receipt.confirm` |

Ví dụ tạo phiếu:

```json
{
  "supplierId": "sup_01",
  "supplierInvoiceNumber": "0001234",
  "supplierInvoiceDate": "2026-09-10",
  "receivedAt": "2026-09-11T02:15:00Z",
  "note": "Giao đợt 1",
  "lines": [
    {
      "productId": "prd_para500",
      "unitId": "unt_hop",
      "quantity": 20,
      "unitCost": 25000,
      "batchNumber": "PA240915",
      "manufactureDate": "2024-09-15",
      "expiryDate": "2027-09-14"
    }
  ]
}
```

Khi tạo hoặc sửa, backend kiểm tra: sản phẩm đang kinh doanh, `unitId` thuộc sản phẩm, `expiryDate` sau ngày hiện tại, số lượng là số nguyên dương. Backend tự tính số lượng theo đơn vị nhỏ nhất và thành tiền từng dòng.

Khi **confirm**, trong một transaction:

1. Chuyển `DRAFT` → `CONFIRMED` có điều kiện (§2.4).
2. Với từng dòng, tìm lô theo (`productId`, `batchNumber`):
   - Chưa có: tạo lô `AVAILABLE`.
   - Đã có, khác `expiryDate`: dừng, trả `409 BATCH_EXPIRY_MISMATCH`.
   - Đã có, trạng thái `RECALLED`: dừng, trả `422 BATCH_NOT_SELLABLE`.
3. Cộng tồn và ghi một dòng thẻ kho loại `RECEIPT` cho mỗi dòng phiếu.
4. Ghi audit log.
5. Bất kỳ bước nào lỗi thì rollback toàn bộ.

Người xác nhận chịu trách nhiệm kiểm nhập theo GPP. Lô nghi ngờ chất lượng được biệt trữ ngay sau khi xác nhận (§8).

---

## 10. Tồn kho

### 10.1 Tồn tổng hợp

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/inventory` | Tồn theo sản phẩm; lọc `productId`, `categoryId`, `belowMinStock=true` | `stock.read` |

Mỗi sản phẩm trả về số lượng theo đơn vị nhỏ nhất, tách thành: bán được, biệt trữ, bị thu hồi, đã hết hạn.

### 10.2 Thẻ kho [Đã chốt]

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/inventory/transactions` | Lọc `batchId`, `productId`, `type`, `from`, `to`; phân trang con trỏ | `stock.read` |

| Trường | Ghi chú |
|---|---|
| `id`, `occurredAt` | |
| `type` | `RECEIPT`, `OPENING_BALANCE`, `SALE`, `SALE_VOID`, `CUSTOMER_RETURN`, `ADJUSTMENT`, `DISPOSAL` |
| `batchId`, `productId` | |
| `baseQuantity` | Có dấu: dương là nhập, âm là xuất |
| `balanceAfter` | Tồn của lô sau giao dịch |
| `sourceType`, `sourceId`, `sourceLineId` | Chứng từ gốc |
| `userId` | Người thực hiện |

Thẻ kho **chỉ thêm, không sửa, không xóa**. Tồn của một lô luôn bằng tổng `baseQuantity` của các dòng thẻ kho của lô đó.

### 10.3 Điều chỉnh tồn

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/stock-adjustments` | Lọc `status`, `from`, `to` | `stock.read` |
| GET | `/stock-adjustments/{id}` | Chi tiết | `stock.read` |
| POST | `/stock-adjustments` | Lập phiếu `DRAFT` | `stock.adjust.create` |
| POST | `/stock-adjustments/{id}/approve` | Duyệt; cần `Idempotency-Key` | `stock.adjust.approve` |
| POST | `/stock-adjustments/{id}/reject` | Từ chối; bắt buộc `reason` | `stock.adjust.approve` |
| POST | `/stock-adjustments/{id}/cancel` | Người lập hủy phiếu nháp | `stock.adjust.create` |

- Mỗi dòng gồm `batchId`, `unitId`, `reasonCode` và một trong hai:
  - `COUNT_DIFFERENCE` (lệch khi kiểm kê): gửi `countedQuantity` là số đếm thực tế. Thẻ kho ghi loại `ADJUSTMENT`.
  - `DAMAGED`, `EXPIRED_DISPOSAL`, `RECALL_DISPOSAL`, `OTHER`: gửi `quantity` là số lượng xuất khỏi kho. Thẻ kho ghi loại `DISPOSAL`.
- Với `COUNT_DIFFERENCE`, khi lập phiếu **backend** tự chụp tồn hệ thống của lô tại thời điểm đó; client không gửi tồn hệ thống.
- Khi duyệt, backend áp dụng **chênh lệch** (số đếm − tồn đã chụp, hoặc −`quantity`), không gán tồn bằng số đếm. Các giao dịch bán giữa lúc đếm và lúc duyệt vì thế không bị mất. **[Đã chốt – P4]**
- Người duyệt khác người lập. **[Đã chốt – P4]**
- Kiểm kê toàn kho theo đợt (khóa kho, đếm theo khu vực): sau MVP.

### 10.4 Tồn đầu kỳ [Đã chốt – P3]

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| POST | `/inventory/opening-balances` | Nhập tồn hiện có khi bắt đầu dùng hệ thống; cần `Idempotency-Key` | `stock.opening_balance` |

- Mỗi dòng: `productId`, `unitId`, `quantity`, `batchNumber`, `expiryDate`, `unitCost`.
- Tạo lô `AVAILABLE` và dòng thẻ kho loại `OPENING_BALANCE` trong một transaction.
- Chỉ dùng được trước khi phát sinh hóa đơn đầu tiên. Sau đó endpoint trả `409 INVALID_STATE`.

---

## 11. Khách hàng

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/customers` | Tìm theo tên hoặc số điện thoại (tối thiểu 3 ký tự); trả trường tối thiểu, số điện thoại che bớt | `customer.read` |
| GET | `/customers/{id}` | Thông tin cơ bản | `customer.read` |
| POST | `/customers` | Tạo khách | `customer.manage` |
| PATCH | `/customers/{id}` | Sửa thông tin cơ bản | `customer.manage` |
| GET | `/customers/{id}/health-profile` | Dị ứng (theo hoạt chất và ghi chú), bệnh nền; ghi audit mỗi lần xem | `customer.sensitive` |
| PATCH | `/customers/{id}/health-profile` | Cập nhật hồ sơ sức khỏe | `customer.sensitive` |
| GET | `/customers/{id}/invoices` | Lịch sử mua; ghi audit mỗi lần xem | `customer.sensitive` |

- Thông tin cơ bản: `fullName`, `phone`, `birthYear`, `gender`, `note`.
- Hồ sơ sức khỏe chỉ được lưu khi đã ghi nhận sự đồng ý của khách (`healthDataConsentAt`). **[Đã chốt – P8]**
- Đã bỏ `GET /customers/{id}/allergy-check`; kiểm tra dị ứng nằm trong `POST /sales/safety-check` (§13).
- **Lưu trữ và ẩn danh [Đã chốt – P8]:** hóa đơn, đơn thuốc và thẻ kho giữ theo thời hạn lưu trữ quy định, không xóa. Khi khách yêu cầu xóa dữ liệu cá nhân, hệ thống **ẩn danh hồ sơ khách** (xóa họ tên, số điện thoại, hồ sơ sức khỏe, thay bằng mã ẩn danh) và giữ nguyên chứng từ đã phát sinh. Thao tác ẩn danh cần `customer.sensitive`, bắt buộc ghi lý do và ghi audit log.

---

## 12. Đơn thuốc [Đã chốt]

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/prescriptions` | Lọc `customerId`, `status`, `from`, `to` | `prescription.read` |
| GET | `/prescriptions/{id}` | Chi tiết, các dòng, số lượng đã bán; ghi audit | `prescription.read` |
| POST | `/prescriptions` | Tạo đơn `DRAFT` | `prescription.create` |
| PATCH | `/prescriptions/{id}` | Sửa khi `DRAFT` hoặc `PENDING_REVIEW`; cần `version` | `prescription.create` |
| POST | `/prescriptions/{id}/images` | Tải ảnh đơn (`multipart/form-data`) | `prescription.create` |
| POST | `/prescriptions/{id}/submit` | `DRAFT` → `PENDING_REVIEW` | `prescription.create` |
| POST | `/prescriptions/{id}/verify` | Dược sĩ xác nhận → `VERIFIED` | `prescription.verify` |
| POST | `/prescriptions/{id}/reject` | Từ chối; bắt buộc `reason` | `prescription.verify` |
| POST | `/prescriptions/{id}/scan` | OCR ảnh đơn → `PENDING_REVIEW`; **sau MVP** | `prescription.create`, `ai.use` |

Trường chính của đơn: `customerId` (có thể trống), `externalCode` (mã đơn thuốc điện tử nếu có), `prescriberName`, `facilityName`, `diagnosisText`, `prescribedDate`, `validUntil`, `status`, `verifiedBy`, `verifiedAt`.

Mỗi dòng đơn: `productId` (có thể trống khi thuốc chưa có trong danh mục), `drugNameText`, `quantity` + `unitId`, `dosageInstruction`, `dispensedBaseQuantity` (backend tự cập nhật).

Quy tắc:

- Khi `verify`: mọi dòng thuốc kê đơn phải gắn `productId`; `verifiedBy` lấy từ phiên đăng nhập, không nhận từ body.
- Kết quả OCR (sau MVP) chỉ đưa đơn về `PENDING_REVIEW`, lưu độ tin cậy từng trường và phần không đọc được; không bao giờ tự chuyển sang `VERIFIED`.
- Ảnh đơn: chỉ nhận JPEG, PNG, PDF (kiểm tra theo nội dung tệp), giới hạn dung lượng, xóa EXIF, lưu ngoài thư mục public, chỉ truy cập qua URL có chữ ký và hạn ngắn; mỗi lần tải lên là một phiên bản mới.
- Danh mục bác sĩ riêng (`/doctors`): sau MVP; MVP lưu tên người kê đơn và cơ sở khám ngay trên đơn. **[Đã chốt – P15]**

---

## 13. Kiểm tra an toàn khi bán [Đã chốt – P7]

Thay cho `POST /ai/drug-interaction-check`, `POST /ai/allergy-check` và `GET /customers/{id}/allergy-check` trong bản gốc. Đây là kiểm tra **tất định** dựa trên dữ liệu và luật; không dùng LLM.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| POST | `/sales/safety-check` | Kiểm tra giỏ hàng trước khi thanh toán | `invoice.create` |

Request: `customerId` (tùy chọn), `prescriptionId` (tùy chọn), `lines: [{ productId, unitId, quantity }]`.

Response:

```json
{
  "blocking": [
    { "code": "PRESCRIPTION_REQUIRED", "productId": "prd_amox500" }
  ],
  "warnings": [
    {
      "code": "DUPLICATE_INGREDIENT",
      "severity": "HIGH",
      "requiresAck": true,
      "productIds": ["prd_para500", "prd_decolgen"],
      "message": "Hai sản phẩm cùng chứa paracetamol",
      "source": "rule:duplicate-ingredient",
      "sourceVersion": "2026-09-01"
    }
  ],
  "notChecked": [
    { "productId": "prd_x", "reason": "NO_INGREDIENT_MAPPING" }
  ]
}
```

- `blocking`: vi phạm quy tắc cứng (thuốc kê đơn chưa có đơn đã xác nhận, lô không bán được, không đủ tồn). Không thể bỏ qua.
- `warnings`: trùng hoạt chất, dị ứng theo hồ sơ khách, tương tác thuốc (nếu có nguồn dữ liệu). Mức `severity`: `INFO`, `MEDIUM`, `HIGH`.
- `notChecked`: những gì **không kiểm tra được**, ví dụ sản phẩm chưa gắn hoạt chất, nguồn dữ liệu tương tác không có thông tin. Frontend phải hiển thị rõ, không được coi là “an toàn”.
- **Phạm vi trong MVP:** thuốc kê đơn phải có đơn đã xác nhận, lô phải bán được, phải đủ tồn, cảnh báo trùng hoạt chất và cảnh báo dị ứng theo hoạt chất. **Kiểm tra tương tác thuốc chỉ bật khi nhóm có nguồn dữ liệu đáng tin cậy**, không thuộc MVP, và không dùng LLM để thay cho nguồn dữ liệu đó. Khi bật, mỗi cảnh báo phải kèm `source` và `sourceVersion`. **[Đã chốt – P7]**

---

## 14. Bán hàng (hóa đơn)

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| POST | `/invoices` | Tạo hóa đơn `COMPLETED`; cần `Idempotency-Key` | `invoice.create` |
| GET | `/invoices` | Lọc `from`, `to`, `customerId`, `sellerId`, `status` | `invoice.read` |
| GET | `/invoices/{id}` | Chi tiết, các dòng, **lô thực tế đã xuất**, phiếu trả liên quan | `invoice.read` |
| POST | `/invoices/{id}/void` | Hủy hóa đơn; bắt buộc `reason`; cần `Idempotency-Key` | `invoice.void` |
| GET | `/invoices/{id}/print` | `?format=k80` (máy in nhiệt 80 mm) hoặc `?format=a5` | `invoice.read` |

### 14.1 Request tạo hóa đơn

```json
{
  "customerId": "cus_01",
  "prescriptionId": "rx_01",
  "lines": [
    { "productId": "prd_amox500", "unitId": "unt_vi", "quantity": 2, "prescriptionItemId": "rxi_01" },
    { "productId": "prd_para500", "unitId": "unt_vien", "quantity": 10,
      "batchId": "bat_77", "batchOverrideReason": "Khách cần hạn dùng dài để mang đi công tác" }
  ],
  "discount": { "type": "PERCENT", "value": 5, "reason": "Khách quen" },
  "acknowledgedWarnings": [
    { "code": "DUPLICATE_INGREDIENT", "productIds": ["prd_para500", "prd_decolgen"], "reason": "Đã tư vấn, khách chỉ dùng một loại" }
  ],
  "payment": { "method": "CASH", "amountTendered": 100000 }
}
```

Frontend **không** gửi: đơn giá, thành tiền, số tiền giảm, VAT, tổng tiền, tồn kho, lô FEFO, người bán, người ghi nhận cảnh báo. Nếu các trường này có trong body, backend bỏ qua.

`payment.method`: `CASH`, `BANK_TRANSFER`, `CARD` (chỉ ghi nhận; tích hợp cổng thanh toán để sau MVP).

### 14.2 Xử lý của backend

Tất cả các bước dưới đây nằm trong **một transaction**. Không gọi dịch vụ bên ngoài (AI, cổng thanh toán) trong transaction.

1. Kiểm tra sản phẩm đang kinh doanh; `unitId` thuộc sản phẩm (`422 UNIT_NOT_IN_PRODUCT`).
2. Quy đổi mỗi dòng sang `baseQuantity`.
3. Dòng có `drugClass` là `RX` hoặc `CONTROLLED`: bắt buộc `prescriptionId` ở trạng thái `VERIFIED` hoặc `PARTIALLY_DISPENSED`, còn hiệu lực; số lượng bán cộng dồn không vượt số lượng kê; người bán có `sale.prescription_drug`.
4. Chạy lại kiểm tra an toàn như §13. Còn mục `blocking` thì dừng. Cảnh báo có `requiresAck` phải có trong `acknowledgedWarnings` và người bán có `safety.ack`, nếu không trả `422 SAFETY_ACK_REQUIRED`.
5. Lấy giá hiện hành theo `unitId` (§6.5).
6. Kiểm tra giảm giá theo hạn mức (§6.6) rồi tự tính số tiền giảm.
7. Chọn lô:
   - Mặc định FEFO: các lô **bán được** (§5.1) của sản phẩm, sắp theo `expiryDate` rồi `id`.
   - Nếu dòng có `batchId`: cần `sale.batch_override` và `batchOverrideReason`; lô vẫn phải bán được.
   - Khóa các lô được chọn theo thứ tự cố định (theo `productId`, rồi `batchId`) để tránh deadlock khi nhiều quầy bán cùng lúc.
8. Không đủ tồn bán được: `409 INSUFFICIENT_STOCK`, `details` gồm `productId`, số lượng yêu cầu và số lượng bán được (theo đơn vị nhỏ nhất).
9. Tính thành tiền từng dòng, giảm giá, VAT tách từ giá đã gồm VAT, tổng tiền, tiền thừa trả khách.
10. Ghi hóa đơn (số hóa đơn sinh tuần tự), các dòng, bảng phân bổ lô, dòng thẻ kho loại `SALE` (số âm), số lượng đã bán theo đơn thuốc.
11. Ghi audit log. Bất kỳ bước nào lỗi thì rollback toàn bộ.

CSDL có ràng buộc tồn của lô không âm, làm lớp chặn cuối cùng nếu mã có lỗi.

### 14.3 Dữ liệu lưu trên hóa đơn [Đã chốt]

- Mỗi dòng hóa đơn lưu lại tại thời điểm bán: tên sản phẩm, tên đơn vị, `conversionToBase`, đơn giá, `vatRatePercent`, số tiền giảm, thành tiền. Đổi giá hoặc đổi tên sau này không làm thay đổi hóa đơn cũ.
- Bảng phân bổ lô: mỗi dòng hóa đơn có một hoặc nhiều phân bổ `{ allocationId, batchId, baseQuantity }`. `GET /invoices/{id}` trả kèm phân bổ này.

### 14.4 Hủy hóa đơn

- Chỉ hủy được hóa đơn `COMPLETED`, chưa có phiếu trả, trong thời hạn cho phép. **[Đã chốt – P12]**
- Trong một transaction: chuyển `COMPLETED` → `VOIDED` có điều kiện; ghi thẻ kho loại `SALE_VOID` cộng lại đúng các lô đã xuất; giảm lại số lượng đã bán theo đơn thuốc; ghi audit log.

---

## 15. Trả hàng [Đã chốt]

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| POST | `/invoices/{id}/returns` | Tạo phiếu trả; cần `Idempotency-Key` | `return.create` |
| GET | `/returns` | Lọc `from`, `to`, `invoiceId` | `invoice.read` |
| GET | `/returns/{id}` | Chi tiết phiếu trả | `invoice.read` |

Request:

```json
{
  "reason": "Khách mua nhầm hàm lượng",
  "disposition": "RESTOCK",
  "refundMethod": "CASH",
  "lines": [
    { "invoiceLineId": "inl_02", "allocationId": "alc_05", "unitId": "unt_vien", "quantity": 10 }
  ]
}
```

Backend, trong một transaction:

1. Khóa các dòng hóa đơn và phân bổ liên quan.
2. Dòng hóa đơn lấy từ nhiều lô thì bắt buộc gửi `allocationId`, tức lô in trên hàng khách mang trả.
3. Kiểm tra số lượng trả cộng dồn theo từng phân bổ không vượt số đã xuất (`422 RETURN_QUANTITY_EXCEEDED`).
4. Tiền hoàn tính theo đơn giá và giảm giá **đã lưu trên hóa đơn gốc**, không theo giá hiện hành.
5. Ghi thẻ kho loại `CUSTOMER_RETURN` cộng vào **đúng lô đã xuất**.
6. `disposition`:
   - `RESTOCK`: dược sĩ đã kiểm tra hàng còn nguyên vẹn và điều kiện bảo quản đảm bảo; hàng quay lại lô.
   - `DISPOSE`: ghi thêm dòng thẻ kho loại `DISPOSAL` (số âm) cho cùng số lượng; hàng không quay lại để bán.
7. Giảm số lượng đã bán theo đơn thuốc (nếu có); cập nhật `returnStatus` của hóa đơn; ghi audit log.

Chính sách trả hàng **[Đã chốt – P6]**:

- Nhận trả trong `returnWindowDays` kể từ ngày bán, mặc định 7 ngày; quá hạn trả `422 RETURN_WINDOW_EXPIRED`.
- **Không nhận trả** sản phẩm `drugClass = RX` hoặc `CONTROLLED`, trừ trường hợp thuốc có lỗi chất lượng. Khi đó dược sĩ tạo phiếu trả với `disposition = DISPOSE` và bắt buộc ghi lý do; hàng không quay lại kho bán.
- Ngăn biệt trữ theo số lượng: sau MVP. Trong MVP, dược sĩ chọn `RESTOCK` hoặc `DISPOSE` ngay khi nhận hàng trả.

---

## 16. Thu hồi [Đã chốt]

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| POST | `/recalls` | Tạo thông báo thu hồi; cần `Idempotency-Key` | `recall.manage` |
| GET | `/recalls` | Danh sách | `recall.manage` |
| GET | `/recalls/{id}` | Chi tiết, các lô bị ảnh hưởng, tồn còn lại | `recall.manage` |
| GET | `/recalls/{id}/affected-sales` | Hóa đơn và khách hàng đã mua các lô bị thu hồi; ghi audit | `recall.manage` |
| POST | `/recalls/{id}/close` | Đóng khi tồn các lô bị thu hồi bằng 0 | `recall.manage` |

- Request tạo: `documentNumber` (số công văn), `issuedBy`, `issuedAt`, `reason`, `items: [{ productId, batchNumber }]`.
- Trong một transaction: tạo thu hồi `OPEN`; chuyển mọi lô khớp từ `AVAILABLE` hoặc `QUARANTINED` sang `RECALLED`; số lô không có trong kho vẫn được ghi lại để đối chiếu.
- Từ lúc này, lô bị thu hồi không xuất hiện trong lựa chọn FEFO và không thể chỉ định để bán.
- Xuất hàng thu hồi khỏi kho bằng phiếu điều chỉnh lý do `RECALL_DISPOSAL` (§10.3). Trả nhà cung cấp: sau MVP.

---

## 17. Sổ nhiệt độ – độ ẩm [Đã chốt]

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/storage-logs` | Lọc `location`, `from`, `to`, `outOfRange` | `storage_log.read` |
| POST | `/storage-logs` | Ghi một lần đo | `storage_log.write` |
| GET | `/storage-logs/summary` | `?month=2026-09`: bảng theo ngày để in, đánh dấu lần đo bị thiếu hoặc vượt ngưỡng | `storage_log.read` |

- Request: `location` (ví dụ `RETAIL_AREA`, `FRIDGE`), `recordedAt`, `temperatureC` (một chữ số thập phân), `humidityPercent`, `note`.
- Backend tự đặt `outOfRange` theo ngưỡng cấu hình của từng khu vực. Mặc định: khu bán lẻ ≤ 30 °C và độ ẩm ≤ 75 %; tủ lạnh 2–8 °C. Sửa được trong cài đặt, và phải đối chiếu lại với văn bản GPP đang có hiệu lực trước khi vận hành thật. **[Đã chốt – P16]**
- Nhắc ghi sổ 2 lần mỗi ngày (`storageLogPerDay = 2`, sửa được); `GET /storage-logs/summary` đánh dấu ngày còn thiếu lần đo.
- Bản ghi không sửa, không xóa. Ghi nhầm thì tạo bản ghi mới có `correctsLogId` trỏ tới bản cũ.

---

## 18. Audit log [Đã chốt]

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/audit-logs` | Lọc `actorId`, `action`, `resourceType`, `resourceId`, `from`, `to`; phân trang con trỏ | `audit.read` |

- Không có API tạo, sửa, xóa. Backend tự ghi. Tài khoản CSDL của ứng dụng chỉ có quyền thêm vào bảng audit.
- Trường: `id`, `occurredAt`, `actorId`, `action`, `resourceType`, `resourceId`, `requestId`, `ip`, `userAgent`, `before`, `after`, `reason`.
- Ghi audit cho: đăng nhập, đăng xuất, đổi và đặt lại mật khẩu, đổi vai trò; tạo, sửa, ngừng dùng danh mục; tạo phiên bản giá; confirm, cancel phiếu nhập; tồn đầu kỳ; lập, duyệt, từ chối điều chỉnh; biệt trữ, mở khóa, sửa thông tin lô; tạo, đóng thu hồi; tạo, hủy hóa đơn; trả hàng; ghi nhận cảnh báo an toàn; verify, reject đơn thuốc; **mọi lần xem** hồ sơ sức khỏe, lịch sử mua, đơn thuốc, danh sách khách bị ảnh hưởng bởi thu hồi.
- Không ghi mật khẩu, token. `before` và `after` bỏ các trường nhạy cảm không cần thiết.

---

## 19. Dashboard và báo cáo

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/dashboard/summary` | Doanh thu và số hóa đơn hôm nay (cần `report.sales`); lô sắp hết hạn, sản phẩm dưới ngưỡng (cần `stock.read`) | Theo từng phần |
| GET | `/reports/revenue` | `from`, `to`, `groupBy=day\|month` | `report.sales` |
| GET | `/reports/top-selling` | `from`, `to`, `limit` | `report.sales` |
| GET | `/reports/stock-movement` | Xuất – nhập – tồn theo sản phẩm hoặc lô trong kỳ | `report.inventory` |
| GET | `/reports/expiry` | `withinDays=90`: lô còn tồn sắp hết hạn hoặc đã hết hạn | `report.inventory` |

Đã bỏ khỏi bản gốc: `/inventory/stock-report` (trùng `/reports/stock-movement`), `/reports/expiry-warning` (đổi tên thành `/reports/expiry`).

Quy tắc tính:

- Ngày theo `Asia/Ho_Chi_Minh`; khoảng `[from, to)`.
- Doanh thu = hóa đơn `COMPLETED` trong kỳ trừ tiền hoàn của phiếu trả **lập trong kỳ**. Hóa đơn `VOIDED` bị loại hoàn toàn. **[Đã chốt – P13]**
- Báo cáo xuất – nhập – tồn tính từ thẻ kho, nên luôn khớp với tồn thực tế của lô.

---

## 20. AI

| Method | Endpoint | Mô tả | Quyền | Giai đoạn |
|---|---|---|---|---|
| POST | `/ai/assistant/query` | Trợ lý tra cứu cho nhân viên: thuốc cùng hoạt chất, tồn, hạn dùng. Chỉ đọc dữ liệu qua các hàm truy vấn định sẵn | `ai.use` | Trong MVP nhưng làm sau cùng; bỏ nếu thiếu thời gian **[Đã chốt – P17]** |
| POST | `/prescriptions/{id}/scan` | OCR ảnh đơn (§12) | `prescription.create`, `ai.use` | Sau MVP |
| POST | `/ai/explanations` | Giải thích một cảnh báo của `/sales/safety-check` bằng lời dễ hiểu | `ai.use` | Sau MVP |
| GET | `/ai/inventory-forecast` | Đọc kết quả dự báo nhập hàng do job nền tính sẵn | `report.inventory` | Sau MVP |

Đã bỏ khỏi API v1: `POST /ai/chatbot` **[Đã chốt]**, `POST /ai/ocr-prescription` (gộp vào `/prescriptions/{id}/scan`), `POST /ai/drug-interaction-check` và `POST /ai/allergy-check` (thay bằng §13).

Nguyên tắc (giữ từ bản gốc, bổ sung):

- AI chỉ hỗ trợ; không tự quyết định bán thuốc, chẩn đoán, kê đơn hay thay thuốc.
- Không có endpoint AI nào ghi trực tiếp vào chứng từ, tồn kho hay trạng thái. Mọi kết quả chỉ trở thành dữ liệu sau khi người có permission xác nhận qua endpoint nghiệp vụ.
- Không gửi thông tin định danh khách hàng tới AI provider. **MVP không gửi ảnh đơn thuốc ra ngoài** vì chưa làm OCR. Khi làm OCR sau MVP: mặc định **che thông tin định danh trên ảnh trước khi gửi** (họ tên, địa chỉ, số điện thoại của bệnh nhân); nếu không che được thì phải có sự đồng ý của khách và ghi nhận lại. Quyết định này được xem lại ngay trước khi bắt đầu làm OCR. **[Đã chốt – P8]**
- Mọi lượt gọi ghi `ai_logs`: người dùng, tính năng, model và phiên bản, đầu vào đã lọc, kết quả, người xác nhận, có chấp nhận hay không. Chỉ người có `audit.read` được xem.
- Có giới hạn số lượt gọi theo người dùng và trần chi phí mỗi ngày. AI lỗi thì các nghiệp vụ bán hàng vẫn chạy bình thường.

---

## 21. Người dùng

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/users` | Danh sách, tìm kiếm | `user.manage` |
| GET | `/users/{id}` | Chi tiết | `user.manage` |
| POST | `/users` | Tạo tài khoản với mật khẩu tạm; bắt đổi ở lần đăng nhập đầu | `user.manage` |
| PATCH | `/users/{id}` | Sửa `fullName`, `phone`, `practiceCertificateNumber` (số chứng chỉ hành nghề) | `user.manage` |
| PUT | `/users/{id}/roles` | Thay toàn bộ vai trò; ghi audit | `user.manage` |
| POST | `/users/{id}/deactivate` | Vô hiệu hóa, thu hồi mọi phiên | `user.manage` |
| POST | `/users/{id}/activate` | Kích hoạt lại | `user.manage` |
| POST | `/users/{id}/reset-password` | Đặt mật khẩu tạm, thu hồi mọi phiên | `user.manage` |
| GET | `/roles` | Danh sách vai trò và permission của từng vai trò | `user.manage` |

- Không ai tự đổi vai trò của chính mình. Không vô hiệu hóa hoặc gỡ vai trò của admin cuối cùng (`422`).
- `PATCH /users/{id}` không nhận `roles`, `password`, `isActive`; các trường này có endpoint riêng.

---

## 22. Phạm vi MVP

**Trong MVP**

| Nhóm | Mục |
|---|---|
| Nền tảng | Xác thực, người dùng, permission (§3, §4, §21); audit log (§18) |
| Danh mục | Nhóm, sản phẩm, đơn vị quy đổi, hoạt chất, giá và VAT, giảm giá, nhà cung cấp (§6, §7) |
| Kho | Lô và trạng thái lô (§8); phiếu nhập (§9); tồn, thẻ kho, điều chỉnh, tồn đầu kỳ (§10) |
| Bán hàng | Kiểm tra an toàn tất định (§13); hóa đơn, hủy hóa đơn, in K80 (§14); trả hàng (§15) |
| Đơn thuốc, khách hàng | Đơn thuốc nhập tay và bước verify (§12, trừ OCR); khách hàng và hồ sơ sức khỏe (§11) |
| GPP | Thu hồi (§16); sổ nhiệt độ – độ ẩm (§17) |
| Báo cáo | Dashboard, doanh thu, bán chạy, xuất – nhập – tồn, hạn dùng (§19) |

Quy tắc MVP: chưa có sổ theo dõi thuốc kiểm soát đặc biệt thì hệ thống **chặn bán** sản phẩm `drugClass = CONTROLLED`.

**Sau MVP**

- Đơn đặt hàng nhà cung cấp, trả hàng nhà cung cấp, công nợ nhà cung cấp.
- Danh mục bác sĩ; OCR đơn thuốc; AI giải thích cảnh báo; dự báo nhập hàng.
- Kiểm kê theo đợt; ngăn biệt trữ theo số lượng; sổ thuốc kiểm soát đặc biệt.
- Hóa đơn điện tử, tích hợp cổng thanh toán, liên thông dữ liệu dược với cơ quan quản lý.
- MFA; nhiều cửa hàng.

---

## 23. Nhật ký quyết định

Toàn bộ P1–P17 được nhóm xác nhận ngày **12/09/2026**. Bảng dưới giữ lại để tra ngược: mỗi dòng là một quyết định, kèm mã phát hiện trong báo cáo review và mục đã áp dụng trong tài liệu này.

| Mã | Quyết định đã chốt | Review | Mục |
|---|---|---|---|
| P1 | Access token 15 phút trong bộ nhớ; refresh token trong cookie `HttpOnly`, hết hạn sau 7 ngày không hoạt động, xoay vòng có phát hiện dùng lại | H6 | §3 |
| P2 | Trường `version` cho khóa lạc quan; whitelist trường cho mỗi `PATCH` | M9 | §2.5 |
| P3 | Bỏ `POST /batches`; lô chỉ sinh từ phiếu nhập hoặc tồn đầu kỳ; sửa thông tin lô qua `/corrections` | H4 | §8, §10.4 |
| P4 | Điều chỉnh áp dụng chênh lệch; người duyệt khác người lập | H5 | §5.5, §10.3 |
| P5 | Ma trận vai trò → permission như §4.2 | H1 | §4.2 |
| P6 | Hàng trả chọn `RESTOCK` hoặc `DISPOSE`; thời hạn nhận trả; có nhận trả thuốc kê đơn không | H3 | §15 |
| P7 | `POST /sales/safety-check` tất định; nguồn dữ liệu tương tác thuốc; phạm vi kiểm tra trong MVP | H8 | §13 |
| P8 | Permission `customer.sensitive`; ghi nhận đồng ý của khách; chính sách lưu trữ, ẩn danh; cách xử lý ảnh đơn khi OCR | H7 | §11, §20 |
| P9 | Giá niêm yết đã gồm VAT; VAT tách ngược, làm tròn theo từng dòng | M5 | §6.5 |
| P10 | Hạn mức giảm giá theo vai trò | M5 | §6.6 |
| P11 | Hạn dùng chỉ có tháng/năm lưu ngày cuối tháng; số ngày hạn dùng tối thiểu còn lại khi bán | M4 | §2.1, §5.1 |
| P12 | Thời hạn được hủy hóa đơn (đề xuất: trong ngày bán) | M2 | §5.3, §14.4 |
| P13 | Doanh thu trừ tiền hoàn theo ngày lập phiếu trả; loại hóa đơn đã hủy | – | §19 |
| P14 | Vai trò được bán thuốc kê đơn; cách tính hiệu lực đơn thuốc (đối chiếu quy định kê đơn hiện hành) | H2 | §4.2, §5.4 |
| P15 | Danh mục bác sĩ để sau MVP | – | §12 |
| P16 | Ngưỡng nhiệt độ – độ ẩm theo khu vực (đối chiếu GPP hiện hành) | – | §17 |
| P17 | Có đưa trợ lý tra cứu AI (chỉ đọc) vào MVP không | – | §20 |

---

## 24. Bước tiếp theo

**Ba giá trị mặc định cần đối chiếu văn bản pháp lý trước khi vận hành thật:** số ngày hạn dùng tối thiểu khi bán (P11), thời hạn hiệu lực của đơn thuốc và vai trò được bán thuốc kê đơn (P14), ngưỡng nhiệt độ – độ ẩm (P16). Phần mềm chạy được với giá trị mặc định, nhưng nhóm phải xác nhận lại theo văn bản đang có hiệu lực.

1. **Thiết kế ERD PostgreSQL** theo contract này: bảng, khóa, ràng buộc (tồn không âm, số lô duy nhất theo sản phẩm, dòng thẻ kho duy nhất theo chứng từ nguồn), chỉ mục phục vụ chọn lô FEFO.
2. **Viết kiểm thử** cho các bảng trạng thái ở §5 và các kịch bản đồng thời: confirm một phiếu hai lần, hai quầy bán cùng một lô, hai phiếu trả song song cho cùng một dòng, duyệt điều chỉnh trong lúc đang bán.
3. **Dựng khung dự án và CSDL local**, rồi mới viết endpoint theo thứ tự: danh mục, đơn vị, giá → phiếu nhập → bán hàng → trả hàng, hủy hóa đơn → thu hồi.
4. **Commit thư mục `docs/`** — hiện Git vẫn chưa theo dõi thư mục này.
