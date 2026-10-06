# QuanLyPharmacy-GPP

Phần mềm quản lý nhà thuốc bán lẻ đạt chuẩn GPP, thiết kế cho chuỗi nhiều nhà thuốc.

Đã có: bán hàng tại quầy theo FEFO, đơn thuốc, khách hàng và tích điểm, nhập hàng, tồn kho theo lô, kiểm kê, điều chỉnh tồn, trả hàng (khách và nhà cung cấp), công nợ nhà cung cấp, chuyển hàng giữa các cửa hàng, thuốc kiểm soát đặc biệt, sổ nhiệt độ – độ ẩm, thu hồi thuốc, liên thông CSDL Dược quốc gia, hóa đơn điện tử qua MISA meInvoice, báo cáo, nhập/xuất Excel.

Chưa có: tính năng AI (trợ lý tra cứu, OCR đơn thuốc — contract §20), sao lưu trong phần mềm, đơn đặt hàng gửi nhà cung cấp, MFA.

- Giao diện: React + Vite
- Máy chủ: Node.js + Express
- CSDL: PostgreSQL 17

## Tài liệu thiết kế

| Tài liệu | Nội dung |
|---|---|
| [docs/api-contract.md](docs/api-contract.md) | Contract có hiệu lực: endpoint, quyền, trạng thái, quy tắc nghiệp vụ |
| [docs/erd.md](docs/erd.md) | Thiết kế CSDL ban đầu (v1.1, 41 bảng): ràng buộc, chỉ mục. Các bảng thêm sau đó chỉ có trong `server/prisma/schema.prisma` và migration |
| [docs/restful-api-review.md](docs/restful-api-review.md) | Bản đặc tả API ban đầu, giữ để tham chiếu |

Đọc contract trước khi viết bất kỳ endpoint nào.

## Yêu cầu môi trường

- Node.js 24 LTS và npm 11
- Docker Desktop (trên Windows cần bật WSL 2)
- Git

## Chạy cơ sở dữ liệu

```bash
docker compose up -d      # khởi động PostgreSQL
docker compose ps         # xem trạng thái, cột STATUS phải là "healthy"
docker compose logs db    # xem log khi có lỗi
```

Chuỗi kết nối khi phát triển:

```
postgresql://gpp:gpp_dev_password@localhost:5432/pharmacy_gpp
```

Container tạo sẵn hai CSDL: `pharmacy_gpp` để phát triển và `pharmacy_gpp_test` để chạy kiểm thử tích hợp.

```bash
docker compose down       # dừng, GIỮ dữ liệu
docker compose down -v    # dừng và XÓA toàn bộ dữ liệu
```

## Biến môi trường

Sao chép file mẫu rồi sửa cho máy mình. File `.env` thật không bao giờ được commit.

```bash
cp .env.example server/.env
```

## Cơ sở dữ liệu và migration

Lược đồ mô tả trong `server/prisma/schema.prisma`, các ràng buộc mà Prisma không mô tả được (`CHECK`, chỉ mục từng phần, `UNIQUE NULLS NOT DISTINCT`, extension) nằm trong phần SQL viết tay ở cuối mỗi file migration.

```bash
cd server
npm install              # tự chạy prisma generate
npm run db:migrate       # kiểm tra rồi áp các migration đã viết mà CSDL chưa có
npm run check:migrations # chỉ kiểm tra, không áp
npm run db:studio        # xem dữ liệu bằng giao diện
npm run db:reset         # XÓA sạch CSDL dev rồi tạo lại từ đầu
```

`npm run db:migrate` chạy `prisma migrate deploy --config prisma7.config.ts`: **chỉ áp migration đã viết sẵn, không tự sinh migration**. Trước đó nó tự kiểm tra và dừng nếu:

- có file `migration.sql` dùng xuống dòng CRLF;
- một migration đã áp bị sửa nội dung (mã băm khác lúc áp).

Prisma lưu mã băm từng byte của file lúc áp; lệch mã băm làm `prisma migrate dev` đòi reset CSDL. Chi tiết và lần xử lý ngày 30/09/2026: [docs/migration-checksum-log.md](docs/migration-checksum-log.md).

