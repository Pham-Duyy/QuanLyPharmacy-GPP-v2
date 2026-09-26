# API Contract – Phần mềm quản lý nhà thuốc GPP

| Mục | Giá trị |
|---|---|
| Phiên bản tài liệu | 2.2 |
| Phiên bản API | `/api/v1` |
| Ngày cập nhật | 12/09/2026 |
| Trạng thái | Toàn bộ quyết định đã chốt; ERD ở `docs/erd.md` |
| Thay đổi ở 2.2 | Thiết kế cho **chuỗi nhiều nhà thuốc**: header `X-Store-Id`, tài nguyên `/stores`, vai trò gán theo cửa hàng (§2.8) |
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
| Thiết kế cho chuỗi nhiều nhà thuốc: `X-Store-Id`, `/stores`, vai trò theo cửa hàng | – | Đã chốt – P18 (12/09/2026) |

---

## 1. Bối cảnh và quyết định nền

- Frontend: React + Vite. Backend: Node.js + Express. **CSDL: PostgreSQL [Đã chốt]**.
- API trao đổi JSON; upload tệp dùng `multipart/form-data`.
- Phạm vi: **chuỗi nhà thuốc bán lẻ** theo GPP. MVP vận hành một cửa hàng, nhưng dữ liệu và API đã có phạm vi cửa hàng ngay từ đầu (§2.8).
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
| Phạm vi cửa hàng | Header `X-Store-Id` bắt buộc với endpoint thuộc phạm vi cửa hàng (§2.8). |

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
- Máy chủ lưu khóa theo (khóa, người dùng, method + path, **cửa hàng**, hash nội dung, chứng từ đã ghi, response) trong 24 giờ.
  - Cùng khóa, cùng nội dung, đã xong: trả lại đúng response đã lưu.
  - Cùng khóa, khác nội dung **hoặc khác cửa hàng**: `422 IDEMPOTENCY_KEY_REUSED`.
  - Request trước với cùng khóa đang xử lý: `409 REQUEST_IN_PROGRESS`.
  - Thiếu header: `400 IDEMPOTENCY_KEY_REQUIRED`.
- **Khóa gắn với chứng từ trong cùng transaction nghiệp vụ.** Service ghi
  `resource_type`/`resource_id` vào chính khóa đó ngay trong transaction tạo
  chứng từ. Vì vậy:
  - Transaction rollback → bản ghi gắn kết cũng mất → khóa được dọn, client gửi
    lại bình thường.
  - Transaction đã commit nhưng dựng response lỗi → khóa **không bị xóa**; lần
    gửi lại nhận `409 REQUEST_ALREADY_COMMITTED` kèm `details[0]` gồm
    `resourceType` và `resourceId` để máy khách mở đúng chứng từ đã ghi, thay
    vì tạo bản thứ hai.
  - Khóa treo ở IN_PROGRESS quá 24 giờ mà chưa gắn chứng từ nào (tiến trình
    chết giữa chừng) thì lần gửi lại được tiếp quản và xử lý lại.
- **Tiếp quản là một lệnh so sánh rồi đổi** trên `(id, owner_token)`, không
  phải "xóa rồi tạo lại". Hai request cùng thấy một khóa treo thì chỉ một
  request đổi được chủ; request còn lại nhận `409 REQUEST_IN_PROGRESS`.
- Mọi lệnh ghi lên khóa (gắn chứng từ, lưu response, dọn khóa khi lỗi) đều kèm
  `owner_token` **và trạng thái `IN_PROGRESS`**, nên request đã mất quyền sở
  hữu không thể xóa hay ghi đè khóa của request đang chạy, cũng không ghi được
  vào khóa đã hoàn tất. Khóa đã gắn chứng từ thì không bao giờ bị tiếp quản.
- Gắn chứng từ vào khóa **bắt buộc phải ghi được đúng một dòng**. Không ghi
  được (khóa đã đổi chủ hoặc đã kết thúc) thì service ném
  `409 IDEMPOTENCY_OWNERSHIP_LOST` **ngay trong transaction**, nên toàn bộ
  thay đổi nghiệp vụ bị hủy. Nếu chỉ bỏ qua, request cũ vẫn commit chứng từ
  trong khi khóa đã thuộc về request khác — và lần gửi lại sẽ tạo chứng từ
  thứ hai.

### 2.3b Thứ tự khóa hàng khi đổi trạng thái [Đã chốt]

Mọi luồng đổi trạng thái phải **khóa chứng từ gốc trước khi đọc trạng thái**
(`SELECT ... FOR UPDATE`, xem `src/lib/locks.ts`), và luôn theo cùng một
thứ tự để không khóa chéo nhau:

> chứng từ gốc (hóa đơn, phiếu) → khách hàng → đơn thuốc → lô hàng

Hệ quả bắt buộc:

- Hủy hóa đơn và nhận trả hàng cho cùng một hóa đơn không thể chạy song song;
  chỉ một nghiệp vụ hoàn tất, tồn kho và tiền chỉ được hoàn đúng một lần.
- Hóa đơn đã có phiếu trả thì không hủy được; hóa đơn đã hủy thì không nhận
  trả hàng.
- Mọi thay đổi số dư điểm của cùng một khách (đổi, hoàn, điều chỉnh tay) đều
  đi qua khóa hồ sơ khách.
- Thanh toán công nợ và trả hàng trừ công nợ đều khóa các phiếu nhập liên quan
  theo thứ tự id trước khi tính lại số còn nợ.

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
| 400 | Request sai cú pháp, thiếu header bắt buộc | `BAD_REQUEST`, `IDEMPOTENCY_KEY_REQUIRED`, `STORE_REQUIRED` |
| 401 | Chưa đăng nhập, token hết hạn hoặc bị thu hồi | `UNAUTHENTICATED`, `TOKEN_EXPIRED` |
| 403 | Thiếu permission, hoặc không có quyền tại cửa hàng được chỉ định | `FORBIDDEN`, `STORE_FORBIDDEN` |
| 404 | Không tìm thấy tài nguyên | `NOT_FOUND` |
| 409 | Xung đột trạng thái, phiên bản hoặc tồn kho | `INVALID_STATE`, `VERSION_CONFLICT`, `INSUFFICIENT_STOCK`, `REQUEST_IN_PROGRESS`, `REQUEST_ALREADY_COMMITTED`, `IDEMPOTENCY_OWNERSHIP_LOST`, `BATCH_EXPIRY_MISMATCH`, `LOYALTY_DISABLED` |
| 422 | Dữ liệu đúng cú pháp nhưng vi phạm validation hoặc quy tắc nghiệp vụ | `VALIDATION_ERROR`, `UNIT_NOT_IN_PRODUCT`, `PRICE_NOT_SET`, `BATCH_NOT_SELLABLE`, `CONTROLLED_DRUG_NOT_SUPPORTED`, `PRESCRIPTION_REQUIRED`, `PRESCRIPTION_NOT_VERIFIED`, `PRESCRIPTION_EXPIRED`, `PRESCRIBED_QUANTITY_EXCEEDED`, `SAFETY_ACK_REQUIRED`, `DISCOUNT_LIMIT_EXCEEDED`, `RETURN_QUANTITY_EXCEEDED`, `RETURN_WINDOW_EXPIRED`, `RETURN_NOT_ALLOWED_FOR_RX`, `SELF_APPROVAL_NOT_ALLOWED`, `IDEMPOTENCY_KEY_REUSED` |
| 429 | Vượt giới hạn request | `RATE_LIMITED` |
| 500 | Lỗi không mong muốn | `INTERNAL_ERROR` |

### 2.8 Phạm vi cửa hàng [Đã chốt – P18]

Hệ thống thiết kế cho chuỗi nhiều nhà thuốc. MVP mở một cửa hàng, nhưng mọi dữ liệu kho và bán hàng đều gắn với một `storeId` ngay từ đầu.

- Endpoint **thuộc phạm vi cửa hàng** phải gửi header `X-Store-Id`. Backend kiểm tra người dùng có vai trò tại cửa hàng đó, hoặc có vai trò toàn chuỗi, rồi mới xử lý. Thiếu header trả `400 STORE_REQUIRED`; không có quyền tại cửa hàng đó trả `403 STORE_FORBIDDEN`.
- **Theo cửa hàng:** lô và tồn kho, thẻ kho, phiếu nhập, tồn đầu kỳ, điều chỉnh, kiểm tra an toàn, hóa đơn, trả hàng, sổ nhiệt độ – độ ẩm, dashboard và báo cáo.
- **Toàn chuỗi, không cần header:** danh mục sản phẩm, đơn vị, hoạt chất, nhà cung cấp, khách hàng và hồ sơ sức khỏe, đơn thuốc, thu hồi, người dùng, vai trò, audit log.
- Truy cập một bản ghi thuộc cửa hàng khác luôn trả `404 NOT_FOUND`, không trả `403`, để không lộ việc bản ghi đó có tồn tại hay không.
- **Giá bán:** bảng giá dùng chung toàn chuỗi, cho phép đặt giá riêng cho từng cửa hàng. Khi bán, backend lấy giá riêng của cửa hàng trước, không có thì dùng giá chung.
- **Khách hàng dùng chung toàn chuỗi:** mua ở cửa hàng nào cũng tra được lịch sử và hồ sơ dị ứng. Đơn thuốc lưu cửa hàng tiếp nhận nhưng bán được ở cửa hàng khác trong chuỗi.
- **Trả hàng chỉ nhận tại cửa hàng đã bán**, vì lô nằm trong kho của cửa hàng đó.
- **Báo cáo:** mặc định theo cửa hàng trong header. Muốn xem hợp nhất toàn chuỗi thì gửi `?storeId=ALL` và cần permission `report.chain`.
- Số chứng từ có tiền tố mã cửa hàng, ví dụ `HD-NT01-20260912-0001`.

