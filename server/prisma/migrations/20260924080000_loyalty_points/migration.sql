-- Tích điểm khách hàng thân thiết.
-- Điểm được ghi dạng sổ bút toán, KHÔNG lưu số dư tổng trên bảng khách hàng:
-- số dư luôn tính lại từ sổ nên hủy hóa đơn, trả hàng hay điều chỉnh tay
-- đều không thể làm lệch số dư.
CREATE TABLE "loyalty_transactions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "invoice_id" UUID,
  "return_id" UUID,
  -- EARN: tích khi mua; REDEEM: đổi điểm lấy giảm giá (điểm âm);
  -- REVERSE: trả lại điểm khi hủy hóa đơn hoặc khách trả hàng;
  -- ADJUST: nhân viên điều chỉnh tay, bắt buộc có lý do.
  "type" TEXT NOT NULL,
  "points" INTEGER NOT NULL,
  -- Doanh thu (đồng) đã dùng để tính ra số điểm, giữ lại để đối chiếu.
  "amount" BIGINT,
  "expires_at" TIMESTAMPTZ(6),
  "note" TEXT,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "loyalty_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "loyalty_transactions_type_check" CHECK ("type" IN ('EARN', 'REDEEM', 'REVERSE', 'ADJUST')),
  -- Bút toán 0 điểm không có ý nghĩa, chặn ngay ở CSDL.
  CONSTRAINT "loyalty_transactions_points_check" CHECK ("points" <> 0),
  CONSTRAINT "loyalty_transactions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "loyalty_transactions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "loyalty_transactions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "loyalty_transactions_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "returns" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "loyalty_transactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "loyalty_transactions_customer_id_created_at_idx" ON "loyalty_transactions" ("customer_id", "created_at");
CREATE INDEX "loyalty_transactions_invoice_id_idx" ON "loyalty_transactions" ("invoice_id");

-- Một hóa đơn chỉ tích điểm một lần và chỉ đổi điểm một lần.
CREATE UNIQUE INDEX "loyalty_transactions_invoice_id_type_key"
  ON "loyalty_transactions" ("invoice_id", "type")
  WHERE "type" IN ('EARN', 'REDEEM');

-- Số điểm khách đã đổi trên hóa đơn, tách khỏi giảm giá của nhân viên để
-- báo cáo doanh thu vẫn phân biệt được hai loại giảm giá.
ALTER TABLE "invoices"
  ADD COLUMN "loyalty_points_redeemed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "loyalty_discount_amount" BIGINT NOT NULL DEFAULT 0;

-- Quyền mới (contract §4.1): cộng trừ điểm tay là đụng vào tiền của khách.
INSERT INTO "permissions" ("code", "description")
VALUES ('loyalty.manage', 'Điều chỉnh điểm tích lũy của khách bằng tay')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT "id", 'loyalty.manage' FROM "roles" WHERE "code" IN ('admin', 'pharmacist')
ON CONFLICT DO NOTHING;
