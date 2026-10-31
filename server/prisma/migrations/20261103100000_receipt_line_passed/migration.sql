-- Kết quả kiểm nhập của từng dòng phiếu nhập (Phase 7, D32): dòng không đạt vẫn
-- vào lô biệt trữ nên không suy ra được từ batch_id. Đơn đặt hàng chỉ tính dòng đạt
-- là đã nhận. Phiếu cũ để NULL (không gắn với đơn đặt hàng nào).
ALTER TABLE "goods_receipt_lines" ADD COLUMN "passed" BOOLEAN;
