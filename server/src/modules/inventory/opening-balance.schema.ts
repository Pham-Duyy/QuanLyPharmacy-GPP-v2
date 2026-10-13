import { z } from "zod";
import { dateKey, vnDay } from "../../lib/dates.js";

const lineSchema = z.object({
  productId: z.uuid("productId không hợp lệ"),
  unitId: z.uuid("unitId không hợp lệ"),
  quantity: z.coerce.number().int().positive("Số lượng phải lớn hơn 0"),
  batchNumber: z.string().trim().min(1, "Thiếu số lô").max(50),
  expiryDate: z.coerce
    .date()
    .refine((value) => dateKey(value) > vnDay(), "Hạn dùng phải sau hôm nay"),
  unitCost: z.coerce.number().int().min(0, "Giá vốn không được âm"),
  /** Tủ–kệ–ngăn; bỏ trống thì lấy vị trí gần nhất của cùng thuốc. */
  shelfLocation: z.string().max(60, "Vị trí tối đa 30 ký tự").nullish(),
});

export const openingBalanceSchema = z.object({
  lines: z.array(lineSchema).min(1, "Phải có ít nhất một dòng tồn đầu kỳ"),
});

export type OpeningBalanceInput = z.infer<typeof openingBalanceSchema>;