---

## 3. Xác thực và phiên

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| POST | `/auth/login` | Đăng nhập; trả `accessToken` trong body và đặt refresh token | Public, có giới hạn |
| POST | `/auth/refresh` | Cấp access token mới, xoay vòng refresh token | Public (cần refresh token) |
| POST | `/auth/logout` | Thu hồi phiên hiện tại | Đã đăng nhập |
| GET | `/auth/me` | Người dùng hiện tại; danh sách cửa hàng được phép kèm permission tại từng cửa hàng; cửa hàng mặc định | Đã đăng nhập |
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
| `store.manage` | Tạo, sửa, ngừng hoạt động cửa hàng trong chuỗi |
| `user.manage` | Quản lý tài khoản, vai trò |
| `settings.manage` | Sửa cài đặt cửa hàng, gồm mẫu in hóa đơn |
| `report.chain` | Xem báo cáo hợp nhất toàn chuỗi (`?storeId=ALL`) |
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
| `backup.manage` | Xem, chạy và tải bản sao lưu dữ liệu |
| `controlled.read` | Xem sổ theo dõi thuốc kiểm soát đặc biệt |
| `supplier_debt.read` | Xem công nợ nhà cung cấp |
| `supplier_payment.manage` | Ghi nhận thanh toán cho nhà cung cấp |
| `loyalty.manage` | Điều chỉnh điểm tích lũy của khách bằng tay |
| `ai.use` | Dùng tính năng AI |

### 4.2 Ma trận vai trò → permission [Đã chốt – P5]

| Permission | admin | pharmacist | sales_staff | warehouse_staff | auditor |
|---|:-:|:-:|:-:|:-:|:-:|
| `store.manage` | ✓ | | | | |
| `user.manage` | ✓ | | | | |
| `settings.manage` | ✓ | | | | |
| `report.chain` | ✓ | | | | ✓ |
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
| `backup.manage` | ✓ | | | | |
| `controlled.read` | ✓ | ✓ | | | ✓ |
| `supplier_debt.read` | ✓ | | | | ✓ |
| `supplier_payment.manage` | ✓ | | | | |
| `loyalty.manage` | ✓ | ✓ | | | |
| `ai.use` | | ✓ | ✓ | | |

Ghi chú:

- `sale.prescription_drug` chỉ gán cho vai trò `pharmacist` như ma trận trên. Nếu có nhân viên khác đủ điều kiện theo quy định, admin gán thêm vai trò `pharmacist` cho người đó, không gán lẻ permission ra ngoài ma trận. **[Đã chốt – P14]**
- Chủ nhà thuốc đồng thời là dược sĩ thì giữ cả `admin` và `pharmacist`.
- `auditor` chỉ có quyền đọc.
- **Vai trò gán theo cửa hàng.** Mỗi lần gán gồm `roleCode` và `storeId`; `storeId = null` nghĩa là vai trò áp dụng cho toàn chuỗi. Ví dụ: chủ chuỗi giữ `admin` toàn chuỗi, còn dược sĩ phụ trách cửa hàng NT01 giữ `pharmacist` tại đúng cửa hàng đó. Backend kiểm tra permission **trong phạm vi cửa hàng của request** (§2.8). **[Đã chốt – P18]**

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
| GET | `/products` | Lọc `categoryId`, `productType`, `drugClass` (nhiều giá trị cách nhau dấu phẩy, ví dụ `RX,CONTROLLED`), `isActive`; tìm theo tên, hoạt chất, mã, mã vạch. Mỗi dòng có `defaultUnit`, `baseUnit`, `currentPrice`, `stock` (theo `X-Store-Id`; đã chọn cửa hàng mà chưa có lô thì là 0, không chọn cửa hàng thì `null`), `isBelowMinStock` (tồn bán được < tồn tối thiểu), `primaryImage`, `saleUnits` (đơn vị bán được kèm giá hiện hành, `salePrice: null` là chưa đặt giá). `inStock=true` chỉ lấy sản phẩm còn tồn bán được tại cửa hàng đang chọn | `catalog.read` |
| GET | `/products/{id}` | Chi tiết, đơn vị, giá hiện hành, tồn tổng hợp, `images` (ảnh chính đứng đầu) | `catalog.read` |
| POST | `/products` | Tạo sản phẩm kèm đơn vị cơ bản | `catalog.manage` |
| PATCH | `/products/{id}` | Sửa (whitelist trường, có `version`) | `catalog.manage` |
| POST | `/products/{id}/deactivate` | Ngừng kinh doanh; không xóa vật lý | `catalog.manage` |
| POST | `/products/{id}/activate` | Kinh doanh lại | `catalog.manage` |
| GET | `/products/{id}/batches` | Các lô của sản phẩm | `stock.read` |
| POST | `/products/{id}/images` | Tải ảnh, `multipart/form-data`: `file` (bắt buộc, ≤ 5 MB) và `thumb` (tùy chọn, ≤ 512 KB). Chỉ PNG/JPEG theo nội dung byte, xóa EXIF; tối đa 8 ảnh; ảnh đầu tiên là ảnh chính | `catalog.manage` |
| POST | `/products/{id}/images/{imageId}/primary` | Đặt ảnh chính | `catalog.manage` |
| DELETE | `/products/{id}/images/{imageId}` | Gỡ ảnh; gỡ ảnh chính thì ảnh kế tiếp thành ảnh chính | `catalog.manage` |
| GET | `/product-images/{imageId}?v=full\|thumb&expires&sig` | Đọc ảnh qua URL có chữ ký (server trả sẵn trong `url`/`thumbUrl`), không cần đăng nhập; hạn làm tròn theo giờ để trình duyệt cache được | Chữ ký hợp lệ |

Ảnh sản phẩm lưu trong `storage/products` ngoài thư mục public, metadata ở bảng `product_images` (mỗi sản phẩm tối đa một ảnh chính, chỉ mục duy nhất từng phần). Mọi thao tác ảnh ghi audit và không đụng tới tồn kho hay `version` của sản phẩm.

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

**Tìm kiếm và phân trang danh mục:** điều kiện lọc (gồm tìm không dấu theo
tên, mã, hoạt chất, mã vạch) được dựng một lần rồi dùng cho cả câu đếm lẫn câu
lấy trang. Tổng số kết quả vì vậy luôn đúng, không bị chặn ở một mức trần và
không phụ thuộc vào việc trang đang xem có dòng nào — trang vượt quá số kết quả
trả về danh sách rỗng nhưng vẫn kèm tổng số thật.

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
| GET | `/goods-receipts` | Lọc `supplierId`, `status`, `from`, `to`, `search` (mã phiếu, tên nhà cung cấp, số hóa đơn NCC); sắp xếp `receivedAt`, `createdAt`, `code`, `totalCost` | `goods_receipt.read` |
| GET | `/goods-receipts/summary` | Số phiếu nháp đang chờ; số phiếu và giá trị đã kiểm nhập trong tháng hiện tại (giờ Việt Nam, theo ngày nhận hàng) kèm % so với tháng trước (`null` khi tháng trước bằng 0) | `goods_receipt.read` |
| GET | `/goods-receipts/{id}` | Chi tiết, các dòng, lô đã tạo hoặc liên kết kèm trạng thái hiện tại của lô; liên hệ nhà cung cấp; người lập, người xác nhận, người hủy | `goods_receipt.read` |
| POST | `/goods-receipts` | Tạo phiếu `DRAFT`; cần `Idempotency-Key` | `goods_receipt.create` |
| PATCH | `/goods-receipts/{id}` | Sửa khi còn `DRAFT`; cần `version` | `goods_receipt.create` |
| POST | `/goods-receipts/{id}/confirm` | Kiểm nhập và xác nhận; cần `Idempotency-Key` | `goods_receipt.confirm` |
| POST | `/goods-receipts/{id}/cancel` | Hủy phiếu `DRAFT`; bắt buộc `reason` | `goods_receipt.confirm` |
| GET | `/goods-receipts/{id}/print` | HTML phiếu nhập kho theo mẫu in của cửa hàng (xem §21 Cài đặt – Mẫu in phiếu) | `goods_receipt.read` |

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

### Giá vốn: bình quân gia quyền theo lô [Đã chốt]

- Giá vốn của một lô = trung bình có trọng số theo số lượng của các lần nhập
  vào lô đó: `(tồn_cũ × giá_vốn_cũ + số_nhập × giá_nhập_đợt_này) / (tồn_cũ + số_nhập)`.
  Giá nhập của mỗi đợt đã gánh phần chiết khấu và thuế của cả phiếu theo tỷ lệ
  thành tiền (mục ngay dưới). Mọi phép tính tiền giữ ở kiểu số thập phân chính
  xác, không đi qua số thực dấu phẩy động.
