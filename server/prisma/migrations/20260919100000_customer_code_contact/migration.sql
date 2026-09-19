-- Mã khách hàng (KH00001...), email, địa chỉ. Khách cũ được cấp mã theo thứ tự tạo;
-- không đổi dữ liệu nào khác.
ALTER TABLE "customers" ADD COLUMN "code" TEXT;
ALTER TABLE "customers" ADD COLUMN "email" TEXT;
ALTER TABLE "customers" ADD COLUMN "address" TEXT;

CREATE SEQUENCE "customer_code_seq" OWNED BY "customers"."code";

WITH ordered AS (
  SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS rn FROM "customers"
)
UPDATE "customers" c
SET "code" = 'KH' || lpad(o.rn::text, 5, '0')
FROM ordered o
WHERE o."id" = c."id";

SELECT setval(
  '"customer_code_seq"',
  GREATEST((SELECT count(*) FROM "customers"), 1),
  (SELECT count(*) FROM "customers") > 0
);

ALTER TABLE "customers"
  ALTER COLUMN "code" SET DEFAULT ('KH'::text || lpad((nextval('customer_code_seq'::regclass))::text, 5, '0'::text)),
  ALTER COLUMN "code" SET NOT NULL;

CREATE UNIQUE INDEX "customers_code_key" ON "customers"("code");
