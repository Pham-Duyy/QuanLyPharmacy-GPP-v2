-- Gỡ tính năng sao lưu dữ liệu trong ứng dụng (màn Sao lưu dữ liệu, lịch chạy
-- tự động, quyền backup.manage). Theo dõi thao tác dùng Nhật ký hệ thống;
-- sao lưu CSDL làm bằng tay theo README.
--
-- Dòng nhật ký BACKUP_RUN cũ trong audit_logs được giữ nguyên.

-- Quyền: gỡ khỏi vai trò trước, rồi xóa mã quyền.
DELETE FROM "role_permissions" WHERE "permission_code" = 'backup.manage';
DELETE FROM "permissions" WHERE "code" = 'backup.manage';

-- Cài đặt lịch sao lưu (nếu đã từng lưu).
DELETE FROM "settings" WHERE "key" = 'backupSettings';

-- Lịch sử các lượt sao lưu.
DROP TABLE "backups";
