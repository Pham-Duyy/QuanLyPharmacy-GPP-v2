-- Ca thu ngân, chốt két (bản gọn): mỗi cửa hàng một két, chỉ nhập tổng tiền.
-- Tiền mặt dự kiến tính từ hóa đơn và phiếu trả đã có, nên bán hàng không
-- phải ghi thêm gì; không chặn bán khi chưa mở ca. Chi trả nhà cung cấp không
-- tính vào két — lấy tiền két thì ghi một phiếu chi trong ca.

CREATE TABLE "cash_shifts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "store_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "opened_by" UUID NOT NULL,
  "opening_cash" BIGINT NOT NULL,
  "closed_at" TIMESTAMPTZ(6),
  "closed_by" UUID,
  -- Chụp lại lúc chốt: số đã tính không đổi dù sau này có hủy hóa đơn cũ.
  "expected_cash" BIGINT,
  "counted_cash" BIGINT,
  "difference" BIGINT,
  "close_note" TEXT,
  "summary" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "cash_shifts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cash_shifts_status_check" CHECK ("status" IN ('OPEN', 'CLOSED')),
  CONSTRAINT "cash_shifts_opening_check" CHECK ("opening_cash" >= 0),
  CONSTRAINT "cash_shifts_counted_check" CHECK ("counted_cash" IS NULL OR "counted_cash" >= 0),
  CONSTRAINT "cash_shifts_closed_check" CHECK (
    ("status" = 'OPEN' AND "closed_at" IS NULL AND "closed_by" IS NULL AND "counted_cash" IS NULL
      AND "expected_cash" IS NULL AND "difference" IS NULL)
    OR ("status" = 'CLOSED' AND "closed_at" IS NOT NULL AND "closed_by" IS NOT NULL
      AND "counted_cash" IS NOT NULL AND "expected_cash" IS NOT NULL
      AND "difference" = "counted_cash" - "expected_cash")
  ),
  -- Lệch tiền thì phải ghi lý do.
  CONSTRAINT "cash_shifts_difference_note_check" CHECK (
    "difference" IS NULL OR "difference" = 0 OR length(btrim(coalesce("close_note", ''))) > 0
  ),
  CONSTRAINT "cash_shifts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "cash_shifts_opened_by_fkey" FOREIGN KEY ("opened_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "cash_shifts_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "cash_shifts_code_key" ON "cash_shifts" ("code");
CREATE UNIQUE INDEX "cash_shifts_id_store_key" ON "cash_shifts" ("id", "store_id");
-- Mỗi cửa hàng chỉ một ca đang mở.
CREATE UNIQUE INDEX "cash_shifts_one_open_per_store" ON "cash_shifts" ("store_id") WHERE "status" = 'OPEN';
CREATE INDEX "cash_shifts_store_opened_idx" ON "cash_shifts" ("store_id", "opened_at" DESC);

-- Phiếu thu/chi tiền mặt khác trong ca. Ghi sai thì ghi phiếu ngược lại, không sửa, không xóa.
CREATE TABLE "cash_movements" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shift_id" UUID NOT NULL,
  "store_id" UUID NOT NULL,
  "direction" TEXT NOT NULL,
  "amount" BIGINT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cash_movements_direction_check" CHECK ("direction" IN ('IN', 'OUT')),
  CONSTRAINT "cash_movements_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "cash_movements_reason_check" CHECK (length(btrim("reason")) > 0),
  -- Khóa ngoại tổ hợp: phiếu luôn thuộc đúng cửa hàng của ca.
  CONSTRAINT "cash_movements_shift_store_fkey" FOREIGN KEY ("shift_id", "store_id") REFERENCES "cash_shifts" ("id", "store_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "cash_movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "cash_movements_shift_idx" ON "cash_movements" ("shift_id", "created_at");

-- Mở/chốt ca, ghi thu chi: Quản lý và Dược sĩ (người đứng quầy).
INSERT INTO "permissions" ("code", "description")
VALUES ('cash_shift.manage', 'Mở, chốt ca thu ngân và ghi thu chi tiền mặt trong ca')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT "id", 'cash_shift.manage' FROM "roles" WHERE "code" IN ('admin', 'pharmacist')
ON CONFLICT DO NOTHING;