- Phép cộng hàng vào lô **nằm trong đúng một câu lệnh UPDATE**: tồn và giá vốn
  dùng để tính bình quân được đọc dưới khóa hàng của chính lệnh đó. Hai phiếu
  nhập cùng một lô (hoặc nhập trong lúc đang bán) vì thế xếp hàng và mỗi lệnh
  tính trên số liệu mới nhất. Hai phiếu cùng tạo một lô chưa tồn tại thì chỉ
  một phiếu tạo được lô, phiếu còn lại chuyển sang nhánh nhập thêm.
- Phiếu có nhiều lô xử lý các dòng theo thứ tự cố định (sản phẩm, số lô) để
  hai phiếu chồng lô không khóa chéo nhau.
- Nhập thêm vào lô đã bán hết (tồn 0) thì lấy thẳng giá của đợt mới.
- **Mỗi lần xuất bán chụp lại giá vốn của lô vào `invoice_allocations.unit_cost`.**
  Báo cáo lãi gộp dùng giá vốn đã chụp này, nên nhập thêm cùng lô với giá khác
  về sau không làm đổi số liệu của kỳ đã chốt.
- **Hàng quay lại kho hoàn cả số lượng lẫn giá trị**: khách trả hàng để bán lại
  (RESTOCK) hoặc hủy hóa đơn thì hàng nhập lại lô với **đúng giá vốn của lần
  bán gốc**, rồi lô tính lại bình quân gia quyền. Chỉ cộng số lượng mà không
  cộng giá trị sẽ làm sai giá vốn bình quân ngay khi lô đã nhập thêm giá khác.
- Hàng trả để **tiêu hủy** (DISPOSE) vào rồi ra ngay trong cùng giao dịch: giữ
  nguyên giá vốn bình quân, nhờ vậy giá trị hàng **còn tồn** không đổi.
- Không khôi phục được giá vốn của lần bán (dữ liệu cũ) thì khi hoàn hàng giữ
  nguyên giá vốn bình quân của lô — không suy diễn một con số không có thật.

#### Giá vốn của dữ liệu cũ [Đã chốt]

`invoice_allocations.unit_cost_source` nói rõ giá vốn của từng dòng xuất đáng
tin tới đâu:

| Giá trị | Nghĩa |
|---|---|
| `ACTUAL` | Chụp đúng tại thời điểm xuất hàng. Lãi gộp là số chính xác. |
| `ESTIMATED` | Dòng cũ hơn bản nâng cấp `20260926140000`: lấy **một lần** giá vốn của lô tại thời điểm nâng cấp rồi đóng băng. Là ước tính. |
| `UNKNOWN` | Không khôi phục được (lô không có giá vốn). Giá vốn để rỗng, tính là 0 khi cộng tổng. |

Báo cáo **không bao giờ** lùi về `batches.unit_cost` cho dữ liệu cũ: giá vốn
của lô thay đổi mỗi lần nhập thêm, lấy nó làm dự phòng thì lãi gộp của kỳ đã
chốt sẽ nhảy theo từng đợt nhập hàng mới.

### Chiết khấu phiếu và thuế theo hóa đơn

- `POST`/`PATCH /goods-receipts` nhận thêm `discountAmount` và `vatAmount` (số nguyên đồng, ≥ 0, mặc định 0).
- Phiếu lưu `goodsAmount` (tổng thành tiền các dòng), `discountAmount`, `vatAmount` và `totalCost = goodsAmount − discountAmount + vatAmount`. Chiết khấu vượt tiền hàng → `422 VALIDATION_ERROR`.
- Khi confirm, giá vốn lô mới = thành tiền dòng × `totalCost / goodsAmount` ÷ số lượng quy đổi: chiết khấu và thuế phân bổ theo tỷ lệ giá trị từng dòng (nhà thuốc không khấu trừ thuế nên thuế tính vào giá vốn).

### Kiểm nhập cảm quan khi confirm [Đã chốt]

Thực hành GPP yêu cầu người xác nhận (dược sĩ phụ trách) kiểm tra hạn dùng, bao bì và chất lượng cảm quan **trước khi** hàng được coi là bán được — không chỉ là trách nhiệm ngầm định. Vì vậy `POST /goods-receipts/{id}/confirm` bắt buộc gửi kèm kết quả kiểm nhập từng dòng:

```json
{
  "lines": [
    { "lineId": "grl_01", "passed": true },
    { "lineId": "grl_02", "passed": false, "rejectReason": "Bao bì móp méo, nghi ngờ chất lượng" }
  ]
}
```

- Phải có đúng một kết quả cho mỗi dòng của phiếu, không thiếu không thừa; thiếu dòng nào thì trả `422 VALIDATION_ERROR` và **không tạo lô nào cả** (dừng trước khi đụng vào kho).
- `passed: false` bắt buộc có `rejectReason`.

Trong một transaction:

1. Chuyển `DRAFT` → `CONFIRMED` có điều kiện (§2.4).
2. Với từng dòng, tìm lô theo (`productId`, `batchNumber`):
   - Chưa có: tạo lô mới — `AVAILABLE` nếu `passed`, `QUARANTINED` (kèm `note` = `rejectReason`) nếu không.
   - Đã có, khác `expiryDate`: dừng, trả `409 BATCH_EXPIRY_MISMATCH`.
   - Đã có, trạng thái `RECALLED`: dừng, trả `422 BATCH_NOT_SELLABLE`.
   - Đã có, dòng này `passed: false`: cả lô chuyển `QUARANTINED` — cùng số lô sản xuất nên vấn đề chất lượng coi như ảnh hưởng toàn bộ, không tách riêng phần mới nhập. Lô đã biệt trữ từ trước thì giữ nguyên dù dòng này đạt, không tự mở lại.
3. Cộng tồn và ghi một dòng thẻ kho loại `RECEIPT` cho mỗi dòng phiếu (kể cả dòng không đạt — hàng đã thực sự về kho, chỉ là chưa bán được).
4. Dòng không đạt thì ghi thêm audit log `GOODS_RECEIPT_LINE_REJECTED`.
5. Bất kỳ bước nào lỗi thì rollback toàn bộ.

Không có khoảnh khắc nào hàng chưa qua kiểm nhập ở trạng thái bán được — khác với việc xác nhận trước rồi mới biệt trữ sau qua endpoint riêng ở §8.

### 9.1 Công nợ nhà cung cấp

Mỗi phiếu nhập **đã kiểm nhập** là một khoản phải trả. Hạn trả chốt ngay lúc kiểm nhập theo kỳ hạn đang áp dụng của nhà cung cấp (`suppliers.payment_term_days`, mặc định 0 = trả ngay), lưu ở `goods_receipts.payment_due_date` nên đổi kỳ hạn về sau không làm đổi hạn của công nợ cũ.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/supplier-debts?supplierId&onlyOutstanding&dueSoonDays` | Nợ theo từng nhà cung cấp kèm danh sách phiếu còn nợ | `supplier_debt.read` |
| PUT | `/supplier-debts/{supplierId}/term` | Đổi kỳ hạn thanh toán; ghi audit `SUPPLIER_TERM_UPDATE` | `supplier_payment.manage` |
| GET | `/supplier-payments?supplierId&from&to` | Lịch sử phiếu chi | `supplier_debt.read` |
| POST | `/supplier-payments` | Ghi nhận trả tiền; ghi audit `SUPPLIER_PAYMENT_CREATE` | `supplier_payment.manage` |
| POST | `/supplier-payments/{id}/void` | Hủy phiếu chi, bắt buộc `reason`; ghi audit `SUPPLIER_PAYMENT_VOID` | `supplier_payment.manage` |

Quy tắc:

- Một phiếu chi trả cho **nhiều phiếu nhập**: `allocations[{ goodsReceiptId, amount }]`, số tiền phiếu chi bằng tổng phân bổ.
- Mỗi phần phân bổ **không vượt quá số còn nợ** của phiếu nhập đó, tính lại ngay trong giao dịch nên hai người cùng ghi không làm trả dư.
- Chỉ trả được cho phiếu **đã kiểm nhập** và đúng nhà cung cấp đó.
- Phiếu chi ghi nhầm thì **hủy có lý do**, không xóa: công nợ được tính lại, phiếu vẫn nằm trong lịch sử để đối chiếu sổ sách.
- `summary` gồm `outstanding`, `overdueAmount` (quá hạn), `dueSoonAmount` (đến hạn trong `dueSoonDays`, mặc định 7 ngày).
- Ở mức nhà cung cấp, `totalCost` và `paidAmount` tính trên chính các phiếu đang liệt kê (mặc định chỉ phiếu còn nợ), không phải tổng lũy kế từ trước tới nay.

### 9.2 Trả hàng nhà cung cấp

Hàng cận hạn được nhà cung cấp nhận lại, hàng lỗi, hàng thu hồi hoặc giao sai. Lập nháp rồi mới xác nhận — **chỉ khi xác nhận mới trừ tồn và ghi thẻ kho**, vì lúc đó hàng mới thật sự rời khỏi kho.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/supplier-returns/returnable?supplierId&search` | Lô còn tồn kèm nhà cung cấp đã mang lô đó về | `goods_receipt.read` |
| GET | `/supplier-returns?status&supplierId` | Danh sách phiếu trả | `goods_receipt.read` |
| GET | `/supplier-returns/{id}` | Chi tiết phiếu trả | `goods_receipt.read` |
| POST | `/supplier-returns` | Lập phiếu nháp: `supplierId`, `reason` (bắt buộc), `settlement`, `lines[{ batchId, unitId, quantity }]` | `goods_receipt.create` |
| POST | `/supplier-returns/{id}/confirm` | Xác nhận: trừ tồn, ghi thẻ kho `SUPPLIER_RETURN`; ghi audit `SUPPLIER_RETURN_CONFIRM` | `goods_receipt.confirm` |
| POST | `/supplier-returns/{id}/cancel` | Hủy phiếu **còn nháp**, bắt buộc `reason` | `goods_receipt.create` |

