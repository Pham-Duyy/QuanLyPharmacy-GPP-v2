import { z } from "zod";

const cartLineSchema = z.object({
  productId: z.uuid("productId không hợp lệ"),
  unitId: z.uuid("unitId không hợp lệ"),
  quantity: z.coerce.number().int().positive("Số lượng phải lớn hơn 0"),
});

export const safetyCheckSchema = z.object({
  customerId: z.uuid("customerId không hợp lệ").nullish(),
  prescriptionId: z.uuid("prescriptionId không hợp lệ").nullish(),
  lines: z.array(cartLineSchema).min(1, "Giỏ hàng phải có ít nhất một dòng"),
});

const saleLineSchema = cartLineSchema
  .extend({
    batchId: z.uuid("batchId không hợp lệ").nullish(),
    batchOverrideReason: z.string().trim().max(500).nullish(),
    prescriptionItemId: z.uuid("prescriptionItemId không hợp lệ").nullish(),
  })
  .refine((line) => !line.batchId || Boolean(line.batchOverrideReason), {
    message: "Chỉ định lô khác thứ tự FEFO thì phải ghi lý do",
    path: ["batchOverrideReason"],
  });

const discountSchema = z
  .object({
    type: z.enum(["PERCENT", "AMOUNT"]),
    value: z.coerce.number().positive("Giá trị giảm phải lớn hơn 0"),
    reason: z.string().trim().min(1, "Phải ghi lý do giảm giá").max(500),
  })
  .refine((discount) => discount.type !== "PERCENT" || discount.value <= 100, {
    message: "Phần trăm giảm không vượt quá 100",
    path: ["value"],
  });

/**
 * Máy khách chỉ gửi ý định bán. Đơn giá, thành tiền, VAT, lô FEFO và người
 * bán đều do máy chủ tự tính, gửi lên cũng bị bỏ qua (contract §14.1).
 */
export const createInvoiceSchema = z.object({
  customerId: z.uuid("customerId không hợp lệ").nullish(),
  prescriptionId: z.uuid("prescriptionId không hợp lệ").nullish(),
  lines: z.array(saleLineSchema).min(1, "Hóa đơn phải có ít nhất một dòng"),
  discount: discountSchema.nullish(),
  acknowledgedWarnings: z
    .array(
      z.object({
        code: z.string().trim().min(1).max(50),
        productIds: z.array(z.uuid()).default([]),
        reason: z.string().trim().max(500).nullish(),
      }),
    )
    .default([]),
  payment: z
    .object({
      method: z.enum(["CASH", "BANK_TRANSFER", "CARD"]).default("CASH"),
      amountTendered: z.coerce.number().int().min(0).nullish(),
    })
    .default({ method: "CASH" }),
});

export const voidInvoiceSchema = z.object({
  reason: z.string().trim().min(1, "Phải ghi lý do hủy hóa đơn").max(500),
});

export type SafetyCheckInput = z.infer<typeof safetyCheckSchema>;
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
