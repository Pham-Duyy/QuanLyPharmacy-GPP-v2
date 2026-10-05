-- Liên thông CSDL Dược theo từng cơ sở.
--
-- Mỗi cơ sở bán lẻ được cấp tài khoản liên thông riêng (Công văn 934/TTYQG,
-- 12/08/2026). Một dòng cấu hình chung cho cả chuỗi sẽ gửi chứng từ của mọi
-- cửa hàng bằng một tài khoản, nên tài khoản, mật khẩu, mã giấy phép, môi
-- trường và mốc bắt đầu chuyển sang bảng theo cửa hàng.
--
-- Bảng cũ "national_sync_config" chỉ còn phần dùng chung toàn chuỗi: mốc đồng
-- bộ danh mục thuốc quốc gia (danh mục và ghép mã dùng chung cho cả chuỗi).

CREATE TABLE "national_sync_store_configs" (
  "store_id"              UUID        PRIMARY KEY,
  "enabled"               BOOLEAN     NOT NULL DEFAULT FALSE,
  "environment"           TEXT        NOT NULL DEFAULT 'SANDBOX',
  "username"              TEXT,
  -- Mật khẩu không lưu thô: AES-256-GCM, khóa dẫn xuất từ JWT_SECRET.
  "password_cipher"       TEXT,
  "practice_license_code" TEXT,
  -- Ngày phiếu kiểm hàng đầu kỳ của cửa hàng; chứng từ trước ngày này không gửi.
  "start_date"            DATE,
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_by"            UUID,
  CONSTRAINT "national_sync_store_configs_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id"),
  CONSTRAINT "national_sync_store_configs_updated_by_fkey"
    FOREIGN KEY ("updated_by") REFERENCES "users"("id"),
  CONSTRAINT "national_sync_store_configs_environment_check"
    CHECK ("environment" IN ('SANDBOX', 'PRODUCTION')),
  -- Bật liên thông mà thiếu tài khoản thì bộ chạy nền lỗi vòng lặp.
  CONSTRAINT "national_sync_store_configs_enabled_needs_account"
    CHECK (NOT "enabled" OR ("username" IS NOT NULL AND "password_cipher" IS NOT NULL))
);

-- Chuyển cấu hình cũ: chỉ khi chuỗi có đúng một cửa hàng thì cấu hình chung
-- chắc chắn thuộc cửa hàng đó. Nhiều cửa hàng thì KHÔNG chép tài khoản sang
-- cửa hàng nào (không đoán), từng cửa hàng phải tự cấu hình lại.
INSERT INTO "national_sync_store_configs"
  ("store_id", "enabled", "environment", "username", "password_cipher",
   "practice_license_code", "start_date", "updated_at", "updated_by")
SELECT s."id", c."enabled", c."environment", c."username", c."password_cipher",
       c."practice_license_code", c."start_date", c."updated_at", c."updated_by"
FROM "national_sync_config" c
CROSS JOIN "stores" s
WHERE (SELECT count(*) FROM "stores") = 1
  AND (c."username" IS NOT NULL OR c."start_date" IS NOT NULL OR c."enabled");

ALTER TABLE "national_sync_config"
  DROP COLUMN "enabled",
  DROP COLUMN "environment",
  DROP COLUMN "username",
  DROP COLUMN "password_cipher",
  DROP COLUMN "practice_license_code",
  DROP COLUMN "start_date";

COMMENT ON TABLE "national_sync_config" IS
  'Phần liên thông dùng chung toàn chuỗi: mốc đồng bộ danh mục thuốc quốc gia.';
COMMENT ON TABLE "national_sync_store_configs" IS
  'Cấu hình liên thông CSDL Dược của từng cửa hàng: tài khoản, giấy phép, mốc bắt đầu.';
