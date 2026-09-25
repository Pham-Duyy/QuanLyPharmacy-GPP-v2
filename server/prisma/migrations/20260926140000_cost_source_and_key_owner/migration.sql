-- 1. Nguồn gốc của giá vốn đã chụp trên từng dòng phân bổ ------------------
-- Báo cáo lãi gộp không được phép đổi số khi giá vốn của lô thay đổi. Trước
-- đây dòng phân bổ cũ (unit_cost NULL) vẫn lấy giá vốn hiện tại của lô làm
-- dự phòng, nên nhập thêm cùng lô là lãi gộp kỳ cũ nhảy theo.
--
-- Từ nay mỗi dòng phân bổ nói rõ giá vốn của nó đáng tin tới đâu:
--   ACTUAL    - chụp đúng lúc xuất hàng.
--   ESTIMATED - dữ liệu cũ, lấy một lần giá vốn của lô tại thời điểm nâng cấp
--               này và đóng băng tại đó; là ƯỚC TÍNH, không phải số lịch sử.
--   UNKNOWN   - không khôi phục được (lô không có giá vốn); không suy diễn.
ALTER TABLE "invoice_allocations" ADD COLUMN "unit_cost_source" TEXT;

UPDATE "invoice_allocations" SET "unit_cost_source" = 'ACTUAL' WHERE "unit_cost" IS NOT NULL;

UPDATE "invoice_allocations" ia
SET "unit_cost" = b."unit_cost", "unit_cost_source" = 'ESTIMATED'
FROM "batches" b
WHERE b."id" = ia."batch_id" AND ia."unit_cost" IS NULL AND b."unit_cost" IS NOT NULL;

UPDATE "invoice_allocations" SET "unit_cost_source" = 'UNKNOWN' WHERE "unit_cost_source" IS NULL;

ALTER TABLE "invoice_allocations"
  ALTER COLUMN "unit_cost_source" SET DEFAULT 'UNKNOWN',
  ALTER COLUMN "unit_cost_source" SET NOT NULL,
  ADD CONSTRAINT "invoice_allocations_unit_cost_source_check"
    CHECK ("unit_cost_source" IN ('ACTUAL', 'ESTIMATED', 'UNKNOWN'));

COMMENT ON COLUMN "invoice_allocations"."unit_cost_source" IS
  'ACTUAL: chụp lúc xuất hàng. ESTIMATED: ước tính một lần từ giá vốn lô khi nâng cấp. UNKNOWN: không xác định, báo cáo phải nói rõ.';

-- 2. Quyền sở hữu khóa idempotency ----------------------------------------
-- Khóa treo quá hạn được phép tiếp quản, nhưng phải tiếp quản NGUYÊN TỬ: hai
-- request cùng thấy khóa cũ thì chỉ một request được nhận, request còn lại
-- không được ghi đè hay xóa khóa của người đã nhận.
ALTER TABLE "idempotency_keys" ADD COLUMN "owner_token" UUID;

UPDATE "idempotency_keys" SET "owner_token" = gen_random_uuid() WHERE "owner_token" IS NULL;

ALTER TABLE "idempotency_keys"
  ALTER COLUMN "owner_token" SET DEFAULT gen_random_uuid(),
  ALTER COLUMN "owner_token" SET NOT NULL;
