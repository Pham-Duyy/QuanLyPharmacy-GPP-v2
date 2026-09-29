-- Liên thông Hệ thống Cơ sở dữ liệu về Dược (csdlduoc.com.vn), đặc tả API v1.1.
--
-- Bốn nhóm bảng:
--   1. Cấu hình kết nối (một dòng duy nhất cho cả cơ sở).
--   2. Bộ nhớ đệm danh mục quốc gia: thuốc và đơn vị tính.
--   3. Bảng ghép mã: thuốc trong danh mục của nhà thuốc <-> mã thuốc quốc gia.
--   4. Hộp thư đi: từng chứng từ cần gửi, trạng thái xử lý phía quốc gia.
--
-- Nguyên tắc: **không chạm vào giao dịch bán hàng và nhập hàng**. Việc gửi dữ
-- liệu là hậu kiểm, đọc lại chính chứng từ đã lưu, nên hệ thống quốc gia có
-- sập hay mạng có đứt thì bán hàng vẫn chạy và không mất chứng từ nào.

-- 1. Cấu hình kết nối -------------------------------------------------------
-- Một cơ sở dược một tài khoản liên thông (tài khoản do chính nhà thuốc đăng
-- ký trên cổng, đơn vị làm phần mềm không được đăng ký hộ), nên bảng này chỉ
-- có đúng một dòng: khóa chính là hằng TRUE.
CREATE TABLE "national_sync_config" (
  "id"                   BOOLEAN     PRIMARY KEY DEFAULT TRUE,
  "enabled"              BOOLEAN     NOT NULL DEFAULT FALSE,
  "environment"          TEXT        NOT NULL DEFAULT 'SANDBOX',
  "username"             TEXT,
  -- Mật khẩu không lưu thô: AES-256-GCM, khóa dẫn xuất từ JWT_SECRET.
  "password_cipher"      TEXT,
  -- Mã giấy phép hành nghề, dùng khi tài khoản mẹ gửi thay cho cơ sở thành viên.
  "practice_license_code" TEXT,
  -- Mốc bắt đầu liên thông. Hệ thống quốc gia chỉ ghi nhận chứng từ phát sinh
  -- SAU ngày của phiếu kiểm hàng đầu kỳ, nên chứng từ cũ hơn mốc này không gửi.
  "start_date"           DATE,
  "last_master_sync_at"  TIMESTAMPTZ(6),
  "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_by"           UUID,
  CONSTRAINT "national_sync_config_single_row" CHECK ("id"),
  CONSTRAINT "national_sync_config_environment_check"
    CHECK ("environment" IN ('SANDBOX', 'PRODUCTION')),
  CONSTRAINT "national_sync_config_updated_by_fkey"
    FOREIGN KEY ("updated_by") REFERENCES "users"("id")
);

COMMENT ON TABLE "national_sync_config" IS
  'Cấu hình liên thông CSDL Dược quốc gia; đúng một dòng cho cả cơ sở.';
COMMENT ON COLUMN "national_sync_config"."start_date" IS
  'Ngày phiếu kiểm hàng đầu kỳ. Chứng từ trước ngày này không gửi lên.';

INSERT INTO "national_sync_config" ("id") VALUES (TRUE);

