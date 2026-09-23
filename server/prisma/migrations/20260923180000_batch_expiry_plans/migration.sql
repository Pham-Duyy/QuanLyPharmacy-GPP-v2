-- Kế hoạch xử lý lô cận hạn / hết hạn (contract §10.6). Mỗi lô chỉ có một kế
-- hoạch đang mở, để danh sách cảnh báo không bị nhân đôi.
CREATE TABLE "batch_expiry_plans" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "batch_id" UUID NOT NULL,
  "store_id" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PLANNED',
  "due_date" DATE,
  "note" TEXT,
  "outcome" TEXT,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "resolved_by" UUID,
  "resolved_at" TIMESTAMPTZ(6),
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "batch_expiry_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "batch_expiry_plans_action_check" CHECK ("action" IN ('RETURN_SUPPLIER', 'PRIORITIZE_SALE', 'DISCOUNT', 'DISPOSE')),
  CONSTRAINT "batch_expiry_plans_status_check" CHECK ("status" IN ('PLANNED', 'DONE', 'CANCELLED')),
  CONSTRAINT "batch_expiry_plans_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batches" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "batch_expiry_plans_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "batch_expiry_plans_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "batch_expiry_plans_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "batch_expiry_plans_store_id_status_idx" ON "batch_expiry_plans" ("store_id", "status");
CREATE INDEX "batch_expiry_plans_batch_id_idx" ON "batch_expiry_plans" ("batch_id");

-- Một lô chỉ có một kế hoạch đang mở: hai kế hoạch song song trên cùng một lô
-- sẽ mâu thuẫn (vừa hẹn trả nhà cung cấp vừa hẹn hủy).
CREATE UNIQUE INDEX "batch_expiry_plans_one_open_per_batch" ON "batch_expiry_plans" ("batch_id") WHERE "status" = 'PLANNED';
