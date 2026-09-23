-- Công nợ nhà cung cấp (contract §9.1): kỳ hạn thanh toán, hạn trả của từng
-- phiếu nhập, và phiếu chi trả tiền có phân bổ về từng phiếu.

ALTER TABLE "suppliers" ADD COLUMN "payment_term_days" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_payment_term_days_check" CHECK ("payment_term_days" >= 0 AND "payment_term_days" <= 365);

ALTER TABLE "goods_receipts" ADD COLUMN "payment_due_date" DATE;

-- Phiếu nhập đã kiểm nhập từ trước: lấy hạn trả theo kỳ hạn hiện tại của nhà
-- cung cấp (mặc định 0 ngày = ngày nhận hàng), để công nợ cũ vẫn có hạn.
UPDATE "goods_receipts" r
SET "payment_due_date" = (r."received_at" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + COALESCE(s."payment_term_days", 0)
FROM "suppliers" s
WHERE r."supplier_id" = s."id" AND r."status" = 'CONFIRMED' AND r."type" = 'PURCHASE';

CREATE TABLE "supplier_payments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "paid_at" DATE NOT NULL,
  "amount" BIGINT NOT NULL,
  "method" TEXT NOT NULL DEFAULT 'BANK_TRANSFER',
  "reference" TEXT,
  "note" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "void_reason" TEXT,
  "voided_by" UUID,
  "voided_at" TIMESTAMPTZ(6),
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_payments_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "supplier_payments_method_check" CHECK ("method" IN ('CASH', 'BANK_TRANSFER')),
  CONSTRAINT "supplier_payments_status_check" CHECK ("status" IN ('ACTIVE', 'VOIDED')),
  CONSTRAINT "supplier_payments_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "supplier_payments_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "supplier_payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "supplier_payments_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "supplier_payments_code_key" ON "supplier_payments" ("code");
CREATE INDEX "supplier_payments_store_id_supplier_id_idx" ON "supplier_payments" ("store_id", "supplier_id");
CREATE INDEX "supplier_payments_store_id_paid_at_idx" ON "supplier_payments" ("store_id", "paid_at" DESC);

CREATE TABLE "supplier_payment_allocations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "payment_id" UUID NOT NULL,
  "goods_receipt_id" UUID NOT NULL,
  "amount" BIGINT NOT NULL,
  CONSTRAINT "supplier_payment_allocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_payment_allocations_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "supplier_payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "supplier_payments" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "supplier_payment_allocations_goods_receipt_id_fkey" FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Một phiếu chi không phân bổ hai dòng vào cùng một phiếu nhập.
CREATE UNIQUE INDEX "supplier_payment_allocations_payment_id_goods_receipt_id_key" ON "supplier_payment_allocations" ("payment_id", "goods_receipt_id");
CREATE INDEX "supplier_payment_allocations_goods_receipt_id_idx" ON "supplier_payment_allocations" ("goods_receipt_id");

-- Quyền mới (contract §4.1): xem công nợ là dữ liệu tiền, trả tiền là việc của chủ nhà thuốc.
INSERT INTO "permissions" ("code", "description")
VALUES
  ('supplier_debt.read', 'Xem công nợ nhà cung cấp'),
  ('supplier_payment.manage', 'Ghi nhận thanh toán cho nhà cung cấp')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT "id", 'supplier_debt.read' FROM "roles" WHERE "code" IN ('admin', 'auditor')
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT "id", 'supplier_payment.manage' FROM "roles" WHERE "code" = 'admin'
ON CONFLICT DO NOTHING;
