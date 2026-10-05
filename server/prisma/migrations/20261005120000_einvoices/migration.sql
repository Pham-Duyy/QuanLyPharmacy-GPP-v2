-- Hóa đơn điện tử khởi tạo từ máy tính tiền, phát hành qua nhà cung cấp dịch
-- vụ hóa đơn (hiện có MISA meInvoice). Nghị định 70/2025: bán lẻ trực tiếp
-- cho người tiêu dùng phải dùng hóa đơn từ máy tính tiền có kết nối cơ quan thuế.
--
-- Giống liên thông CSDL Dược: phát hành là hậu kiểm, không nằm trong đường
-- bán hàng. Bán xong hóa đơn vào hàng đợi; mất mạng vẫn bán, có mạng lại thì
-- hàng đợi tự phát hành.

-- 1. Cấu hình theo cửa hàng: mỗi cơ sở có mã số thuế, ký hiệu hóa đơn, tài khoản riêng.
CREATE TABLE "einvoice_store_configs" (
  "store_id"        UUID        PRIMARY KEY,
  "enabled"         BOOLEAN     NOT NULL DEFAULT FALSE,
  "provider"        TEXT        NOT NULL DEFAULT 'MISA',
  "environment"     TEXT        NOT NULL DEFAULT 'SANDBOX',
  "app_id"          TEXT,
  "tax_code"        TEXT,
  "username"        TEXT,
  -- Mật khẩu không lưu thô: AES-256-GCM, khóa dẫn xuất từ JWT_SECRET.
  "password_cipher" TEXT,
  -- Ký hiệu hóa đơn máy tính tiền đã đăng ký với cơ quan thuế, ví dụ 1C26MAB.
  "inv_series"      TEXT,
  -- Chỉ phát hành cho hóa đơn bán từ thời điểm bật trở đi; không phát hành hồi tố.
  "enabled_from"    TIMESTAMPTZ(6),
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_by"      UUID,
  CONSTRAINT "einvoice_store_configs_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id"),
  CONSTRAINT "einvoice_store_configs_updated_by_fkey"
    FOREIGN KEY ("updated_by") REFERENCES "users"("id"),
  CONSTRAINT "einvoice_store_configs_provider_check" CHECK ("provider" IN ('MISA')),
  CONSTRAINT "einvoice_store_configs_environment_check"
    CHECK ("environment" IN ('SANDBOX', 'PRODUCTION')),
  CONSTRAINT "einvoice_store_configs_enabled_needs_account"
    CHECK (NOT "enabled" OR ("app_id" IS NOT NULL AND "tax_code" IS NOT NULL
      AND "username" IS NOT NULL AND "password_cipher" IS NOT NULL
      AND "inv_series" IS NOT NULL AND "enabled_from" IS NOT NULL))
);

-- 2. Hóa đơn điện tử: đúng một bản ghi cho mỗi hóa đơn bán.
CREATE TABLE "e_invoices" (
  "id"                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id"           UUID        NOT NULL,
  "invoice_id"         UUID        NOT NULL,
  -- PENDING: chờ phát hành; SENDING: đang gửi; PUBLISHED: nhà cung cấp đã phát
  -- hành, chờ mã cơ quan thuế; COMPLETED: đã có mã cơ quan thuế; FAILED: lỗi
  -- tạm thời, sẽ thử lại; REJECTED: dữ liệu bị từ chối hoặc cơ quan thuế từ
  -- chối cấp mã; CANCELLED: hóa đơn bán bị hủy trước khi phát hành.
  "status"             TEXT        NOT NULL DEFAULT 'PENDING',
  "attempts"           INTEGER     NOT NULL DEFAULT 0,
  "next_attempt_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "inv_series"         TEXT,
  "inv_no"             TEXT,
  -- Mã tra cứu của nhà cung cấp (TransactionID).
  "transaction_id"     TEXT,
  -- Mã của cơ quan thuế cấp cho hóa đơn.
  "tax_authority_code" TEXT,
  "sent_payload"       JSONB,
  "last_error"         TEXT,
  -- Khác null: hóa đơn đã phát hành rồi bị hủy hoặc trả hàng, cần lập hóa đơn
  -- điều chỉnh/thay thế. Phần mềm không tự suy diễn chứng từ điều chỉnh.
  "review_reason"      TEXT,
  "published_at"       TIMESTAMPTZ(6),
  "settled_at"         TIMESTAMPTZ(6),
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "e_invoices_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id"),
  CONSTRAINT "e_invoices_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id"),
  CONSTRAINT "e_invoices_invoice_id_key" UNIQUE ("invoice_id"),
  CONSTRAINT "e_invoices_status_check" CHECK ("status" IN
    ('PENDING', 'SENDING', 'PUBLISHED', 'COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT "e_invoices_attempts_check" CHECK ("attempts" >= 0)
);

CREATE INDEX "e_invoices_store_status_idx" ON "e_invoices" ("store_id", "status", "next_attempt_at");

-- 3. Quyền cấu hình và thao tác hóa đơn điện tử: chỉ Quản lý.
INSERT INTO "permissions" ("code", "description")
VALUES ('einvoice.manage', 'Cấu hình và phát hành hóa đơn điện tử')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT "id", 'einvoice.manage' FROM "roles" WHERE "code" = 'admin'
ON CONFLICT DO NOTHING;
