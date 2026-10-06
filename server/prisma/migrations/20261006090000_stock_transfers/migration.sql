-- Chuyển hàng giữa các cửa hàng trong chuỗi (contract §10.9).
--
-- Hai bước, hai người: cửa hàng gửi xác nhận xuất (trừ tồn, hàng "đang chuyển"),
-- cửa hàng nhận kiểm nhập rồi mới cộng tồn. Hàng đang trên đường không thuộc tồn
-- của cửa hàng nào; phiếu chuyển là nơi duy nhất giữ số hàng đó.

ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_type_check";
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type_check"
  CHECK ("type" IN ('RECEIPT', 'OPENING_BALANCE', 'SALE', 'SALE_VOID', 'CUSTOMER_RETURN', 'ADJUSTMENT', 'DISPOSAL', 'SUPPLIER_RETURN',
                    'TRANSFER_OUT', 'TRANSFER_IN', 'TRANSFER_CANCEL'));

CREATE TABLE "stock_transfers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" TEXT NOT NULL,
  "from_store_id" UUID NOT NULL,
  "to_store_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "note" TEXT,
  -- Giá vốn hàng chuyển, chụp lúc xuất kho.
  "total_value" BIGINT NOT NULL DEFAULT 0,
  "created_by" UUID NOT NULL,
  "shipped_by" UUID,
  "shipped_at" TIMESTAMPTZ(6),
  "received_by" UUID,
  "received_at" TIMESTAMPTZ(6),
  "receive_note" TEXT,
  "cancelled_by" UUID,
  "cancelled_at" TIMESTAMPTZ(6),
  "cancel_reason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_transfers_status_check" CHECK ("status" IN ('DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED')),
  CONSTRAINT "stock_transfers_distinct_stores" CHECK ("from_store_id" <> "to_store_id"),
  -- Đã nhận thì phải đã xuất; đang chuyển thì phải có người xuất.
  CONSTRAINT "stock_transfers_shipped_check" CHECK ("status" NOT IN ('IN_TRANSIT', 'RECEIVED') OR "shipped_at" IS NOT NULL),
  CONSTRAINT "stock_transfers_received_check" CHECK (("status" = 'RECEIVED') = ("received_at" IS NOT NULL)),
  CONSTRAINT "stock_transfers_from_store_fkey" FOREIGN KEY ("from_store_id") REFERENCES "stores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_transfers_to_store_fkey" FOREIGN KEY ("to_store_id") REFERENCES "stores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_transfers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_transfers_shipped_by_fkey" FOREIGN KEY ("shipped_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_transfers_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_transfers_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "stock_transfers_code_key" ON "stock_transfers" ("code");
CREATE INDEX "stock_transfers_from_store_status_idx" ON "stock_transfers" ("from_store_id", "status");
CREATE INDEX "stock_transfers_to_store_status_idx" ON "stock_transfers" ("to_store_id", "status");

CREATE TABLE "stock_transfer_lines" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "stock_transfer_id" UUID NOT NULL,
  "line_no" INTEGER NOT NULL,
  -- Lô xuất ở cửa hàng gửi. Số lô, hạn dùng chép lại để dựng lô ở cửa hàng nhận.
  "source_batch_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "product_unit_id" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "base_quantity" INTEGER NOT NULL,
  "batch_number" TEXT NOT NULL,
  "manufacture_date" DATE,
  "expiry_date" DATE NOT NULL,
  -- Giá vốn mỗi đơn vị cơ bản lúc xuất. NULL: lô chưa có giá vốn, không suy diễn.
  "unit_cost" DECIMAL(18, 4),
  -- Kết quả kiểm nhập ở cửa hàng nhận.
  "received_base_quantity" INTEGER,
  "passed" BOOLEAN,
  "reject_reason" TEXT,
  "destination_batch_id" UUID,
  CONSTRAINT "stock_transfer_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_transfer_lines_quantity_check" CHECK ("quantity" > 0 AND "base_quantity" > 0),
  -- Nhận không vượt số đã gửi; phần thiếu là hao hụt khi chuyển.
  CONSTRAINT "stock_transfer_lines_received_check" CHECK ("received_base_quantity" IS NULL OR "received_base_quantity" BETWEEN 0 AND "base_quantity"),
  CONSTRAINT "stock_transfer_lines_transfer_fkey" FOREIGN KEY ("stock_transfer_id") REFERENCES "stock_transfers" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "stock_transfer_lines_source_batch_fkey" FOREIGN KEY ("source_batch_id") REFERENCES "batches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_transfer_lines_destination_batch_fkey" FOREIGN KEY ("destination_batch_id") REFERENCES "batches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_transfer_lines_product_fkey" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_transfer_lines_unit_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "product_units" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "stock_transfer_lines_transfer_line_no_key" ON "stock_transfer_lines" ("stock_transfer_id", "line_no");
-- Một lô chỉ xuất hiện một lần trên một phiếu: gộp số lượng thay vì hai dòng.
CREATE UNIQUE INDEX "stock_transfer_lines_transfer_batch_key" ON "stock_transfer_lines" ("stock_transfer_id", "source_batch_id");
CREATE INDEX "stock_transfer_lines_source_batch_id_idx" ON "stock_transfer_lines" ("source_batch_id");
CREATE INDEX "stock_transfer_lines_destination_batch_id_idx" ON "stock_transfer_lines" ("destination_batch_id");

-- Quyền: lập và xuất ở cửa hàng gửi; nhận ở cửa hàng nhận. Quản lý và Nhân viên kho.
INSERT INTO "permissions" ("code", "description")
VALUES
  ('stock.transfer.create', 'Lập, xuất và hủy phiếu chuyển hàng sang cửa hàng khác'),
  ('stock.transfer.receive', 'Nhận và kiểm nhập hàng chuyển đến từ cửa hàng khác')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r."id", p."code"
FROM "roles" r
CROSS JOIN (VALUES ('stock.transfer.create'), ('stock.transfer.receive')) AS p ("code")
WHERE r."code" IN ('admin', 'warehouse_staff')
ON CONFLICT DO NOTHING;