Quy tắc:

- `settlement`: `DEDUCT_DEBT` trừ vào công nợ (mặc định) · `REFUND` nhận lại tiền · `REPLACEMENT` đổi hàng. **Chỉ `DEDUCT_DEBT` tác động công nợ** (§9.1): giá trị dòng trả được trừ vào chính phiếu nhập đã mang lô đó về.
- Giá trị dòng tính theo **giá vốn của lô**, không phải giá bán.
- Mỗi dòng gắn với phiếu nhập gốc (tìm theo lô), để trừ đúng khoản nợ.
- Số lượng không vượt quá tồn của lô; kiểm tra lại lúc xác nhận vì từ khi lập nháp có thể đã bán bớt (`409 INSUFFICIENT_STOCK`).
- Phiếu đã xác nhận **không hủy được**; nhà cung cấp trả hàng lại thì lập phiếu nhập mới.

---

## 10. Tồn kho

### 10.1 Tồn tổng hợp

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/inventory` | Tồn theo sản phẩm; lọc `productId`, `categoryId`, `belowMinStock=true`, `search` (tên không phân biệt dấu hoặc mã) | `stock.read` |

Mỗi sản phẩm trả về số lượng theo đơn vị nhỏ nhất, tách thành: bán được, biệt trữ, bị thu hồi, đã hết hạn.

### 10.2 Thẻ kho [Đã chốt]

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/inventory/transactions` | Lọc `batchId`, `productId`, `type`, `from`, `to`; phân trang con trỏ | `stock.read` |

| Trường | Ghi chú |
|---|---|
| `id`, `occurredAt` | |
| `type` | `RECEIPT`, `OPENING_BALANCE`, `SALE`, `SALE_VOID`, `CUSTOMER_RETURN`, `ADJUSTMENT`, `DISPOSAL`, `SUPPLIER_RETURN` |
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

### 10.5 Đề xuất đặt hàng

Trả lời câu hỏi "hôm nay cần gọi hàng gì, bao nhiêu". Chỉ tính toán và trả kết quả, **không tạo chứng từ nào**.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/purchase-suggestions?windowDays&coverDays&leadTimeDays&onlyNeeded&categoryId&search` | `{ items, summary, settings }` | `stock.read` |

Cách tính cho từng mặt hàng đang kinh doanh:

- `avgDailyBaseQuantity` = số lượng bán trong `windowDays` ngày gần nhất (mặc định 30, chỉ hóa đơn hoàn tất) chia cho số ngày.
- `targetBaseQuantity` = max(tốc độ bán × (`coverDays` + `leadTimeDays`), tồn tối thiểu của mặt hàng).
- Số cần đặt = mục tiêu − tồn bán được − **hàng đã lập phiếu nhập nhưng chưa kiểm nhập**, rồi làm tròn lên theo đơn vị đặt.
- Đơn vị đặt lấy theo đơn vị của lần nhập gần nhất; chưa từng nhập thì lấy đơn vị lớn nhất.
- `lastSupplier`, `lastUnitCost` lấy từ phiếu nhập **đã kiểm nhập** gần nhất của chính mặt hàng đó.
- `reason`: `OUT_OF_STOCK` hết hàng · `BELOW_MIN` dưới tồn tối thiểu · `RUNNING_OUT` hết trước khi hàng kịp về · `REFILL` cần bổ sung cho kỳ tới · `OK` đang đủ hàng.

Giao diện cho sửa số lượng trước khi đặt, xuất đơn đặt hàng ra Excel (`purchase-order`, xếp theo nhà cung cấp) và đổ các dòng đã chọn vào phiếu nhập nháp. Số lô và hạn dùng để trống vì lúc gọi hàng chưa biết — người kiểm nhập điền khi hàng về.

### 10.6 Hàng cận hạn và kế hoạch xử lý

Hàng cận hạn là tiền đang treo: không xử lý kịp thì tới hạn phải hủy. Vì vậy danh sách không chỉ đếm lô mà quy ra giá trị tồn, và mỗi lô có một kế hoạch xử lý có người chịu trách nhiệm cùng ngày hẹn.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/expiry-alerts?horizonDays&bucket&onlyWithoutPlan` | `{ items, summary }`; mặc định 90 ngày | `stock.read` |
| POST | `/expiry-alerts/plans` | Lập hoặc sửa kế hoạch: `batchId`, `action`, `dueDate`, `note` | `stock.adjust.create` |
| POST | `/expiry-alerts/plans/{id}/close` | Đóng kế hoạch: `status` (`DONE`/`CANCELLED`), `outcome` | `stock.adjust.create` |
| GET | `/expiry-alerts/batches/{batchId}/plans` | Lịch sử xử lý của một lô | `stock.read` |

- Nhóm theo số ngày còn lại: `EXPIRED` đã hết hạn · `D30` dưới 30 ngày · `D60` 31–60 ngày · `D90` 61–90 ngày.
- `action`: `RETURN_SUPPLIER` trả nhà cung cấp · `PRIORITIZE_SALE` ưu tiên bán · `DISCOUNT` giảm giá đẩy hàng · `DISPOSE` lên lịch xuất hủy.
- **Mỗi lô chỉ có một kế hoạch đang mở** (ràng buộc ở tầng CSDL). Lập lại cho lô đã có kế hoạch thì cập nhật kế hoạch đó, không tạo thêm.
- Kế hoạch quá `dueDate` mà chưa đóng thì `overdue = true` và được đếm vào `summary.overduePlans` để báo lại.
- Kế hoạch đã đóng vẫn nằm trong lịch sử của lô kèm `outcome`, người đóng và thời điểm.
- Giá trị tồn (`stockValue`, `summary.totalValue`) chỉ trả về khi có `stock.cost.read`.
- Lô đang biệt trữ vẫn nằm trong danh sách vì hàng vẫn ở trong kho.
- Xuất hủy vẫn đi qua phiếu điều chỉnh tồn (§10.3); kế hoạch ở đây chỉ là bước lên lịch và theo dõi.

### 10.7 Kiểm kê theo đợt

Đợt kiểm kê là lớp đứng trên phiếu điều chỉnh tồn (§10.3): đếm hàng thực tế theo phạm vi đã chọn, chốt lại thành **một phiếu điều chỉnh `DRAFT`** để người khác duyệt.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/stock-counts` | `{ items, open }` — các đợt của cửa hàng và đợt đang đếm (nếu có); lọc `status` | `stock.read` |
| POST | `/stock-counts` | Mở đợt: `scopeType` (`ALL`/`CATEGORY`/`SHELF`), `scopeValue`, `note`. Chụp mọi lô còn tồn trong phạm vi | `stock.adjust.create` |
| GET | `/stock-counts/{id}` | `{ count, lines, summary }` | `stock.read` |
| PATCH | `/stock-counts/{id}/counts` | Ghi số đếm nhiều dòng: `entries[{ lineId, unitId, quantity }]`, hoặc `{ lineId, clear: true }` để xóa số đã đếm | `stock.adjust.create` |
| POST | `/stock-counts/{id}/lines` | Thêm lô tìm thấy trên kệ nhưng chưa có trong đợt (`batchId`) | `stock.adjust.create` |
| POST | `/stock-counts/{id}/close` | Chốt đợt, sinh phiếu điều chỉnh cho các dòng lệch; ghi audit `STOCK_COUNT_CLOSE` | `stock.adjust.create` |
| POST | `/stock-counts/{id}/cancel` | Bỏ đợt, không đụng tới tồn; ghi audit `STOCK_COUNT_CANCEL` | `stock.adjust.create` |

Quy tắc:

- **Mỗi cửa hàng chỉ có một đợt `COUNTING`** tại một thời điểm (ràng buộc ở tầng CSDL). Hai đợt song song sẽ đếm chồng nhau và sinh hai phiếu mâu thuẫn trên cùng một lô.
- Mốc so sánh của mỗi dòng là `systemBaseQuantityAtCount` — tồn hệ thống **tại đúng thời điểm ghi số đếm**, không phải lúc mở đợt. Nhờ vậy nhà thuốc vẫn bán bình thường trong lúc kiểm kê: hàng bán sau khi đếm không bị tính thành thất thoát.
- **Dòng chưa đếm không bị coi là đếm được 0**: chúng không vào phiếu điều chỉnh, tồn giữ nguyên.
- Đếm theo đơn vị nào cũng được (`Viên`, `Hộp`…); hệ thống quy về đơn vị cơ bản và giữ nguyên đơn vị đã đếm trên phiếu để đối chiếu với biên bản.
- Lô `QUARANTINED` vẫn nằm trong danh sách đếm vì hàng vẫn ở trên kệ.
- Giá trị chênh lệch (`differenceValue`) chỉ trả về khi có `stock.cost.read`.
- Phiếu điều chỉnh sinh ra vẫn theo luật §10.3: người duyệt phải khác người lập, tồn chỉ đổi khi phiếu được duyệt.

Kiểm kê qua Excel (§ Nhập / xuất Excel): xuất `stock-count` cho ra bảng đếm của đợt đang mở — **cố ý không in tồn hệ thống** để người đếm không chép theo số có sẵn; nhập `stock-count` ghi số đếm vào đúng đợt đang mở, khớp dòng theo mã sản phẩm và số lô.

### 10.8 Thuốc kiểm soát đặc biệt

Áp dụng cho `drugClass = CONTROLLED` (gây nghiện, hướng thần, tiền chất). Trước đây MVP chặn bán nhóm này vì chưa có sổ theo dõi; nay bán được với các ràng buộc dưới đây.

**Điều kiện bán** (kiểm ngay trong transaction bán hàng, §14.2):

| Điều kiện | Không đạt thì |
|---|---|
| Có đơn thuốc đã xác nhận, còn hiệu lực | `PRESCRIPTION_REQUIRED` / `PRESCRIPTION_NOT_VERIFIED` / đơn hết hiệu lực |
| Người bán có `sale.prescription_drug` | `403 FORBIDDEN` |
| Đã ghi thông tin người mua | `CONTROLLED_BUYER_REQUIRED` |
| Đơn thuốc đã có ảnh lưu | Cảnh báo `CONTROLLED_PRESCRIPTION_IMAGE_MISSING` mức `HIGH`, phải `safety.ack` mới bán |

`POST /invoices` nhận thêm `controlledBuyer`: `buyerName`, `buyerIdNumber` (tối thiểu 6 ký tự), `buyerAddress`, `buyerPhone`, `relationship` (`SELF`/`RELATIVE`/`CAREGIVER`/`OTHER`), `relationshipNote`. Dữ liệu lưu ở `controlled_sale_details`, mỗi hóa đơn tối đa một bản ghi. `POST /sales/safety-check` nhận `hasControlledBuyer` để quầy bán biết trước còn thiếu gì.

**Sổ theo dõi:**

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/controlled-drugs` | Danh mục thuốc kiểm soát đặc biệt kèm tồn hiện tại | `controlled.read` |
| GET | `/controlled-drugs/ledger?from&to&productId` | Sổ xuất nhập theo kỳ (mặc định 30 ngày, tối đa 366 ngày) | `controlled.read` |

