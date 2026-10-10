-- Bán thuốc theo mã đơn thuốc điện tử (Hệ thống đơn thuốc quốc gia, tài liệu
-- kết nối theo Quyết định 808/QĐ-BYT, mục VIII "Lấy đơn thuốc" và IX "Cập nhật
-- số lượng bán"). Contract §12.1.

-- 1. Cấu hình -------------------------------------------------------------
-- app-name/app-key cấp cho ĐƠN VỊ LÀM PHẦN MỀM (không phải từng nhà thuốc), nên
-- là cấu hình toàn chuỗi, đúng một dòng.
CREATE TABLE "eprescription_config" (
  "id" SMALLINT NOT NULL DEFAULT 1,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "app_name" TEXT,
  "app_key_cipher" TEXT,
  "updated_by" UUID,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "eprescription_config_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "eprescription_config_single_row" CHECK ("id" = 1),
  CONSTRAINT "eprescription_config_enabled_needs_key" CHECK (NOT "enabled" OR ("app_name" IS NOT NULL AND "app_key_cipher" IS NOT NULL)),
  CONSTRAINT "eprescription_config_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Mã định danh cơ sở cung ứng thuốc: riêng từng cửa hàng, gửi kèm khi báo đã bán.
CREATE TABLE "eprescription_store_configs" (
  "store_id" UUID NOT NULL,
  "facility_code" TEXT NOT NULL,
  "updated_by" UUID,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "eprescription_store_configs_pkey" PRIMARY KEY ("store_id"),
  CONSTRAINT "eprescription_store_configs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "eprescription_store_configs_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- 2. Đơn thuốc lấy từ hệ thống quốc gia ------------------------------------
ALTER TABLE "prescriptions" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_source_check" CHECK ("source" IN ('MANUAL', 'NATIONAL'));
-- Người bệnh ghi trên đơn điện tử (đơn có thể không gắn hồ sơ khách của nhà thuốc).
ALTER TABLE "prescriptions" ADD COLUMN "patient_name" TEXT;
ALTER TABLE "prescriptions" ADD COLUMN "patient_birth_date" TEXT;
-- Bản gốc trả về từ hệ thống quốc gia, giữ nguyên để đối chiếu.
ALTER TABLE "prescriptions" ADD COLUMN "national_payload" JSONB;
-- Một mã đơn điện tử chỉ lấy về một lần trong toàn chuỗi.
CREATE UNIQUE INDEX "prescriptions_national_code_key" ON "prescriptions" ("external_code") WHERE "source" = 'NATIONAL';

ALTER TABLE "prescription_items" ADD COLUMN "national_drug_code" TEXT;
ALTER TABLE "prescription_items" ADD COLUMN "national_unit_name" TEXT;
ALTER TABLE "prescription_items" ADD COLUMN "national_quantity" NUMERIC(12, 2);

-- 3. Ghép mã thuốc trên đơn quốc gia với sản phẩm: ghép một lần, lần sau tự khớp.
CREATE TABLE "eprescription_drug_links" (
  "national_drug_code" TEXT NOT NULL,
  "product_id" UUID NOT NULL,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "eprescription_drug_links_pkey" PRIMARY KEY ("national_drug_code"),
  CONSTRAINT "eprescription_drug_links_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "eprescription_drug_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- 4. Hàng đợi báo "đã bán" lên hệ thống quốc gia -------------------------------
-- Mỗi hóa đơn bán theo đơn điện tử một việc. Tạo bởi lượt quét định kỳ, không
-- tạo trong giao dịch bán: hệ thống quốc gia lỗi không làm chậm hay chặn việc bán.
CREATE TABLE "eprescription_dispense_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "prescription_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_error" TEXT,
  "sent_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "eprescription_dispense_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "eprescription_dispense_jobs_status_check"
    CHECK ("status" IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'REJECTED', 'CANCELLED', 'NEEDS_REVIEW')),
  CONSTRAINT "eprescription_dispense_jobs_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "eprescription_dispense_jobs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "eprescription_dispense_jobs_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "eprescription_dispense_jobs_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescriptions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "eprescription_dispense_jobs_invoice_key" ON "eprescription_dispense_jobs" ("invoice_id");
CREATE INDEX "eprescription_dispense_jobs_status_idx" ON "eprescription_dispense_jobs" ("status", "next_attempt_at");
