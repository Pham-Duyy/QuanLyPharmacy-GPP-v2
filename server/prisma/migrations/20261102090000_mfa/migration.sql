-- Xác thực hai lớp bằng mã TOTP (Phase 7, D31).
-- Khóa bí mật lưu đã mã hóa (AES-256-GCM, khóa dẫn xuất từ JWT_SECRET), không lưu thô.
ALTER TABLE "users"
  ADD COLUMN "mfa_secret_enc" TEXT,
  ADD COLUMN "mfa_pending_secret_enc" TEXT,
  ADD COLUMN "mfa_enabled_at" TIMESTAMPTZ(6),
  -- Bước thời gian (30 giây) của mã đã dùng gần nhất: một mã không dùng được hai lần.
  ADD COLUMN "mfa_last_step" BIGINT,
  ADD CONSTRAINT "users_mfa_enabled_has_secret"
    CHECK ("mfa_enabled_at" IS NULL OR "mfa_secret_enc" IS NOT NULL);

-- Mã dự phòng dùng một lần khi mất điện thoại; chỉ lưu bản băm.
CREATE TABLE "mfa_recovery_codes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "code_hash" TEXT NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "mfa_recovery_codes_user_id_idx" ON "mfa_recovery_codes" ("user_id");