**Không dùng `prisma migrate dev` trong dự án này.** Các ràng buộc viết tay (khóa ngoại tùy chỉnh, `CHECK`, chỉ mục từng phần) không có trong `schema.prisma`, nên lệnh đó sinh ra migration xóa chúng.

Thêm một thay đổi lược đồ:

1. Tạo thư mục mới `server/prisma/migrations/<YYYYMMDDHHMMSS>_<ten>/migration.sql`, viết SQL bằng tay, lưu dạng LF. Có thể xem bản nháp từ `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`, nhưng phải bỏ mọi lệnh xóa ràng buộc viết tay trong đó.
2. Cập nhật `schema.prisma` cho khớp, chạy `npm run db:generate`.
3. Chạy `npm run db:migrate`.

Không sửa file migration đã được áp dụng; thay đổi tiếp theo luôn là một migration mới. Không sửa mã băm trong bảng `_prisma_migrations` để vượt qua cảnh báo.

## Sao lưu CSDL

Phần mềm không có chức năng sao lưu; Nhật ký hệ thống chỉ ghi ai làm gì, không phục hồi được dữ liệu. Trước khi áp migration, dọn dữ liệu hay demo, sao lưu bằng tay và để tệp **ngoài thư mục dự án**:

```bash
# Sao lưu (định dạng custom của pg_dump)
docker exec gpp-postgres pg_dump -U gpp -d pharmacy_gpp -Fc > "D:/sao-luu/pharmacy_gpp-$(date +%Y%m%d-%H%M).dump"

# Kiểm tra tệp đọc được
docker exec -i gpp-postgres pg_restore -l < "D:/sao-luu/<tệp>.dump" | head

# Phục hồi: GHI ĐÈ toàn bộ dữ liệu hiện có
docker exec -i gpp-postgres pg_restore -U gpp -d pharmacy_gpp --clean --if-exists < "D:/sao-luu/<tệp>.dump"
```

Ảnh đơn thuốc và ảnh sản phẩm nằm ở `server/storage/`, không có trong tệp dump; chép thư mục này kèm theo nếu cần giữ đủ hồ sơ.

## Máy chủ

```bash
cd server
npm run dev              # http://localhost:3000/api/v1/health
npm run typecheck
```

## Giao diện

```bash
cd client
npm install
npm run dev              # http://localhost:5173
```

Vite chuyển tiếp mọi request `/api` sang backend ở cổng 3000, nên không bị lỗi CORS và cookie refresh token hoạt động bình thường khi phát triển.

Chạy đủ bộ cần ba việc: `docker compose up -d` cho CSDL, `npm run dev` trong `server/`, và `npm run dev` trong `client/`.

Tài khoản mặc định sau khi seed: `admin` / `Admin@12345`, bắt buộc đổi mật khẩu khi dùng thật.

## Kiểm thử và chất lượng mã

```bash
cd server
npm test                 # kiểm thử tích hợp trên CSDL pharmacy_gpp_test
npm run test:watch
npm run lint             # oxlint
npm run format           # prettier
npm run typecheck
```

Kiểm thử chạy trên **PostgreSQL thật**, không dùng mock, vì phần lớn ràng buộc quan trọng của dự án nằm ở tầng CSDL: `CHECK` tồn không âm, khóa duy nhất `NULLS NOT DISTINCT`, khóa ngoại tổ hợp chặn bán lô của cửa hàng khác. Mock sẽ không bắt được những lỗi đó.

Mỗi test tự xóa sạch dữ liệu rồi dựng lại bộ dữ liệu tối thiểu gồm hai cửa hàng, đủ permission và vai trò, một tài khoản bao toàn chuỗi và một dược sĩ chỉ thuộc cửa hàng thứ nhất. Có hai cửa hàng để kiểm tra được việc không lộ dữ liệu chéo.

Cấu hình GitHub Actions (lint, kiểm tra định dạng, typecheck, kiểm thử) có sẵn ở `.github/workflows/ci.yml.disabled` nhưng **đang tắt** từ 12/09/2026; trước khi gộp code, chạy tay các lệnh trên.