-- 2. Bộ nhớ đệm danh mục quốc gia ------------------------------------------
-- API quốc gia không có cơ chế thông báo khi danh mục đổi; phần mềm phải tự
-- kiểm tra qua last_update_time. Lưu đệm tại đây để ghép mã và tra cứu được
-- kể cả khi không có mạng, và để không gọi API mỗi lần bán hàng.
CREATE TABLE "national_drugs" (
  "id"                       TEXT PRIMARY KEY,
  "name"                     TEXT NOT NULL,
  "drug_group_id"            TEXT,
  "registration_number"      TEXT,
  "old_registration_number"  TEXT,
  "active_ingredient"        TEXT,
  "strength"                 TEXT,
  -- 0: không kê đơn, 1: kê đơn (theo đặc tả prescription_status).
  "prescription_status"      SMALLINT,
  -- 0..6 theo đặc tả special_control_type (thuốc kiểm soát đặc biệt).
  "special_control_type"     SMALLINT,
  "manufacturer_id"          TEXT,
  "manufacturer_name"        TEXT,
  "manufacturer_country"     TEXT,
  -- Mảng quy cách đóng gói: [{ unit_id, unit_name, gtin }]
  "packagings"               JSONB NOT NULL DEFAULT '[]'::jsonb,
  "last_update_time"         TIMESTAMPTZ(6),
  "synced_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX "national_drugs_registration_number_idx"
  ON "national_drugs" ("registration_number");
CREATE INDEX "national_drugs_name_idx" ON "national_drugs" (lower("name"));

CREATE TABLE "national_units" (
  "id"        TEXT PRIMARY KEY,
  "name"      TEXT NOT NULL,
  "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- 3. Ghép mã thuốc ---------------------------------------------------------
-- Số lượng gửi lên luôn quy về ĐƠN VỊ CƠ BẢN của mặt hàng, vì thẻ kho và phân
-- bổ lô của phần mềm đều tính theo đơn vị cơ bản. Nhờ vậy mỗi mặt hàng chỉ
-- cần ghép một lần, không phải ghép cho từng đơn vị quy đổi.
CREATE TABLE "national_drug_links" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id"   UUID NOT NULL,
  "drug_id"      TEXT NOT NULL,
  "unit_id"      TEXT NOT NULL,
  "gtin"         TEXT,
  -- REGISTRATION_NUMBER | NAME | MANUAL: ghép tự động theo số đăng ký, theo
  -- tên, hay do người dùng tự chọn. Chỉ MANUAL và bản đã xác nhận mới được
  -- dùng để gửi dữ liệu thật.
  "matched_by"   TEXT NOT NULL,
  "confirmed_by" UUID,
  "confirmed_at" TIMESTAMPTZ(6),
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "national_drug_links_product_id_key" UNIQUE ("product_id"),
  CONSTRAINT "national_drug_links_matched_by_check"
    CHECK ("matched_by" IN ('REGISTRATION_NUMBER', 'NAME', 'MANUAL')),
  CONSTRAINT "national_drug_links_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE,
  CONSTRAINT "national_drug_links_confirmed_by_fkey"
    FOREIGN KEY ("confirmed_by") REFERENCES "users"("id")
);

COMMENT ON TABLE "national_drug_links" IS
  'Ghép mặt hàng của nhà thuốc với mã thuốc quốc gia; số lượng gửi theo đơn vị cơ bản.';

-- 4. Hộp thư đi ------------------------------------------------------------
-- Mỗi chứng từ cần liên thông là một dòng. Payload được dựng lại từ chứng từ
-- ngay trước khi gửi, nên dữ liệu gửi đi luôn khớp chứng từ hiện tại.
--
-- Hệ thống quốc gia KHÔNG có API xóa: sửa là gửi lại cùng reference_number.
-- Vì vậy khóa duy nhất theo (kind, source_type, source_id): một chứng từ chỉ
-- có một dòng, gửi lại thì cập nhật chính dòng đó.
CREATE TABLE "national_sync_jobs" (
  "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id"              UUID NOT NULL,
  "kind"                  TEXT NOT NULL,
  "source_type"           TEXT NOT NULL,
  "source_id"             UUID NOT NULL,
  "reference_number"      TEXT NOT NULL,
  "reason"                TEXT NOT NULL,
  "document_date"         DATE NOT NULL,
  "status"                TEXT NOT NULL DEFAULT 'PENDING',
  "attempts"              INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "remote_transaction_id" TEXT,
  -- Payload đã gửi lần gần nhất, giữ lại để đối chiếu khi bị từ chối.
  "sent_payload"          JSONB,
  "last_error"            TEXT,
  -- Mảng thông báo do hệ thống quốc gia trả về ở API xem trạng thái.
  "messages"              JSONB,
  "submitted_at"          TIMESTAMPTZ(6),
  "settled_at"            TIMESTAMPTZ(6),
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "national_sync_jobs_source_key" UNIQUE ("kind", "source_type", "source_id"),
  CONSTRAINT "national_sync_jobs_kind_check"
    CHECK ("kind" IN ('STOCK_IN', 'STOCK_OUT', 'STOCK_TAKING')),
  -- PENDING     chờ gửi
  -- SENDING     đang gửi (chống hai tiến trình cùng gửi một chứng từ)
  -- ACCEPTED    quốc gia đã tiếp nhận, chờ xử lý
  -- PROCESSING  quốc gia đang xử lý
  -- COMPLETED   xử lý xong
  -- REJECTED    quốc gia từ chối vì dữ liệu không tuân thủ
  -- FAILED      gửi thất bại (mạng, lỗi hệ thống) — sẽ thử lại
  -- BLOCKED     thiếu điều kiện để gửi, ví dụ chưa ghép mã thuốc
  -- NEEDS_REVIEW chứng từ đổi sau khi đã gửi, phải xử lý bằng tay
  CONSTRAINT "national_sync_jobs_status_check"
    CHECK ("status" IN ('PENDING', 'SENDING', 'ACCEPTED', 'PROCESSING',
                        'COMPLETED', 'REJECTED', 'FAILED', 'BLOCKED', 'NEEDS_REVIEW')),
  CONSTRAINT "national_sync_jobs_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "national_sync_jobs_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id")
);

-- Lấy việc tới hạn: lọc theo trạng thái rồi xếp theo mốc thử lại.
CREATE INDEX "national_sync_jobs_queue_idx"
  ON "national_sync_jobs" ("status", "next_attempt_at");
CREATE INDEX "national_sync_jobs_store_created_idx"
  ON "national_sync_jobs" ("store_id", "created_at" DESC);

-- 5. Quyền ------------------------------------------------------------------
INSERT INTO "permissions" ("code", "description") VALUES
  ('national_sync.read',   'Xem trạng thái liên thông CSDL Dược quốc gia'),
  ('national_sync.manage', 'Cấu hình kết nối, ghép mã thuốc và gửi dữ liệu lên CSDL Dược quốc gia')
ON CONFLICT ("code") DO NOTHING;

-- Chủ nhà thuốc và dược sĩ phụ trách chuyên môn: chịu trách nhiệm dữ liệu dược.
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r."id", p."permission_code"
FROM "roles" r
CROSS JOIN (VALUES ('national_sync.read'), ('national_sync.manage')) AS p("permission_code")
WHERE r."code" IN ('admin', 'pharmacist')
ON CONFLICT DO NOTHING;

-- Kiểm toán chỉ đọc.
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT "id", 'national_sync.read' FROM "roles" WHERE "code" = 'auditor'
ON CONFLICT DO NOTHING;
