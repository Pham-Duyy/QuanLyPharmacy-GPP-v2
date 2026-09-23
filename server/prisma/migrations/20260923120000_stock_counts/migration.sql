-- Đợt kiểm kê kho: chụp danh sách lô cần đếm, ghi số đếm thực tế, chốt thành
-- một phiếu điều chỉnh tồn chờ duyệt (contract §10.5).
CREATE TABLE "stock_counts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'COUNTING',
  "scope_type" TEXT NOT NULL DEFAULT 'ALL',
  "scope_value" TEXT,
  "scope_label" TEXT,
  "note" TEXT,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_by" UUID NOT NULL,
  "closed_by" UUID,
  "closed_at" TIMESTAMPTZ(6),
  "adjustment_id" UUID,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_counts_status_check" CHECK ("status" IN ('COUNTING', 'CLOSED', 'CANCELLED')),
  CONSTRAINT "stock_counts_scope_type_check" CHECK ("scope_type" IN ('ALL', 'CATEGORY', 'SHELF')),
  CONSTRAINT "stock_counts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_counts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_counts_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_counts_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "stock_adjustments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "stock_counts_code_key" ON "stock_counts" ("code");
CREATE UNIQUE INDEX "stock_counts_adjustment_id_key" ON "stock_counts" ("adjustment_id");
CREATE INDEX "stock_counts_store_id_status_idx" ON "stock_counts" ("store_id", "status");

-- Mỗi cửa hàng chỉ có một đợt đang đếm: hai đợt song song sẽ đếm chồng nhau
-- và sinh ra hai phiếu điều chỉnh mâu thuẫn trên cùng một lô.
CREATE UNIQUE INDEX "stock_counts_one_open_per_store" ON "stock_counts" ("store_id") WHERE "status" = 'COUNTING';

CREATE TABLE "stock_count_lines" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "stock_count_id" UUID NOT NULL,
  "line_no" INTEGER NOT NULL,
  "batch_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "shelf_location" TEXT,
  "system_base_quantity_at_open" INTEGER NOT NULL,
  "system_base_quantity_at_count" INTEGER,
  "counted_unit_id" UUID,
  "counted_quantity" INTEGER,
  "counted_base_quantity" INTEGER,
  "counted_at" TIMESTAMPTZ(6),
  "counted_by" UUID,
  "note" TEXT,
  CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_count_lines_counted_quantity_check" CHECK ("counted_quantity" IS NULL OR "counted_quantity" >= 0),
  CONSTRAINT "stock_count_lines_stock_count_id_fkey" FOREIGN KEY ("stock_count_id") REFERENCES "stock_counts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "stock_count_lines_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batches" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_count_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_count_lines_counted_unit_id_fkey" FOREIGN KEY ("counted_unit_id") REFERENCES "product_units" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_count_lines_counted_by_fkey" FOREIGN KEY ("counted_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "stock_count_lines_stock_count_id_line_no_key" ON "stock_count_lines" ("stock_count_id", "line_no");
CREATE UNIQUE INDEX "stock_count_lines_stock_count_id_batch_id_key" ON "stock_count_lines" ("stock_count_id", "batch_id");
CREATE INDEX "stock_count_lines_batch_id_idx" ON "stock_count_lines" ("batch_id");
