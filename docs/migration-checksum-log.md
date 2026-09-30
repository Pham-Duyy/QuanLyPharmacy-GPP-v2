# Hồ sơ điều chỉnh checksum migration

Ghi lại mọi lần sửa trực tiếp cột `checksum` trong bảng `_prisma_migrations`. Đây là việc **ngoại lệ**, không phải cách xử lý mặc định khi Prisma báo lệch: lệch checksum trước hết là dấu hiệu file migration đã bị sửa sau khi áp, và cách đúng là khôi phục file rồi đưa thay đổi vào một migration mới.

Chỉ được sửa checksum khi chứng minh được bản đã áp và bản trong git **tương đương hoàn toàn về tác dụng** — không chỉ cấu trúc bảng mà cả dữ liệu và quyền mà migration thay đổi. Cấu trúc khớp là chưa đủ, vì migration còn có thể `INSERT`/`UPDATE`/`DELETE` dữ liệu hoặc cấp và thu quyền.

## Bối cảnh

Prisma lưu SHA-256 của từng byte file `migration.sql` lúc áp. Khi file trong git khác bản đã áp, `prisma migrate dev` báo "migration was modified after it was applied" và đề nghị reset CSDL, tức xóa toàn bộ dữ liệu. `prisma migrate deploy` và `prisma migrate status` không kiểm tra điều này, nên lệch có thể nằm im rất lâu.

Ngày 30/09/2026, khi rà soát đợt chuyển sang bốn vai trò, phát hiện hai migration lệch checksum ở cả CSDL đang dùng (`pharmacy_gpp`) và CSDL kiểm thử (`pharmacy_gpp_test`). 14 migration còn lại khớp.

## Lần điều chỉnh ngày 30/09/2026

### 1. `20260930120000_four_roles_scoped_approvals`

**Nguyên nhân:** file được ghi với xuống dòng CRLF và áp ngay; khi commit, `.gitattributes` (`* text=auto eol=lf`) đổi sang LF. Nội dung không đổi, chỉ đổi byte xuống dòng.

**Bằng chứng tương đương:**

| | SHA-256 |
|---|---|
| Bản đã áp (CRLF), lưu trữ tại hồ sơ | `3cb96b46c0a6b34b862f221c0265434cdfeb99f82513ad451a29bc31b891265d` |
| Checksum Prisma đã lưu lúc áp | `3cb96b46c0a6b34b862f221c0265434cdfeb99f82513ad451a29bc31b891265d` |
| Bản đã áp sau khi bỏ ký tự CR | `9608b623c3479580067cd9aa8f907f559289662ca2603b991f585cca99712b8d` |
| Bản trong git (commit `62c63d9`) | `9608b623c3479580067cd9aa8f907f559289662ca2603b991f585cca99712b8d` |

Bản đã áp bỏ ký tự CR thì **trùng từng byte** với bản trong git (`cmp` không có khác biệt). Vì vậy mọi lệnh đều giống nhau, gồm cả các phần đổi dữ liệu và quyền của migration này: ghi audit phân công `sales_staff`, xóa phân công và vai trò `sales_staff`, cấp lại quyền bốn vai trò, thu hồi phiên đăng nhập, sửa cài đặt `discountLimitPercent`.

Đối chiếu thêm kết quả trên CSDL: số quyền của từng vai trò sau khi áp khớp cấu hình `server/src/config/permissions.ts` (admin 35, pharmacist 23, warehouse_staff 7, auditor 13), không còn vai trò `sales_staff`.

### 2. `20260923180000_batch_expiry_plans`

**Nguyên nhân:** file bị sửa một dòng chú thích sau khi đã áp, trước khi commit (23/09/2026).

**Khôi phục bản đã áp:** từ nhật ký phiên làm việc, lần ghi file lúc 2026-09-23T09:35:19Z. Bản khôi phục có SHA-256 trùng checksum Prisma đã lưu, nên đó đúng là bản đã áp.

| | SHA-256 |
|---|---|
| Bản đã áp (khôi phục), lưu trữ tại hồ sơ | `e7c1c11cb2081b09d19a994002e854f01568cda0ceee6a2cbee0f96b7285d094` |
| Checksum Prisma đã lưu lúc áp | `e7c1c11cb2081b09d19a994002e854f01568cda0ceee6a2cbee0f96b7285d094` |
| Bản trong git (commit `e7e6b25`) | `678e61b3fa512b898666ff5ffe69103ddc73ab623310b66d73026fa09a4b31c9` |

**Khác biệt duy nhất** (`diff` giữa bản đã áp và bản trong git):

```diff
-- Kế hoạch xử lý lô cận hạn / hết hạn (contract §10.8). Mỗi lô chỉ có một kế
+- Kế hoạch xử lý lô cận hạn / hết hạn (contract §10.6). Mỗi lô chỉ có một kế
```

