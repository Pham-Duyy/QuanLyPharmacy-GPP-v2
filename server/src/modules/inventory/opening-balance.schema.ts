import { z } from "zod";
import { lineQuantity, money, withinYearsAhead } from "../../lib/validators.js";
import { dateKey, vnDay } from "../../lib/dates.js";

const lineSchema = z.object({
  productId: z.uuid("productId không hợp lệ"),
  unitId: z.uuid("unitId không hợp lệ"),
  quantity: lineQuantity(),
  batchNumber: z.string().trim().min(1, "Thiếu số lô").max(50),
  expiryDate: z.coerce
    .date()
    .refine((value) => dateKey(value) > vnDay(), "Hạn dùng phải sau hôm nay")
    .refine((value) => withinYearsAhead(value), "Hạn dùng xa quá 10 năm — kiểm tra lại năm"),
  unitCost: money("Giá vốn"),
  /** Tủ–kệ–ngăn; bỏ trống thì lấy vị trí gần nhất của cùng thuốc. */
  shelfLocation: z.string().max(60, "Vị trí tối đa 30 ký tự").nullish(),
});

export const openingBalanceSchema = z.object({
  lines: z.array(lineSchema).min(1, "Phải có ít nhất một dòng tồn đầu kỳ"),
});

export type OpeningBalanceInput = z.infer<typeof openingBalanceSchema>;
