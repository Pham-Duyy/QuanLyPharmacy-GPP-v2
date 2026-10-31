import { z } from "zod";
import { MAX_LINE_QUANTITY, lineQuantity } from "../../lib/validators.js";

/**
 * Mỗi dòng gửi đúng một trong hai hình dạng theo `reasonCode` (contract §10.3):
 * `COUNT_DIFFERENCE` gửi `countedQuantity`; các lý do xuất hủy còn lại gửi
 * `quantity`. CSDL có CHECK ràng buộc y hệt, `refine` ở đây chỉ để trả lỗi
 * đọc được thay vì để rơi xuống tầng CSDL.
 */
const lineSchema = z
  .object({
    batchId: z.uuid("batchId không hợp lệ"),
    unitId: z.uuid("unitId không hợp lệ"),
    reasonCode: z.enum([
      "COUNT_DIFFERENCE",
      "DAMAGED",
      "EXPIRED_DISPOSAL",
      "RECALL_DISPOSAL",
      "OTHER",
    ]),
    countedQuantity: z.coerce.number().int().min(0).max(MAX_LINE_QUANTITY).nullish(),
    quantity: lineQuantity().nullish(),
  })
  .refine(
    (line) =>
      line.reasonCode === "COUNT_DIFFERENCE"
        ? line.countedQuantity != null && line.quantity == null
        : line.quantity != null && line.countedQuantity == null,
    {
      message:
        "COUNT_DIFFERENCE phải gửi countedQuantity; các lý do khác phải gửi quantity, không gửi cả hai",
      path: ["reasonCode"],
    },
  );

export const createAdjustmentSchema = z.object({
  reason: z.string().trim().max(1000).nullish(),
  lines: z.array(lineSchema).min(1, "Phiếu điều chỉnh phải có ít nhất một dòng"),
});

export const rejectAdjustmentSchema = z.object({
  reason: z.string().trim().min(1, "Phải ghi lý do từ chối").max(500),
});

export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;
