-- Tài khoản CHỈ ĐỌC cho analytics-service (Phase 5, bước 5.5; quyết định D22).
-- Quản trị chạy MỘT lần bằng tài khoản chủ CSDL, sau khi đã áp migration
-- 20261031150000_analytics_source_views. Đổi mật khẩu trước khi chạy:
--
--   psql "$DATABASE_URL" -v reader_password="'mat-khau-manh'" -f prisma/sql/analytics-reader.sql
--
-- Tài khoản này chỉ đọc được 4 view trong schema analytics_src (không thấy bảng
-- khách hàng, đơn thuốc, người dùng...). View chạy với quyền của chủ view nên không
-- cần cấp quyền trên bảng gốc.

CREATE ROLE analytics_reader LOGIN PASSWORD :reader_password;
GRANT USAGE ON SCHEMA analytics_src TO analytics_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics_src TO analytics_reader;
ALTER ROLE analytics_reader SET default_transaction_read_only = on;
ALTER ROLE analytics_reader SET statement_timeout = '60s';