Đó là dòng chú thích SQL, không có tác dụng khi chạy. Migration này chỉ gồm `CREATE TABLE`, `CREATE INDEX` và chú thích — không có lệnh `INSERT`, `UPDATE`, `DELETE`, `GRANT` hay `REVOKE` — nên không có phần dữ liệu hay quyền nào có thể khác. Đối chiếu thêm trên cả hai CSDL: cột, kiểu, `NOT NULL`, hai ràng buộc `CHECK`, bốn khóa ngoại và ba chỉ mục của bảng `batch_expiry_plans` khớp với bản trong git.

### Giá trị trước và sau

Cập nhật bằng `UPDATE _prisma_migrations SET checksum = '<mới>' WHERE migration_name = '<tên>' AND checksum = '<cũ>'`, mỗi CSDL đúng một dòng.

| Migration | CSDL | Trước | Sau |
|---|---|---|---|
| `20260930120000_four_roles_scoped_approvals` | `pharmacy_gpp`, `pharmacy_gpp_test` | `3cb96b46…891265d` | `9608b623…99712b8d` |
| `20260923180000_batch_expiry_plans` | `pharmacy_gpp`, `pharmacy_gpp_test` | `e7c1c11c…7285d094` | `678e61b3…9a4b31c9` |

Giá trị đầy đủ ở các bảng bằng chứng phía trên.

**Hoàn tác** (nếu cần), chạy trên từng CSDL:

```sql
UPDATE _prisma_migrations SET checksum = '3cb96b46c0a6b34b862f221c0265434cdfeb99f82513ad451a29bc31b891265d'
WHERE migration_name = '20260930120000_four_roles_scoped_approvals';
UPDATE _prisma_migrations SET checksum = 'e7c1c11cb2081b09d19a994002e854f01568cda0ceee6a2cbee0f96b7285d094'
WHERE migration_name = '20260923180000_batch_expiry_plans';
```

### Kiểm chứng sau khi điều chỉnh

- Cả 16 migration khớp checksum ở cả hai CSDL (`npm run check:migrations`).
- `prisma migrate status`: "Database schema is up to date".
- Chạy `prisma migrate dev` trên CSDL kiểm thử (không chạy trên CSDL đang dùng): không còn báo migration bị sửa. Lệnh này sau đó muốn sinh migration mới xóa các ràng buộc viết tay và chờ đặt tên; đã dừng, không có migration nào được tạo hay áp. Tiến trình con của lệnh này bị bỏ lại và giữ khóa migration trên CSDL kiểm thử khoảng 15 phút cho tới khi được dừng — lý do README nay ghi rõ không dùng `prisma migrate dev` trong dự án.

### Hồ sơ lưu trữ

Ngoài repo và ngoài thư mục sao lưu tự động của phần mềm (thư mục đó tự dọn bản cũ). Quyền truy cập đã bỏ kế thừa, chỉ còn tài khoản Windows `PHAMDUY\binma` và `SYSTEM`:
`C:\Users\binma\PharmacyBackups\2026-09-30-truoc-migration-bon-vai-tro\`

| Tệp | SHA-256 |
|---|---|
| `before.dump` — sao lưu toàn bộ `pharmacy_gpp` trước khi áp migration bốn vai trò | `d620ff6c54f43d7caee8c49a418443443af42048ceb2e5eee2a0c70c99e44039` |
| `before.json` — số bản ghi từng bảng trước khi áp | `690dbf4f5caf24ded0d8bbb11e5241c2b67aed1acc428f9714402f88f6256b66` |
| `ban-migration-da-ap/20260923180000_batch_expiry_plans.da-ap.sql` | `e7c1c11cb2081b09d19a994002e854f01568cda0ceee6a2cbee0f96b7285d094` |
| `ban-migration-da-ap/20260930120000_four_roles_scoped_approvals.da-ap.crlf.sql` | `3cb96b46c0a6b34b862f221c0265434cdfeb99f82513ad451a29bc31b891265d` |
| `ban-migration-da-ap/checksum-truoc-khi-sua.txt` | `e355ebdb04b1c5760494428f81a4cacd84c3b4added2ddfc08361ad151b8535c` |

Không đưa các tệp này lên git: bản sao lưu chứa dữ liệu thật.

## Biện pháp phòng ngừa

- `.gitattributes`: quy tắc riêng `server/prisma/migrations/**/migration.sql text eol=lf`. Trước khi thêm, đã kiểm tra cả 16 file trên máy trùng từng byte với git; `git add --renormalize` không đổi file nào, nên không phát sinh lệch mới.
- `npm run db:migrate` chạy `server/src/scripts/check-migrations.ts` trước `prisma migrate deploy`: dừng nếu có file CRLF hoặc migration đã áp bị sửa. `.gitattributes` không chặn được trường hợp file CRLF bị áp trước khi git đụng tới nó; bước kiểm tra này thì chặn được.
- README mục "Cơ sở dữ liệu và migration" ghi quy trình thêm migration viết tay, không dùng `prisma migrate dev`.
