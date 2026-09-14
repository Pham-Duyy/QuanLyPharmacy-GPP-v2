import { z } from "zod";

const lineSchema = z.object({
  productId: z.uuid("productId không hợp lệ"),
  unitId: z.uuid("unitId không hợp lệ"),
  quantity: z.coerce.number().int().positive("Số lượng phải lớn hơn 0"),
  batchNumber: z.string().trim().min(1, "Thiếu số lô").max(50),
  expiryDate: z.coerce
    .date()
    .refine((value) => value.getTime() > Date.now(), "Hạn dùng phải sau hôm nay"),
  unitCost: z.coerce.number().int().min(0, "Giá vốn không được âm"),
});

export const openingBalanceSchema = z.object({
  lines: z.array(lineSchema).min(1, "Phải có ít nhất một dòng tồn đầu kỳ"),
});

export type OpeningBalanceInput = z.infer<typeof openingBalanceSchema>;