- Sổ **dựng lại từ thẻ kho** mỗi lần xem, không phải bảng ghi tay song song: không ai sửa được sổ mà không để lại chứng từ, và sổ không lệch tồn kho.
- Mỗi dòng có: thời gian, số chứng từ, diễn giải, nhập, xuất, **số dư sau**, số lô, hạn dùng, người mua (họ tên, số giấy tờ, địa chỉ, quan hệ), đơn thuốc, người kê, cơ sở khám chữa bệnh, người thực hiện.
- `openingBalance` là tổng mọi bút toán trước ngày bắt đầu kỳ, nên kỳ nào cũng có số mang sang như sổ giấy.
- `mismatches` so số cuối kỳ với tồn kho khi kỳ kết thúc hôm nay; lệch là dấu hiệu dữ liệu có vấn đề, phải báo người phụ trách chuyên môn.
- Xuất Excel `controlled-ledger` (§ Nhập / xuất Excel): sheet "Tổng hợp" và "Chi tiết", có ghi nhật ký mỗi lần xuất.

---

## 11. Khách hàng

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/customers` | Có `search` (tối thiểu 3 ký tự): tìm theo tên hoặc số điện thoại, trả mảng tối đa 20 khách. Không có `search`: danh sách phân trang (`page`, `limit`, `sortBy` là `createdAt`/`fullName`/`totalSpent`/`lastPurchaseAt`, `order`, `q` tìm tên/SĐT/mã KH, `segment` là `LOYAL`/`NEW`/`DORMANT`), không gồm khách đã ẩn danh; mỗi dòng kèm `code`, `totalSpent`, `orderCount`, `lastPurchaseAt`, `segment`. Cả hai chỉ trả trường cơ bản, số điện thoại che bớt; hồ sơ sức khỏe và chi tiết lịch sử mua xem riêng từng khách | `customer.read` |
| GET | `/customers/summary` | Tổng khách, khách mới tháng này, đã mua trong 30 ngày, số khách mỗi nhóm, kèm quy tắc nhóm | `customer.read` |
| GET | `/customers/export` | CSV theo bộ lọc `q`, `segment`; có số điện thoại đầy đủ; ghi audit `CUSTOMER_EXPORT` | `customer.sensitive` |
| GET | `/customers/{id}` | Thông tin cơ bản, mã khách, email, địa chỉ, `stats` (tổng mua, số đơn, lần mua cuối, nhóm) | `customer.read` |
| POST | `/customers` | Tạo khách | `customer.manage` |
| PATCH | `/customers/{id}` | Sửa thông tin cơ bản | `customer.manage` |
| GET | `/customers/{id}/health-profile` | Dị ứng (theo hoạt chất và ghi chú), bệnh nền; ghi audit mỗi lần xem | `customer.sensitive` |
| PATCH | `/customers/{id}/health-profile` | Cập nhật hồ sơ sức khỏe | `customer.sensitive` |
| GET | `/customers/{id}/invoices` | Lịch sử mua; ghi audit mỗi lần xem | `customer.sensitive` |
| GET | `/customers/{id}/loyalty` | Số dư điểm (`available`, `expiringSoon`, `nextExpiryAt`, `expired`, `totalEarned`, `totalRedeemed`, `deficit`) và 50 bút toán gần nhất | `customer.read` |
| POST | `/customers/{id}/loyalty/adjust` | Cộng/trừ điểm tay: `points` (khác 0), `reason` bắt buộc; ghi audit `LOYALTY_ADJUST`. Cần `X-Store-Id` | `loyalty.manage` |

- Thông tin cơ bản: `fullName`, `phone`, `email`, `address`, `birthYear`, `gender`, `note` (ghi chú chăm sóc). `code` (KH00001…) do hệ thống tự cấp.
- Tổng mua tính trên hóa đơn `COMPLETED` toàn chuỗi, trừ tiền đã hoàn khi trả hàng. Nhóm khách tính từ dữ liệu bán, không phải hạng thành viên: **Thân thiết** từ 5 hóa đơn trong 180 ngày; **Khách mới** tạo hồ sơ trong 30 ngày; **Lâu chưa quay lại** lần mua cuối cách hơn 90 ngày. Nhóm khách tính từ dữ liệu bán, độc lập với điểm tích lũy ở §11.1. Hệ thống chưa có công nợ khách hàng.
- Hồ sơ sức khỏe chỉ được lưu khi đã ghi nhận sự đồng ý của khách (`healthDataConsentAt`). **[Đã chốt – P8]**
- Đã bỏ `GET /customers/{id}/allergy-check`; kiểm tra dị ứng nằm trong `POST /sales/safety-check` (§13).
- **Lưu trữ và ẩn danh [Đã chốt – P8]:** hóa đơn, đơn thuốc và thẻ kho giữ theo thời hạn lưu trữ quy định, không xóa. Khi khách yêu cầu xóa dữ liệu cá nhân, hệ thống **ẩn danh hồ sơ khách** (xóa họ tên, số điện thoại, hồ sơ sức khỏe, thay bằng mã ẩn danh) và giữ nguyên chứng từ đã phát sinh. Thao tác ẩn danh cần `customer.sensitive`, bắt buộc ghi lý do và ghi audit log.

### 11.1 Tích điểm khách thân thiết

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/loyalty/settings` | Cài đặt đang áp dụng, kèm `isDefault`, `updatedAt` | `customer.read` hoặc `settings.manage` |
| PUT | `/loyalty/settings` | Lưu cài đặt cho cửa hàng hiện tại; ghi audit `SETTING_UPDATE` | `settings.manage` |

Cài đặt (`loyaltySettings`, theo cửa hàng, không có thì lấy bản chung toàn chuỗi rồi tới mặc định):

| Trường | Mặc định | Ý nghĩa |
|---|---|---|
| `enabled` | `false` | Chạy chương trình hay không. Tắt thì hóa đơn mới không tích điểm và không đổi được điểm; điểm cũ giữ nguyên |
| `earnAmountPerPoint` | 10.000 | Số tiền khách chi để được 1 điểm |
| `pointValue` | 500 | Mỗi điểm đổi được bao nhiêu đồng. Không được vượt quá một nửa `earnAmountPerPoint` (chặn gõ nhầm) |
| `minRedeemPoints` | 20 | Số điểm tối thiểu một lần đổi |
| `maxRedeemPercent` | 50 | Trần phần trăm giá trị hàng được tính điểm mà một lần đổi được giảm |
| `expiryMonths` | 12 | Điểm hết hạn sau bao nhiêu tháng; 0 là không hết hạn |
| `earnOnDrugs` | `false` | Tính điểm cho cả hàng thuốc hay không |

- **Ràng buộc pháp lý:** Luật Dược nghiêm cấm khuyến mại thuốc trực tiếp cho người dùng, nên mặc định `productType = DRUG` **nằm ngoài** chương trình: chỉ TPCN, mỹ phẩm, thiết bị y tế và hàng khác được tính điểm và được dùng làm căn cứ đổi điểm. `earnOnDrugs` là công tắc để chủ nhà thuốc tự quyết sau khi đối chiếu quy định hiện hành; màn cài đặt hiện cảnh báo này.
- **Sổ điểm** (`loyalty_transactions`) là nguồn duy nhất: mỗi dòng là một bút toán `EARN` / `REDEEM` / `REVERSE` / `ADJUST`, `points` dương là cộng, âm là trừ, không bao giờ bằng 0. Số dư **luôn tính lại từ sổ**, không lưu ở bảng khách hàng.
- `deficit` phải luôn bằng 0: khác 0 nghĩa là có bút toán trừ vượt số dư lọt
  vào sổ. Số này được tính ra và trả về thay vì làm tròn cho đẹp, để phát hiện
  sớm sai lệch dữ liệu.
