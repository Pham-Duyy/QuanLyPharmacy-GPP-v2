-- Trả hàng nhà cung cấp (contract §9.2): hàng rời khỏi kho nên phải trừ tồn
-- và ghi thẻ kho; tất toán bằng cách trừ công nợ, nhận lại tiền hoặc đổi hàng.

ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_type_check";
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type_check"
  CHECK ("type" IN ('RECEIPT', 'OPENING_BALANCE', 'SALE', 'SALE_VOID', 'CUSTOMER_RETURN', 'ADJUSTMENT', 'DISPOSAL', 'SUPPLIER_RETURN'));

CREATE TABLE "supplier_returns" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "reason" TEXT NOT NULL,
  "settlement" TEXT NOT NULL DEFAULT 'DEDUCT_DEBT',
  "note" TEXT,
  "total_value" BIGINT NOT NULL DEFAULT 0,
  "returned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_by" UUID NOT NULL,
  "confirmed_by" UUID,
  "confirmed_at" TIMESTAMPTZ(6),
  "cancelled_by" UUID,
  "cancelled_at" TIMESTAMPTZ(6),
  "cancel_reason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "supplier_returns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_returns_status_check" CHECK ("status" IN ('DRAFT', 'CONFIRMED', 'CANCELLED')),
  CONSTRAINT "supplier_returns_settlement_check" CHECK ("settlement" IN ('DEDUCT_DEBT', 'REFUND', 'REPLACEMENT')),
  CONSTRAINT "supplier_returns_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "supplier_returns_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "supplier_returns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "supplier_returns_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "supplier_returns_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "supplier_returns_code_key" ON "supplier_returns" ("code");
CREATE INDEX "supplier_returns_store_id_status_idx" ON "supplier_returns" ("store_id", "status");
CREATE INDEX "supplier_returns_supplier_id_idx" ON "supplier_returns" ("supplier_id");

CREATE TABLE "supplier_return_lines" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "supplier_return_id" UUID NOT NULL,
  "line_no" INTEGER NOT NULL,
  "batch_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "product_unit_id" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "base_quantity" INTEGER NOT NULL,
  "unit_cost" BIGINT NOT NULL DEFAULT 0,
  "line_value" BIGINT NOT NULL DEFAULT 0,
  -- Phiếu nhập đã mang lô này về, dùng để trừ đúng khoản công nợ.
  "goods_receipt_id" UUID,
  "note" TEXT,
  CONSTRAINT "supplier_return_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_return_lines_quantity_check" CHECK ("quantity" > 0 AND "base_quantity" > 0),
  CONSTRAINT "supplier_return_lines_return_fkey" FOREIGN KEY ("supplier_return_id") REFERENCES "supplier_returns" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "supplier_return_lines_batch_fkey" FOREIGN KEY ("batch_id") REFERENCES "batches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "supplier_return_lines_product_fkey" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "supplier_return_lines_unit_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "product_units" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "supplier_return_lines_receipt_fkey" FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "supplier_return_lines_return_line_no_key" ON "supplier_return_lines" ("supplier_return_id", "line_no");
CREATE INDEX "supplier_return_lines_batch_id_idx" ON "supplier_return_lines" ("batch_id");
CREATE INDEX "supplier_return_lines_goods_receipt_id_idx" ON "supplier_return_lines" ("goods_receipt_id");
