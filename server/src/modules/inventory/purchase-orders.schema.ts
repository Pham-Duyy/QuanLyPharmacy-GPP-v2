import { z } from "zod";
import { dateKey, vnDay } from "../../lib/dates.js";
import { lineQuantity, money } from "../../lib/validators.js";

/** Đơn đặt hàng gửi nhà cung cấp (Phase 7, D32). */

export const PURCHASE_ORDER_STATUSES = [
  "DRAFT",
  "SENT",
  "PARTIAL",
  "RECEIVED",
  "CANCELLED",
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

const lineSchema = z.object({
  productId: z.uuid("productId không hợp lệ"),
  unitId: z.uuid("unitId không hợp lệ"),
  quantity: lineQuantity(),
  /** Đơn giá dự kiến theo đơn vị đặt; bỏ trống khi chưa biết giá. */
  unitPrice: money("Đơn giá").nullish(),
});

const lines = z
  .array(lineSchema)
  .min(1, "Đơn đặt hàng phải có ít nhất một dòng")
  .max(300)
  .superRefine((items, ctx) => {
    const seen = new Map<string, number>();
    items.forEach((item, index) => {
      const first = seen.get(item.productId);
      if (first !== undefined)
        ctx.addIssue({
          code: "custom",
          path: [index, "productId"],
          message: `Sản phẩm đã có ở dòng ${first + 1}; gộp thành một dòng`,
        });
      else seen.set(item.productId, index);
    });
  });

const expectedDate = z.coerce
  .date("Ngày giao dự kiến không hợp lệ")
  .refine((value) => dateKey(value) >= vnDay(), "Ngày giao dự kiến không được trước hôm nay");

export const createPurchaseOrderSchema = z.object({
  supplierId: z.uuid("supplierId không hợp lệ"),
  expectedDate: expectedDate.nullish(),
  note: z.string().trim().max(1000).nullish(),
  lines,
});

export const patchPurchaseOrderSchema = z.object({
  version: z.coerce.number().int().positive("Thiếu version"),
  supplierId: z.uuid("supplierId không hợp lệ").optional(),
  expectedDate: expectedDate.nullish(),
  note: z.string().trim().max(1000).nullish(),
  lines: lines.optional(),
});

/** Tạo nhiều đơn nháp từ trang Đề xuất đặt hàng: mỗi nhà cung cấp một đơn. */
export const fromSuggestionsSchema = z.object({
  items: z
    .array(lineSchema.extend({ supplierId: z.uuid("Chọn nhà cung cấp cho từng dòng") }))
    .min(1, "Chọn ít nhất một mặt hàng")
    .max(500),
});

export const sendPurchaseOrderSchema = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("EMAIL"),
    to: z.email("Email nhận không hợp lệ").trim().max(200),
    message: z.string().trim().max(2000).nullish(),
  }),
  /** Đã tự gửi bằng cách khác (in, PDF, Excel qua Zalo…): chỉ ghi nhận. */
  z.object({ channel: z.literal("MANUAL") }),
]);

export const cancelPurchaseOrderSchema = z.object({
  reason: z.string().trim().min(1, "Ghi lý do hủy đơn").max(500),
});

export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;
export type PatchPurchaseOrderInput = z.infer<typeof patchPurchaseOrderSchema>;
export type SendPurchaseOrderInput = z.infer<typeof sendPurchaseOrderSchema>;
