import { z } from "zod";

const lineSchema = z.object({
  productId: z.uuid("productId không hợp lệ"),
  unitId: z.uuid("unitId không hợp lệ"),
  quantity: z.coerce.number().int().positive("Số lượng phải lớn hơn 0"),
  unitCost: z.coerce.number().int().min(0, "Giá nhập không được âm"),
  batchNumber: z.string().trim().min(1, "Thiếu số lô").max(50),
  manufactureDate: z.coerce.date().nullish(),
  expiryDate: z.coerce
    .date()
    .refine((value) => value.getTime() > Date.now(), "Hạn dùng phải sau hôm nay"),
});

export const createReceiptSchema = z.object({
  supplierId: z.uuid("supplierId không hợp lệ"),
  supplierInvoiceNumber: z.string().trim().max(50).nullish(),
  supplierInvoiceDate: z.coerce.date().nullish(),
  receivedAt: z.coerce.date().default(() => new Date()),
  note: z.string().trim().max(500).nullish(),
  lines: z.array(lineSchema).min(1, "Phiếu nhập phải có ít nhất một dòng"),
});

export const cancelSchema = z.object({
  reason: z.string().trim().min(1, "Phải ghi lý do hủy phiếu").max(500),
});

export type CreateReceiptInput = z.infer<typeof createReceiptSchema>;
