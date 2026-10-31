import { z } from "zod";
import { lineQuantity } from "../../lib/validators.js";

const returnLineSchema = z.object({
  invoiceLineId: z.uuid("invoiceLineId không hợp lệ"),
  allocationId: z.uuid("allocationId không hợp lệ").nullish(),
  unitId: z.uuid("unitId không hợp lệ"),
  quantity: lineQuantity("Số lượng trả"),
});

export const createReturnSchema = z.object({
  reason: z.string().trim().max(500).nullish(),
  disposition: z.enum(["RESTOCK", "DISPOSE"]),
  refundMethod: z.enum(["CASH", "BANK_TRANSFER", "CARD"]).default("CASH"),
  lines: z.array(returnLineSchema).min(1, "Phiếu trả phải có ít nhất một dòng"),
});

export type CreateReturnInput = z.infer<typeof createReturnSchema>;
