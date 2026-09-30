# Mô hình bốn vai trò

## Phạm vi

Quản lý (`admin`), Dược sĩ (`pharmacist`), Nhân viên kho (`warehouse_staff`), Kiểm toán (`auditor`). Vai trò `sales_staff` ngừng dùng. Ma trận chính thức nằm tại `api-contract.md` §4.2 và `server/src/config/permissions.ts`.

- Quản lý thuần không tạo giao dịch bán. Quản lý đủ điều kiện chuyên môn cần được người quản trị khác gán thêm Dược sĩ.
- Dược sĩ được bán nhưng không tự có quyền duyệt đơn, hủy hóa đơn, duyệt điều chỉnh, xác nhận phiếu nhập, vượt hạn mức giảm giá hoặc bỏ qua cảnh báo an toàn mức cao. Các quyền bổ sung nằm trong danh sách cố định, chỉ gán tại cửa hàng cụ thể.
- Thu hồi và quản lý liên thông hiện là thao tác toàn chuỗi trong backend; không đưa vào danh sách quyền bổ sung theo cửa hàng. Quản lý tiếp tục thực hiện các chức năng này theo quyền hiện có.
- Người chịu trách nhiệm chuyên môn được ghi trên dòng phân công Dược sĩ tại cửa hàng. Chức danh không tự cấp quyền. Hệ thống kiểm tra có số chứng chỉ, trạng thái hoạt động và căn cứ kiểm tra hồ sơ, nhưng không tự chứng thực tính hợp lệ hoặc đầy đủ của giấy tờ.

## Chuyển đổi dữ liệu

Migration `20260930120000_four_roles_scoped_approvals`:

1. Thêm quyền bổ sung, căn cứ kiểm tra chuyên môn và chức danh vào `user_roles`.
2. Lưu các phân công `sales_staff` cũ vào audit với action `LEGACY_SALES_ROLE_RETIRED` rồi gỡ vai trò này. Không xóa người dùng, hóa đơn, phiếu nhập hoặc lịch sử thao tác; không tự cấp vai trò Dược sĩ.
3. Đồng bộ lại quyền nền bốn vai trò. Dược sĩ cũ giữ quyền nền mới, không tự nhận quyền duyệt bổ sung. Căn cứ chuyên môn cũ chưa có được để trống, không suy diễn.
4. Thu hồi phiên đang đăng nhập để người dùng đăng nhập lại theo quyền mới.
5. Bỏ khóa cấu hình hạn mức giảm giá dành cho vai trò bán hàng cũ.

Migration chạy trong một transaction. Đây là thay đổi quyền có ảnh hưởng vận hành: chọn thời điểm không đang giao dịch, sao lưu và kiểm tra trước trên bản sao dữ liệu. Không chạy seed demo để thay cho migration trên dữ liệu đang sử dụng.

Từ thư mục `server`, sau khi đã chuẩn bị dữ liệu và xác nhận triển khai: `npx prisma migrate deploy`, `npm run db:generate`, rồi khởi động lại backend/frontend theo quy trình triển khai. Mã mới cần schema mới; không khởi chạy backend mới trên schema cũ.

## Rà soát sau chuyển đổi

- Người chỉ có vai trò cũ sẽ chưa có quyền sử dụng; quản lý mở Nhân viên, đối chiếu hồ sơ rồi gán vai trò phù hợp. Không dựa vào username để quyết định bằng cấp.
- Rà soát tất cả dòng Dược sĩ chưa có căn cứ; giao diện chi tiết hiển thị nhắc kiểm tra. Khi lưu phân công Dược sĩ, căn cứ là bắt buộc.
- Cấp các quyền bổ sung cần thiết theo nhiệm vụ, chọn cửa hàng; không chọn toàn chuỗi cho quyền bổ sung.
- Phân công người chịu trách nhiệm chuyên môn sau khi kiểm tra hồ sơ. Cửa hàng chưa phân công vẫn có thể ở trạng thái thiết lập; phần mềm không chứng nhận việc đủ điều kiện hoạt động.
- Kiểm tra quản lý thuần không vào quầy bán; quản lý kiêm Dược sĩ và Dược sĩ vào được. Kiểm tra quyền bổ sung không có hiệu lực tại cửa hàng khác.
- Muốn đổi người phụ trách: kết thúc phân công cũ rồi phân công người mới. Khóa tài khoản hoặc xóa chứng chỉ của người đang được phân công bị chặn.
- Mỗi lần thay vai trò có audit trước/sau và thu hồi phiên cũ. Chứng từ lịch sử tiếp tục liên kết với cùng tài khoản.

## Kiểm thử

`role-model.test.ts` kiểm tra mô hình bốn vai trò, chuyển đổi tài khoản cũ, quyền theo cửa hàng, chống tự nâng quyền, thu hồi phiên, bằng chứng chuyên môn, chức danh không tự cấp quyền và phân công đồng thời. Test nghiệp vụ sử dụng một tài khoản quản lý kiêm Dược sĩ khi cần bán; test quản lý thuần chọn fixture `sellingAdmin: false`. Không dùng tài khoản demo thật trong test.

## Kết quả kiểm chứng ngày 30/09/2026

- Server: 605/605 test đạt trong lượt chạy đầy đủ cuối; client: 43/43 test đạt.
- Typecheck và lint server đạt; client build thành công. Build còn cảnh báo chunk lớn hơn 500 kB; test server còn cảnh báo deprecation của pg, không làm test thất bại.
- Đã đối chiếu quyền trong migration với cấu hình: cả bốn vai trò khớp.
- Chưa kiểm tra trực quan màn phân công bằng trình duyệt trong phiên này vì không có trình duyệt kết nối.
- Ban đầu migration mới chỉ được chạy trên CSDL kiểm thử. Sau khi phát hiện backend đang chạy mã mới trên schema cũ gây lỗi đăng nhập, đã sao lưu và áp dụng migration lên `pharmacy_gpp` ngày 30/09/2026. Bản sao lưu trước chuyển đổi: `.tmp/login-repair-20260930/before.dump` (thư mục bị Git bỏ qua).
- Kiểm tra sau triển khai: Prisma xác nhận schema đã cập nhật; `loadAuthContext` và `describeMe` của admin chạy thành công; mật khẩu admin và số bản ghi các bảng nghiệp vụ không đổi. Chưa kiểm tra thao tác nhập mật khẩu qua trình duyệt. Các thay đổi mã chưa commit.
