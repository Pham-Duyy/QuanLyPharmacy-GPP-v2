-- Ba nhóm sửa lỗi đi cùng nhau vì đều đụng tới dữ liệu đã có:
--   1. Bộ đếm mã chứng từ (thay cho COUNT(*) + 1 dễ trùng khi tạo song song).
--   2. Giá vốn chụp tại thời điểm xuất hàng, để báo cáo kỳ cũ không đổi số.
--   3. Khóa idempotency gắn với chứng từ đã ghi và với cửa hàng.

-- 1. Bộ đếm mã chứng từ -----------------------------------------------------
-- `scope` là toàn bộ phần đầu của mã, gồm cả dấu gạch cuối, ví dụ
-- 'HD-NT01-20260926-'. Mỗi dải mã một hàng, tăng bằng INSERT ... ON CONFLICT
-- nên hai transaction không thể lấy trùng số.
CREATE TABLE "document_counters" (
  "store_id" UUID NOT NULL,
  "scope" TEXT NOT NULL,
  "next_value" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "document_counters_pkey" PRIMARY KEY ("store_id", "scope"),
  CONSTRAINT "document_counters_next_value_check" CHECK ("next_value" >= 0),
  CONSTRAINT "document_counters_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Nạp bộ đếm từ chứng từ đã có: nếu không làm bước này, chứng từ tạo sau khi
-- nâng cấp sẽ bắt đầu lại từ 0001 và đụng ràng buộc unique của mã.
INSERT INTO "document_counters" ("store_id", "scope", "next_value")
SELECT "store_id", left("code", length("code") - 4) AS scope, MAX(right("code", 4)::int)
FROM (
  SELECT "store_id", "code" FROM "invoices"
  UNION ALL SELECT "store_id", "code" FROM "returns"
  UNION ALL SELECT "store_id", "code" FROM "goods_receipts"
  UNION ALL SELECT "store_id", "code" FROM "stock_adjustments"
  UNION ALL SELECT "store_id", "code" FROM "stock_counts"
  UNION ALL SELECT "store_id", "code" FROM "supplier_payments"
  UNION ALL SELECT "store_id", "code" FROM "supplier_returns"
  UNION ALL SELECT "store_id", "code" FROM "prescriptions"
) AS existing
-- Chỉ nhận mã đúng định dạng '<tiền tố>-NNNN'; mã nhập tay lạ kiểu bị bỏ qua
-- để không làm hỏng bộ đếm.
WHERE "code" ~ '^.+-[0-9]{4}$'
GROUP BY "store_id", left("code", length("code") - 4);

-- 2. Giá vốn tại thời điểm xuất --------------------------------------------
-- Trước đây báo cáo lãi gộp lấy `batches.unit_cost` hiện tại, nên nhập thêm
-- cùng lô với giá khác sẽ làm đổi cả số liệu kỳ đã chốt. Từ nay mỗi lần xuất
-- chụp lại giá vốn của lô.
ALTER TABLE "invoice_allocations" ADD COLUMN "unit_cost" DECIMAL(18, 4);

COMMENT ON COLUMN "invoice_allocations"."unit_cost" IS
  'Giá vốn của lô tại đúng thời điểm xuất hàng. NULL với dữ liệu phát sinh trước bản nâng cấp này: báo cáo sẽ lùi về giá vốn hiện tại của lô, không suy diễn lại.';

-- 3. Khóa idempotency ------------------------------------------------------
-- store_id vào khóa định danh: cùng một người, cùng một khóa nhưng khác cửa
-- hàng là hai yêu cầu khác nhau.
ALTER TABLE "idempotency_keys" ADD COLUMN "store_id" UUID;
-- Chứng từ đã ghi được của yêu cầu này. Có giá trị nghĩa là nghiệp vụ ĐÃ
-- commit, tuyệt đối không được xóa khóa để client gửi lại lần nữa.
ALTER TABLE "idempotency_keys" ADD COLUMN "resource_type" TEXT;
ALTER TABLE "idempotency_keys" ADD COLUMN "resource_id" TEXT;

ALTER TABLE "idempotency_keys"
  ADD CONSTRAINT "idempotency_keys_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
