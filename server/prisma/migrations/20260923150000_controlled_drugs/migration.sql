-- Bán thuốc kiểm soát đặc biệt: bắt buộc ghi thông tin người mua (quy định về
-- thuốc gây nghiện, hướng thần, tiền chất) và quyền đọc sổ theo dõi.
CREATE TABLE "controlled_sale_details" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "invoice_id" UUID NOT NULL,
  "buyer_name" TEXT NOT NULL,
  "buyer_id_number" TEXT NOT NULL,
  "buyer_address" TEXT NOT NULL,
  "buyer_phone" TEXT,
  "relationship" TEXT NOT NULL DEFAULT 'SELF',
  "relationship_note" TEXT,
  "recorded_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "controlled_sale_details_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "controlled_sale_details_relationship_check" CHECK ("relationship" IN ('SELF', 'RELATIVE', 'CAREGIVER', 'OTHER')),
  CONSTRAINT "controlled_sale_details_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "controlled_sale_details_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "controlled_sale_details_invoice_id_key" ON "controlled_sale_details" ("invoice_id");

INSERT INTO "permissions" ("code", "description")
VALUES ('controlled.read', 'Xem sổ theo dõi thuốc kiểm soát đặc biệt')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT "id", 'controlled.read' FROM "roles" WHERE "code" IN ('admin', 'pharmacist', 'auditor')
ON CONFLICT DO NOTHING;