- **Hết hạn:** mỗi lần tích là một lô điểm có `expiresAt`. Khi đổi điểm, lô hết hạn sớm nhất bị tiêu trước; việc hết hạn được xét theo mốc thời gian của từng bút toán nên lô đã hết hạn không gánh cho lần đổi xảy ra sau đó. Không có job chạy nền: điểm quá hạn tự rơi ra khi tính số dư.
- **Tích điểm:** sau khi lập hóa đơn cho khách có hồ sơ, `points = floor(tiền khách thực trả cho hàng được tính điểm / earnAmountPerPoint)`. Căn cứ là `lineTotal` (đã trừ mọi khoản giảm), nên phần trả bằng điểm không được tích lại.
- **Hủy hóa đơn:** ghi hai bút toán `REVERSE` tách nhau — thu lại điểm đã tích và trả lại điểm đã đổi (điểm trả lại nhận hạn dùng mới).
- **Trả hàng:** thu lại điểm theo tỷ lệ tiền hoàn của các dòng thuộc nhóm được tính điểm, không bao giờ quá số điểm hóa đơn đó đã tích. Điểm đã đổi không hoàn lại vì tiền hoàn đã tính trên số tiền sau khi trừ điểm.

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

**Các mã đã cài đặt trong phiên bản này**

| Nhóm | Mã | Ý nghĩa |
|---|---|---|
| blocking | `CONTROLLED_DRUG_NOT_SUPPORTED` | Thuốc kiểm soát đặc biệt, chưa có sổ theo dõi nên chặn bán |
| blocking | `PRESCRIPTION_REQUIRED`, `PRESCRIPTION_NOT_VERIFIED`, `PRESCRIPTION_EXPIRED` | Thuốc kê đơn không có đơn hợp lệ |
| blocking | `INSUFFICIENT_STOCK` | Không đủ tồn **bán được**; kèm `requestedBaseQuantity` và `sellableBaseQuantity` |
| warning | `DUPLICATE_INGREDIENT` (HIGH, cần ghi nhận) | Hai sản phẩm trong giỏ cùng một hoạt chất |
| warning | `ALLERGY_MATCH` (HIGH, cần ghi nhận) | Hoạt chất trùng hồ sơ dị ứng của khách |
| warning | `NEAR_EXPIRY_BATCH` (MEDIUM, không cần ghi nhận) | Lô sẽ xuất còn dưới `nearExpiryWarningDays` ngày |
| notChecked | `NO_INGREDIENT_MAPPING` | Sản phẩm chưa gắn hoạt chất nên không đối chiếu được |
| notChecked | `INTERACTION_SOURCE_NOT_CONFIGURED` | Chưa có nguồn dữ liệu tương tác thuốc; **không** thay bằng suy đoán của LLM |

---

## 14. Bán hàng (hóa đơn)

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| POST | `/invoices` | Tạo hóa đơn `COMPLETED`; cần `Idempotency-Key` | `invoice.create` |
| GET | `/invoices` | Lọc `from`, `to`, `customerId`, `sellerId`, `status`, `code` (chứa chuỗi, không phân biệt hoa thường) | `invoice.read` |
| GET | `/invoices/{id}` | Chi tiết, các dòng, **lô thực tế đã xuất**, phiếu trả liên quan | `invoice.read` |
| POST | `/invoices/{id}/void` | Hủy hóa đơn; bắt buộc `reason`; cần `Idempotency-Key` | `invoice.void` |
| GET | `/invoices/{id}/print` | HTML in theo mẫu in đã lưu của cửa hàng (§21 Cài đặt). Tùy chọn `?format=k80|k58|a5` ghi đè khổ giấy; `?autoprint=0` để xem trước không bật hộp thoại in. Chỉ đọc, không đổi hóa đơn/tồn kho | `invoice.read` |

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
  "loyaltyRedeemPoints": 20,
  "acknowledgedWarnings": [
    { "code": "DUPLICATE_INGREDIENT", "productIds": ["prd_para500", "prd_decolgen"], "reason": "Đã tư vấn, khách chỉ dùng một loại" }
  ],
  "payment": { "method": "CASH", "amountTendered": 100000 }
}
```

Frontend **không** gửi: đơn giá, thành tiền, số tiền giảm, VAT, tổng tiền, tồn kho, lô FEFO, người bán, người ghi nhận cảnh báo. Nếu các trường này có trong body, backend bỏ qua.

`payment.method`: `CASH`, `BANK_TRANSFER`, `CARD` (chỉ ghi nhận; tích hợp cổng thanh toán để sau MVP).

Dòng đơn thuốc lưu trên hóa đơn là **dòng do máy chủ khớp**, không phải
`prescriptionItemId` máy khách gửi lên (máy khách có thể không gửi). Khi đơn
có nhiều dòng cùng một thuốc và máy khách không chỉ định, máy chủ chọn dòng
**còn lại nhiều nhất**. Nhờ vậy hủy hóa đơn hoặc nhận trả hàng luôn trừ lại
đúng số đã cấp phát của đơn thuốc.

`loyaltyRedeemPoints` (mặc định 0): số điểm khách đổi trên hóa đơn này (§11.1). Số tiền giảm do máy chủ tính, cộng vào `discountAmount` nhưng **không** tính vào hạn mức giảm giá của vai trò — đây là tiền của chính khách. Lỗi trả về: `LOYALTY_DISABLED` (409), `LOYALTY_MIN_POINTS`, `LOYALTY_INSUFFICIENT_POINTS`, `LOYALTY_REDEEM_LIMIT` (422). Hóa đơn lưu thêm `loyaltyPointsRedeemed`, `loyaltyDiscountAmount`; chi tiết hóa đơn trả kèm `loyaltyPointsEarned` (đã trừ phần thu lại do trả hàng hoặc hủy).

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

**Tiền hoàn tính lũy kế theo dòng hóa đơn:** tiền hoàn của một lần trả là
hiệu giữa tiền hoàn ứng với tổng số đã trả *sau* lần này và tổng số đã trả
*trước* đó. Nhờ vậy trả lẻ nhiều lần một dòng có đơn giá lẻ (ví dụ 10.000đ cho
6 đơn vị) vẫn không bao giờ hoàn vượt số tiền của dòng, và trả hết thì hoàn
đúng bằng thành tiền của dòng.

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
- Mặc định báo cáo tính cho cửa hàng trong header `X-Store-Id`. Thêm `?storeId=ALL` để hợp nhất toàn chuỗi (cần `report.chain`), hoặc `?storeId=<id>` để xem một cửa hàng khác mà người dùng có quyền. Kết quả toàn chuỗi luôn kèm phần tách theo từng cửa hàng. **[Đã chốt – P18]**
- Doanh thu = hóa đơn `COMPLETED` trong kỳ trừ tiền hoàn của phiếu trả **lập trong kỳ**. Hóa đơn `VOIDED` bị loại hoàn toàn. **[Đã chốt – P13]**
- Báo cáo xuất – nhập – tồn tính từ thẻ kho, nên luôn khớp với tồn thực tế của lô.
- Giá vốn chỉ lấy từ `invoice_allocations.unit_cost` (xem §9).

**`costQuality` của `GET /reports/summary`** — đếm theo *phần đóng góp vào công
thức lãi gộp*, vì lãi gộp của kỳ = doanh thu − (giá vốn hàng bán trong kỳ −
giá vốn hoàn của hàng trả về bán lại trong kỳ):

| Trường | Nghĩa |
|---|---|
| `saleLines` | Số dòng phân bổ lô của hóa đơn bán **trong kỳ**. |
| `returnLines` | Số dòng hàng trả **trong kỳ** có nhập lại kho (RESTOCK). Hóa đơn gốc có thể thuộc kỳ trước. Hàng trả tiêu hủy (DISPOSE) không hoàn giá vốn nên **không** đếm. |
| `totalLines` | `saleLines + returnLines`. Bán rồi trả trong cùng kỳ đóng góp hai lần nên được đếm hai lần; trả nhiều lần trên cùng một phân bổ đếm theo từng lần trả. |
| `actualLines` / `estimatedLines` / `unknownLines` | Phân loại theo `unit_cost_source` của phần đóng góp (xem §9). |
| `unknownSaleLines` | Thiếu giá vốn ở phần **bán** → giá vốn thấp đi → lãi gộp **cao hơn** thực tế. |
| `unknownReturnLines` | Thiếu giá vốn ở phần **hoàn** của hàng trả → phần trừ ra nhỏ đi → lãi gộp **thấp hơn** thực tế (ngược chiều với phần bán). |
| `exact` | Cả kỳ không có dòng ước tính hay không xác định. |
| `comparisonExact` | Cả kỳ này **và kỳ so sánh** đều đủ giá vốn thật. Sai thì tỷ lệ tăng/giảm lãi gộp so với kỳ trước không được trình bày như số chính xác. |

Giao diện phải nói rõ ảnh hưởng theo đúng chiều của từng loại thiếu hụt, và
không hiển thị tỷ lệ so sánh khi `comparisonExact = false`.

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
| PUT | `/users/{id}/roles` | Thay toàn bộ vai trò; body là mảng `{ roleCode, storeId }`, `storeId = null` là toàn chuỗi; ghi audit | `user.manage` |
| POST | `/users/{id}/deactivate` | Vô hiệu hóa, thu hồi mọi phiên | `user.manage` |
| POST | `/users/{id}/activate` | Kích hoạt lại | `user.manage` |
| POST | `/users/{id}/reset-password` | Đặt mật khẩu tạm, thu hồi mọi phiên | `user.manage` |
| GET | `/roles` | Danh sách vai trò và permission của từng vai trò | `user.manage` |

- Không ai tự đổi vai trò của chính mình. Không vô hiệu hóa hoặc gỡ vai trò của admin cuối cùng (`422`).
- `PATCH /users/{id}` không nhận `roles`, `password`, `isActive`; các trường này có endpoint riêng.

### Cửa hàng [Đã chốt – P18]

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/stores` | Danh sách cửa hàng người dùng được phép làm việc | Đã đăng nhập |
| GET | `/stores/{id}` | Chi tiết cửa hàng | Có vai trò tại cửa hàng, hoặc `store.manage` |
| POST | `/stores` | Mở cửa hàng mới trong chuỗi | `store.manage` |
| PATCH | `/stores/{id}` | Sửa thông tin cửa hàng | `store.manage` |
| POST | `/stores/{id}/deactivate` | Ngừng hoạt động; chặn mọi nghiệp vụ mới tại cửa hàng đó | `store.manage` |

