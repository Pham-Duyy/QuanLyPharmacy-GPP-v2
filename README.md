# QuanLyPharmacy-GPP

Phần mềm quản lý nhà thuốc bán lẻ đạt chuẩn GPP, có AI hỗ trợ dược sĩ.
Thiết kế sẵn cho chuỗi nhiều nhà thuốc.

- Giao diện: React + Vite
- Máy chủ: Node.js + Express
- CSDL: PostgreSQL 17

## Tài liệu thiết kế

| Tài liệu | Nội dung |
|---|---|
| [docs/api-contract.md](docs/api-contract.md) | Contract có hiệu lực: endpoint, quyền, trạng thái, quy tắc nghiệp vụ |
| [docs/erd.md](docs/erd.md) | Lược đồ CSDL: 41 bảng, ràng buộc, chỉ mục, thứ tự migration |
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
npm run db:migrate       # áp dụng migration còn thiếu
npm run db:studio        # xem dữ liệu bằng giao diện
npm run db:reset         # XÓA sạch CSDL dev rồi tạo lại từ đầu
```

Sửa lược đồ thì làm theo thứ tự: sửa `schema.prisma`, chạy `npx prisma migrate dev --create-only --name <ten>`, mở file SQL vừa sinh để thêm ràng buộc viết tay nếu cần, rồi chạy `npm run db:migrate`. Không sửa file migration đã được áp dụng.

## Máy chủ

```bash
cd server
npm run dev              # http://localhost:3000/api/v1/health
npm run typecheck
```
