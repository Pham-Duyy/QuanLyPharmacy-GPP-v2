-- Cách dùng ghi trên nhãn khi bán lẻ thuốc ngoài bao bì gốc (GPP, TT 02/2018
-- Phụ lục I mục II.3d): liều dùng, số lần dùng, cách dùng. Lưu theo dòng hóa
-- đơn để in lại vẫn đúng nội dung đã ghi lúc bán.
ALTER TABLE "invoice_lines" ADD COLUMN "usage_instruction" TEXT;
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_usage_instruction_length"
  CHECK ("usage_instruction" IS NULL OR char_length("usage_instruction") <= 300);
