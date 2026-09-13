import { z } from "zod";

const recallItemSchema = z.object({
  productId: z.uuid("productId không hợp lệ"),
  batchNumber: z.string().trim().min(1, "Thiếu số lô").max(50),
});

export const createRecallSchema = z.object({
  documentNumber: z.string().trim().min(1, "Thiếu số công văn").max(100),
  issuedBy: z.string().trim().max(200).nullish(),
  issuedAt: z.coerce.date(),
  reason: z.string().trim().max(1000).nullish(),
  items: z.array(recallItemSchema).min(1, "Thông báo thu hồi phải có ít nhất một lô"),
});

export type CreateRecallInput = z.infer<typeof createRecallSchema>;
