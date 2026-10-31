-- Đơn đặt hàng gửi nhà cung cấp (Phase 7, D32).

ALTER TABLE "suppliers" ADD COLUMN "email" TEXT;

CREATE TABLE "purchase_orders" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "supplier_id" UUID NOT NULL,
  -- DRAFT nháp · SENT đã gửi · PARTIAL nhận một phần · RECEIVED đã nhận đủ · CANCELLED đã hủy
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "expected_date" DATE,
  "note" TEXT,
  -- Tổng tiền tạm tính theo đơn giá dự kiến; giá thật ghi ở phiếu nhập.
  "estimated_amount" BIGINT NOT NULL DEFAULT 0,
  "created_by" UUID NOT NULL,
  "sent_at" TIMESTAMPTZ(6),
  "sent_by" UUID,
  -- EMAIL gửi từ phần mềm · MANUAL tự gửi (in, PDF, Excel qua Zalo…)
  "sent_via" TEXT,
  "sent_to" TEXT,
  "cancelled_at" TIMESTAMPTZ(6),
  "cancelled_by" UUID,
  "cancel_reason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "purchase_orders_status_check"
    CHECK ("status" IN ('DRAFT', 'SENT', 'PARTIAL', 'RECEIVED', 'CANCELLED')),
  CONSTRAINT "purchase_orders_sent_via_check" CHECK ("sent_via" IS NULL OR "sent_via" IN ('EMAIL', 'MANUAL')),
  CONSTRAINT "purchase_orders_sent_check" CHECK ("status" IN ('DRAFT', 'CANCELLED') OR "sent_at" IS NOT NULL),
  CONSTRAINT "purchase_orders_amount_check" CHECK ("estimated_amount" >= 0),
  CONSTRAINT "purchase_orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "purchase_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "purchase_orders_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "purchase_orders_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "purchase_orders_code_key" ON "purchase_orders" ("code");
CREATE INDEX "purchase_orders_store_status_idx" ON "purchase_orders" ("store_id", "status", "created_at" DESC);

CREATE TABLE "purchase_order_lines" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "purchase_order_id" UUID NOT NULL,
  "line_no" INTEGER NOT NULL,
  "product_id" UUID NOT NULL,
  "product_unit_id" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "base_quantity" INTEGER NOT NULL,
  -- Đơn giá dự kiến theo đơn vị đặt (giá lần nhập gần nhất hoặc giá NCC báo); có thể trống.
  "unit_price" BIGINT,
  CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "purchase_order_lines_quantity_check" CHECK ("quantity" > 0 AND "base_quantity" > 0),
  CONSTRAINT "purchase_order_lines_price_check" CHECK ("unit_price" IS NULL OR "unit_price" >= 0),
  CONSTRAINT "purchase_order_lines_order_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "purchase_order_lines_product_fkey" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "purchase_order_lines_unit_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "product_units" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "purchase_order_lines_order_line_key" ON "purchase_order_lines" ("purchase_order_id", "line_no");
-- Một sản phẩm một dòng trong mỗi đơn: số đã nhận đối chiếu theo sản phẩm.
CREATE UNIQUE INDEX "purchase_order_lines_order_product_key" ON "purchase_order_lines" ("purchase_order_id", "product_id");

-- Phiếu nhập lập từ đơn đặt hàng.
ALTER TABLE "goods_receipts" ADD COLUMN "purchase_order_id" UUID;
ALTER TABLE "goods_receipts"
  ADD CONSTRAINT "goods_receipts_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "goods_receipts_purchase_order_id_idx" ON "goods_receipts" ("purchase_order_id");