Trường chính: `code` (ví dụ `NT01`, dùng làm tiền tố số chứng từ), `name`, `address`, `phone`, `gppCertificateNumber`, `licenseNumber`, `isActive`.

Cửa hàng đã phát sinh chứng từ thì không xóa, chỉ ngừng hoạt động.

### Cài đặt – Mẫu in hóa đơn

Bắt buộc `X-Store-Id`: mỗi cửa hàng (chi nhánh) có mẫu in riêng, lưu ở bảng `settings` với khóa `invoicePrintTemplate`.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/settings/invoice-print-template` | Mẫu đang áp dụng: `{ template, isDefault, updatedAt }`. Chưa lưu thì trả mẫu mặc định lấy tên/địa chỉ/điện thoại của cửa hàng | `settings.manage` hoặc `invoice.read` |
| PUT | `/settings/invoice-print-template` | Lưu mẫu; ghi audit `SETTING_UPDATE` | `settings.manage` |
| POST | `/settings/invoice-print-template/preview` | Body `{ template, sample: "standard"|"long"|"walk_in" }`, trả HTML dựng từ dữ liệu mẫu; không tạo giao dịch | `settings.manage` |

`template`: `paperSize` (`K80` | `K58` | `A5`), `logo` (data URL PNG/JPEG ≤ 300 KB hoặc `null`; kiểm tra theo nội dung byte, xóa EXIF, không nhận SVG), `companyName`, `storeName` (bắt buộc), `address`, `phone`, `taxCode`, `title` (bắt buộc), `footer`, `display` gồm các cờ `logo`, `customer`, `seller`, `unit`, `discount`, `paymentMethod`, `cashChange`.

Xem trước, in thử và in thật dùng chung một hàm render ở server. Bản in là phiếu bán hàng tại quầy, không thay thế hóa đơn điện tử.

### Cài đặt – Mẫu in phiếu

Phần đầu (logo, tên đơn vị, địa chỉ, điện thoại, MST) của mọi chứng từ lấy từ Mẫu in hóa đơn. Cài đặt riêng từng loại phiếu lưu ở khóa `documentPrintSettings`, theo cửa hàng.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/settings/document-print` | `{ settings, isDefault, updatedAt }`; loại phiếu chưa lưu hoặc lưu hỏng dùng mặc định | `settings.manage` |
| PUT | `/settings/document-print` | Lưu cả ba loại phiếu; ghi audit `SETTING_UPDATE` | `settings.manage` |
| POST | `/settings/document-print/preview` | Body `{ type, settings }`, trả HTML phiếu mẫu; không tạo chứng từ | `settings.manage` |

`settings` gồm `goodsReceipt`, `return`, `stockAdjustment`; mỗi loại có `paperSize`, `title` (bắt buộc), `footer`, `showSignatures`, `showAmountInWords`, `showNote`. Khổ giấy cho phép: phiếu nhập và phiếu điều chỉnh `A4`/`A5`; phiếu trả `K80`/`K58`/`A5`/`A4`.

Trang in của từng chứng từ:

| Method | Endpoint | Quyền |
|---|---|---|
| GET | `/invoices/{id}/print` | `invoice.read` |
| GET | `/goods-receipts/{id}/print` | `goods_receipt.read` |
| GET | `/returns/{id}/print` | `invoice.read` |
| GET | `/stock-adjustments/{id}/print` | `stock.read` |

Mọi trang in bắt buộc `X-Store-Id`, chỉ đọc dữ liệu (in lại bao nhiêu lần cũng không đổi chứng từ, tồn kho, thanh toán), nhận `?autoprint=0` để không tự bật hộp thoại in, và trả header `X-Paper-Size` cho giao diện hiển thị đúng khổ. Phiếu nháp, đã hủy, đã từ chối được in kèm dòng cảnh báo trạng thái ở đầu phiếu.

### In tem mã vạch

Tem dán lên hộp thuốc hoặc nhãn kệ: tên thuốc, mã vạch, giá bán theo đơn vị, và (tùy chọn) số lô, hạn dùng, tên nhà thuốc.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/labels/sizes` | Các khổ tem hỗ trợ | `catalog.read` |
| POST | `/labels/print?autoprint=0` | Dựng trang tem (HTML); trả header `X-Label-Count` và `X-Label-Warnings` | `catalog.read` |

Body: `size`, `showPrice`, `showBatch`, `showStoreName`, `items[{ productId, unitId, batchId, quantity }]` (tối đa 200 mặt hàng, mỗi mặt hàng tối đa 500 tem).

Khổ tem: `50x30`, `40x30`, `35x22` (tem nhiệt, mỗi tem một trang đúng kích thước) và `A4_38x21` (giấy decal A4, 65 tem xếp lưới 5 cột).

**Mã in trên tem** lấy theo thứ tự: mã vạch của đơn vị đang in → mã vạch của đơn vị khác cùng sản phẩm → mã sản phẩm nội bộ.

- Mã 8 hoặc 13 chữ số **đúng số kiểm** in chuẩn EAN-8 / EAN-13; còn lại in Code128 bộ B.
- Hệ thống **không bao giờ tự sinh hay sửa số kiểm** mã EAN: mã EAN là của nhà sản xuất đăng ký, sửa hộ sẽ thành mã của mặt hàng khác.
- Các trường hợp cần người in biết được trả về trong `X-Label-Warnings` (JSON đã `encodeURIComponent`): thuốc chưa có mã vạch nên in mã nội bộ, đơn vị chưa có mã vạch riêng, đơn vị chưa có giá bán, mã lưu trong danh mục sai số kiểm EAN.
- Mã vạch vẽ bằng SVG theo đơn vị mm nên in ra đúng kích thước thật, không phụ thuộc DPI máy in.

### Nhập / xuất Excel

Chỉ nhận tệp `.xlsx`: tối đa 5 MB và 5.000 dòng mỗi tệp. Hàng 1 là tiêu đề, được khớp theo tên cột, không phân biệt dấu, hoa thường hay dấu `*`. Thứ tự cột không quan trọng.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/excel/catalog` | Các loại nhập/xuất mà tài khoản được dùng tại cửa hàng đang chọn | Đăng nhập |
| GET | `/excel/templates/{type}` | Tệp mẫu gồm dòng ví dụ và sheet "Hướng dẫn"; cột bắt buộc có dấu `*` | Theo loại nhập |
| POST | `/excel/imports/{type}?mode=preview` | Multipart, field `file`. Đọc và kiểm tra toàn bộ tệp, không ghi gì. Trả `totalRows`, `validRows`, `creates`, `updates`, `missingColumns`, `issueCount`, `issues[{row, column, message}]` (tối đa 300), `notes`, `sample` | Theo loại nhập |
| POST | `/excel/imports/{type}?mode=commit` | Đọc và kiểm tra lại chính tệp đó. Còn một lỗi → `422`, không dòng nào được ghi. Hợp lệ → ghi trong một giao dịch và ghi audit `EXCEL_IMPORT` | Theo loại nhập |
| GET | `/excel/exports/{type}?from=YYYY-MM-DD&to=YYYY-MM-DD` | Tệp `.xlsx` có định dạng tiền và ngày kiểu Việt Nam. Loại theo kỳ mặc định lấy 30 ngày gần nhất, tối đa 366 ngày | Theo loại xuất |

Loại nhập:

| `type` | Quyền | Cửa hàng | Ghi chú |
|---|---|---|---|
| `products` | `catalog.manage` | Không | Khớp theo mã; mã mới thì tạo mới. Không đổi được loại hàng, phân loại thuốc, đơn vị cơ bản hay quy đổi đã có. Nhóm hàng và hoạt chất chưa có thì tự tạo. Giá khác giá hiện hành cần `price.manage` và tạo phiên bản giá mới; giá giữ nguyên thì bỏ qua |
| `suppliers` | `catalog.manage` | Không | Khớp theo mã số thuế, không có thì theo tên (không dấu) |
| `customers` | `customer.manage` | Không | Khớp theo Mã KH, không có thì theo số điện thoại. Không nhập hồ sơ sức khỏe |
| `opening-balance` | `stock.opening_balance` | Có | Cả tệp tạo một phiếu tồn đầu kỳ (§10.4); chặn lô đã có trong kho |
| `stock-count` | `stock.adjust.create` | Có | Ghi số đếm vào đợt kiểm kê đang mở (§10.7); ô số đếm để trống là chưa đếm, không phải đếm được 0 |
| `receipt-lines` | `goods_receipt.create` | Có | Chỉ `preview`: trả thêm `lines[]` đã khớp sản phẩm và đơn vị để đổ vào phiếu nhập nháp |

Loại xuất:

| `type` | Quyền | Cửa hàng | Nội dung |
|---|---|---|---|
| `products` | `catalog.read` | Không | Đúng cột của mẫu nhập, kèm giá hiện hành và tồn bán được tại cửa hàng đang chọn |
| `suppliers` | `catalog.read` | Không | Đúng cột của mẫu nhập |
| `customers` | `customer.sensitive` | Không | Số điện thoại đầy đủ; ghi audit `EXCEL_EXPORT` |
| `inventory` | `stock.read` | Có | Tồn từng lô theo hạn dùng; cột giá vốn và giá trị tồn chỉ có khi được `stock.cost.read` |
| `stock-count` | `stock.read` | Có | Bảng đếm của đợt kiểm kê đang mở, không kèm tồn hệ thống (§10.7) |
| `invoices` | `invoice.read` | Có | Sheet "Hóa đơn" và "Chi tiết" (kèm lô xuất) |
| `goods-receipts` | `goods_receipt.read` | Có | Sheet "Phiếu nhập" và "Chi tiết" (lô, ngày sản xuất, hạn dùng) |
| `purchase-order` | `stock.read` | Có | Đơn đặt hàng gợi ý (§10.5), xếp theo nhà cung cấp |
| `rx-sales` | `prescription.read` | Có | Sổ theo dõi bán thuốc kê đơn và thuốc kiểm soát đặc biệt: người bệnh, đơn thuốc, người kê, cơ sở khám chữa bệnh, chẩn đoán, số lô, hạn dùng, người bán |
| `controlled-ledger` | `controlled.read` | Có | Sổ thuốc kiểm soát đặc biệt (§10.8): sheet Tổng hợp và Chi tiết; ghi audit `EXCEL_EXPORT` |

Giá trị trong ô luôn được ghi dạng dữ liệu, không bao giờ là công thức. Thời điểm (giờ bán, giờ nhận hàng) ghi theo giờ Việt Nam.

### Sao lưu dữ liệu

Một bản sao lưu gồm **tệp dump CSDL** (`pg_dump --format=custom`) và **bản chép thư mục `storage`** (ảnh đơn thuốc, ảnh sản phẩm) — thiếu một trong hai là không phục hồi đủ hồ sơ. Phạm vi toàn chuỗi, không theo cửa hàng.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/backups` | `{ status, items }`: tình trạng bảo vệ dữ liệu và lịch sử các lượt | `backup.manage` |
| POST | `/backups` | Sao lưu ngay; `409` nếu đang có lượt chạy; ghi audit `BACKUP_RUN` hoặc `BACKUP_FAILED` | `backup.manage` |
| PUT | `/backups/settings` | Lịch chạy, số bản giữ lại, ngưỡng cảnh báo; ghi audit `SETTING_UPDATE` | `backup.manage` |
| GET | `/backups/{id}/download` | Tải tệp dump về máy khác hoặc USB; ghi audit `BACKUP_DOWNLOAD` | `backup.manage` |

`status` gồm `lastSuccessAt`, `isStale`, `nextRunAt`, `keptCount`, `totalBytes`, `backupDir`, `toolMode` (`docker` hoặc `local`) và `restoreCommands`. Cài đặt lưu ở khóa `backupSettings` (chung toàn chuỗi): `enabled`, `hour`, `minute` (giờ Việt Nam), `keepCount`, `includeStorage`, `staleAfterHours`.

Quy tắc:

- Lượt theo lịch chạy mỗi ngày một lần tại mốc đã đặt; máy tắt đúng giờ hẹn thì lần bật máy tiếp theo **trong ngày** chạy bù.
- Chỉ một lượt chạy tại một thời điểm. Lượt lỗi bị xóa thư mục dở dang, giữ lại dòng lịch sử kèm lý do.
- Quá `keepCount` bản thì tệp cũ bị dọn, dòng lịch sử vẫn còn và được đánh dấu `deletedAt`.
- **Không có API phục hồi.** Phục hồi ghi đè toàn bộ dữ liệu đang chạy nên phải làm thủ công bằng `pg_restore`; hệ thống chỉ trả về câu lệnh kèm đường dẫn thật.

Cấu hình bằng biến môi trường: `BACKUP_DIR` (nên trỏ sang ổ đĩa khác), `BACKUP_DOCKER_CONTAINER` khi PostgreSQL chạy trong Docker, `BACKUP_PG_DUMP` khi PostgreSQL cài trực tiếp trên máy.

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

Thuốc kiểm soát đặc biệt (`drugClass = CONTROLLED`) đã bán được kể từ khi có sổ theo dõi ở §10.8: phải có đơn đã xác nhận, người bán là dược sĩ và ghi đủ thông tin người mua.

Về mô hình chuỗi: MVP chạy với **một cửa hàng**, nhưng dữ liệu và API đã có phạm vi cửa hàng (§2.8), nên mở cửa hàng thứ hai chỉ là thêm một dòng trong `/stores` và gán vai trò cho nhân sự. Phần còn lại của mô hình chuỗi để sau MVP: chuyển hàng giữa các cửa hàng, giá riêng theo cửa hàng, báo cáo so sánh giữa các cửa hàng.

**Sau MVP**

- Đơn đặt hàng nhà cung cấp: đã có đề xuất đặt hàng (§10.5), chưa có chứng từ đơn hàng riêng gửi nhà cung cấp.
- Danh mục bác sĩ; OCR đơn thuốc; AI giải thích cảnh báo; dự báo nhập hàng nâng cao (đã có đề xuất đặt hàng cơ bản ở §10.5).
- Ngăn biệt trữ theo số lượng.
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
| P18 | **Mở rộng thành chuỗi nhiều nhà thuốc.** Thêm `store_id` và tài nguyên `/stores` ngay từ migration đầu tiên; header `X-Store-Id`; vai trò gán theo cửa hàng; báo cáo toàn chuỗi cần `report.chain` | – | §2.8, §4.2, §19, §21 |

---

## 24. Bước tiếp theo

**Ba giá trị mặc định cần đối chiếu văn bản pháp lý trước khi vận hành thật:** số ngày hạn dùng tối thiểu khi bán (P11), thời hạn hiệu lực của đơn thuốc và vai trò được bán thuốc kê đơn (P14), ngưỡng nhiệt độ – độ ẩm (P16). Phần mềm chạy được với giá trị mặc định, nhưng nhóm phải xác nhận lại theo văn bản đang có hiệu lực.

1. ~~Thiết kế ERD PostgreSQL~~ — đã xong, xem `docs/erd.md` v1.1 (41 bảng, có sẵn `store_id` cho mô hình chuỗi).
2. ~~Viết kiểm thử cho các bảng trạng thái ở §5 và các kịch bản đồng thời~~ — đã có bộ kiểm thử tích hợp chạy trên PostgreSQL thật, gồm xác nhận một phiếu nhập hai lần và hai quầy bán lô cuối cùng cùng lúc. Còn thiếu: hai phiếu trả song song cho cùng một dòng, duyệt điều chỉnh trong lúc đang bán.
3. **Dựng khung dự án và CSDL local**, rồi mới viết endpoint theo thứ tự: ~~cửa hàng, người dùng, phân quyền~~ → ~~danh mục, đơn vị, giá~~ → ~~phiếu nhập~~ → ~~bán hàng~~ → ~~trả hàng, hủy hóa đơn~~ → ~~thu hồi~~. Toàn bộ mục 3 và §12 (đơn thuốc) đã xong trọn vẹn, kể cả tải ảnh đơn: kiểm tra theo nội dung tệp (không tin đuôi/Content-Type), xóa EXIF viết tay cho JPEG/PNG (không dùng thư viện ảnh nặng), lưu ngoài thư mục public, xem qua URL có chữ ký HMAC hạn 5 phút. Không còn mục nào bỏ ngỏ trong §12. §11 (khách hàng) cũng đã xong: tìm/tạo/sửa, hồ sơ sức khỏe và dị ứng (bắt buộc đồng ý mới lưu — P8), lịch sử mua, gắn vào màn bán hàng và cảnh báo dị ứng đã kiểm chứng đầu cuối. Chưa làm thao tác ẩn danh hóa khách (is_anonymized) — để sau vì không nằm trong ưu tiên gần nhất.
4. Thêm vào bộ kiểm thử một nhóm riêng cho phạm vi cửa hàng: tài khoản của cửa hàng A không đọc, không sửa được dữ liệu của cửa hàng B ở **mọi** endpoint thuộc phạm vi cửa hàng.
