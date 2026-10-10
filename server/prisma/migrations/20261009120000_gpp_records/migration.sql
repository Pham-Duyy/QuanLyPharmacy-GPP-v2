-- Hồ sơ GPP còn thiếu (TT 02/2018 Phụ lục I):
--   1. Sổ khiếu nại và theo dõi phản ứng có hại của thuốc (ADR) — mục III.4.
--   2. Thu hồi: ghi lại đã liên hệ khách mua lô bị thu hồi — mục III.4c.
--   3. Kiểm tra chất lượng cảm quan định kỳ, ghép vào đợt kiểm kê — mục III.3.

-- 1. Sổ khiếu nại / ADR ------------------------------------------------------
CREATE TABLE "quality_reports" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  -- COMPLAINT: khiếu nại về thuốc (chất lượng, nhầm thuốc…); ADR: phản ứng có hại.
  "kind" TEXT NOT NULL,
  "occurred_on" DATE NOT NULL,
  "product_id" UUID,
  "batch_id" UUID,
  -- Người phản ánh / người dùng thuốc: chỉ ghi khi cần liên hệ lại.
  "reporter_name" TEXT,
  "reporter_phone" TEXT,
  "description" TEXT NOT NULL,
  "action_taken" TEXT,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  -- ADR: ngày đã gửi báo cáo về Trung tâm DI&ADR quốc gia (phần mềm không tự gửi).
  "adr_reported_on" DATE,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "closed_by" UUID,
  "closed_at" TIMESTAMPTZ(6),
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "quality_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "quality_reports_kind_check" CHECK ("kind" IN ('COMPLAINT', 'ADR')),
  CONSTRAINT "quality_reports_status_check" CHECK ("status" IN ('OPEN', 'CLOSED')),
  CONSTRAINT "quality_reports_closed_check" CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL)),
  CONSTRAINT "quality_reports_adr_only" CHECK ("kind" = 'ADR' OR "adr_reported_on" IS NULL),
  CONSTRAINT "quality_reports_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "quality_reports_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "quality_reports_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "quality_reports_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "quality_reports_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "quality_reports_code_key" ON "quality_reports" ("code");
CREATE INDEX "quality_reports_store_status_idx" ON "quality_reports" ("store_id", "status", "occurred_on");

-- Ghi sổ: Quản lý và Dược sĩ; Kiểm toán xem bằng audit.read.
INSERT INTO "permissions" ("code", "description")
VALUES ('quality_report.manage', 'Ghi sổ khiếu nại và phản ứng có hại của thuốc')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT "id", 'quality_report.manage' FROM "roles" WHERE "code" IN ('admin', 'pharmacist')
ON CONFLICT DO NOTHING;

-- 2. Thu hồi: đã liên hệ khách ---------------------------------------------
CREATE TABLE "recall_contacts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "recall_id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "contacted_by" UUID NOT NULL,
  "contacted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "note" TEXT,
  CONSTRAINT "recall_contacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recall_contacts_recall_id_fkey" FOREIGN KEY ("recall_id") REFERENCES "recalls" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recall_contacts_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "recall_contacts_contacted_by_fkey" FOREIGN KEY ("contacted_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "recall_contacts_recall_invoice_key" ON "recall_contacts" ("recall_id", "invoice_id");

-- 3. Cảm quan khi kiểm kê ----------------------------------------------------
ALTER TABLE "stock_count_lines" ADD COLUMN "sensory_failed" BOOLEAN NOT NULL DEFAULT false;
