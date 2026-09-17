-- Chiết khấu phiếu và thuế theo hóa đơn nhà cung cấp.
ALTER TABLE "goods_receipts"
  ADD COLUMN "goods_amount" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "discount_amount" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "vat_amount" BIGINT NOT NULL DEFAULT 0;

-- Phiếu cũ chưa có chiết khấu/thuế: tiền hàng bằng đúng tổng giá trị đã lưu.
UPDATE "goods_receipts" SET "goods_amount" = "total_cost";

-- Viết tay: Prisma không mô tả được CHECK.
ALTER TABLE "goods_receipts"
  ADD CONSTRAINT "goods_receipts_amounts_non_negative"
    CHECK ("goods_amount" >= 0 AND "discount_amount" >= 0 AND "vat_amount" >= 0),
  ADD CONSTRAINT "goods_receipts_discount_within_goods"
    CHECK ("discount_amount" <= "goods_amount"),
  ADD CONSTRAINT "goods_receipts_total_consistent"
    CHECK ("total_cost" = "goods_amount" - "discount_amount" + "vat_amount");
