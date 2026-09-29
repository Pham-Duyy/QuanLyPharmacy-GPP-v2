import { z } from "zod";

/**
 * Kiểu dữ liệu của API Hệ thống Cơ sở dữ liệu về Dược, bản đặc tả v1.1
 * (https://docs-sandbox.csdlduoc.com.vn).
 *
 * Phản hồi được kiểm bằng zod ở chỗ lỏng tay: hệ thống quốc gia còn đang
 * hoàn thiện, thêm trường mới thì phần mềm này không được sập. Ngược lại,
 * payload **gửi đi** kiểm chặt: sai độ dài hay thiếu trường bắt buộc thì
 * chặn ngay tại chỗ, tốt hơn là bị từ chối sau vài giờ.
 */

// --- Xác thực ---------------------------------------------------------------

export const loginResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().int().positive().optional(),
});

// --- Danh mục ---------------------------------------------------------------

const pagedSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    page: z.coerce.number().int().nonnegative().optional(),
    total: z.coerce.number().int().nonnegative().optional(),
    data: z.array(item).default([]),
  });

export const nationalUnitSchema = z.object({
  id: z.coerce.string(),
  name: z.string().default(""),
});

export const nationalPackagingSchema = z.object({
  unit_id: z.coerce.string().optional(),
  unit_name: z.string().optional(),
  gtin: z.coerce.string().optional(),
});

export const nationalDrugSchema = z.object({
  id: z.coerce.string(),
  name: z.string().default(""),
  drug_group_id: z.coerce.string().nullish(),
  registration_number: z.coerce.string().nullish(),
  old_registration_number: z.coerce.string().nullish(),
  active_pharmaceutical_ingredient: z.string().nullish(),
  strength: z.string().nullish(),
  prescription_status: z.coerce.number().int().nullish(),
  special_control_type: z.coerce.number().int().nullish(),
  packagings: z.array(nationalPackagingSchema).nullish(),
  last_update_time: z.string().nullish(),
  manufacturer: z
    .object({
      id: z.coerce.string().nullish(),
      name: z.string().nullish(),
      country: z.coerce.string().nullish(),
      address: z.string().nullish(),
    })
    .nullish(),
});

export const unitsPageSchema = pagedSchema(nationalUnitSchema);
export const drugsPageSchema = pagedSchema(nationalDrugSchema);

export type NationalDrugDto = z.infer<typeof nationalDrugSchema>;
export type NationalUnitDto = z.infer<typeof nationalUnitSchema>;

// --- Chứng từ ---------------------------------------------------------------

/** Trạng thái xử lý phía hệ thống quốc gia. */
export const REMOTE_STATUSES = [
  "accepted",
  "processing",
  "completed",
  "error",
  "rejected",
] as const;
export type RemoteStatus = (typeof REMOTE_STATUSES)[number];

export const transactionAckSchema = z.object({
  transaction_id: z.coerce.string().optional(),
  status: z.string().optional(),
});

export const transactionStatusSchema = z.object({
  transaction_id: z.coerce.string().optional(),
  status: z.string().optional(),
  messages: z.array(z.string()).nullish(),
  submitted_at: z.string().nullish(),
});

/** Mã lý do nhập hàng (đặc tả: reason của /transactions/stock-in). */
export const STOCK_IN_REASONS = [
  "supplier",
  "opening-balance",
  "return",
  "transfer-in",
  "manufactured",
  "imported",
  "other",
] as const;

/** Mã lý do xuất hàng (đặc tả: reason của /transactions/stock-out). */
export const STOCK_OUT_REASONS = [
  "sale-wholesale",
  "sale-retail",
  "transfer-out",
  "return",
  "recall",
  "destroy",
  "other",
] as const;

const manufacturerSchema = z.object({
  id: z.string().max(20).optional(),
  name: z.string().max(200).optional(),
  country: z.string().max(5).optional(),
});

/**
 * Dòng hàng. `batch_no` để kiểu chuỗi: đặc tả ghi "integer" nhưng lại cho độ
 * dài 50 ký tự, mà số lô thật của nhà sản xuất gần như luôn có chữ
 * (ví dụ "ABC-2026-01"). Gửi chuỗi là cách duy nhất không làm mất số lô.
 */
const itemSchema = z.object({
  drug_id: z.string().min(1).max(20),
  unit_id: z.string().min(1).max(20),
  quantity: z.number().int(),
  batch_no: z.string().min(1).max(50),
  packaging_specifications: z.string().max(500).optional(),
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expiry_date phải theo dạng YYYY-MM-DD"),
  manufacturer: manufacturerSchema.optional(),
  gtin: z.string().max(50).optional(),
  price: z.number().nonnegative().optional(),
});

const baseDocumentSchema = {
  transaction_date: z.string().min(1),
  reference_number: z.string().min(1).max(50),
  practice_license_code: z.string().max(50).optional(),
  note: z.string().max(500).optional(),
};

export const stockInPayloadSchema = z.object({
  ...baseDocumentSchema,
  reason: z.enum(STOCK_IN_REASONS),
  supplier_id: z.string().max(50).optional(),
  source_store_id: z.string().max(50).optional(),
  source_warehouse_id: z.string().max(50).optional(),
  target_store_id: z.string().max(50).optional(),
  target_warehouse_id: z.string().max(50).optional(),
  items: z.array(itemSchema).min(1, "Chứng từ phải có ít nhất một dòng hàng"),
});

export const stockOutPayloadSchema = z.object({
  ...baseDocumentSchema,
  reason: z.enum(STOCK_OUT_REASONS),
  supplier_id: z.string().max(50).optional(),
  source_store_id: z.string().max(50).optional(),
  source_warehouse_id: z.string().max(50).optional(),
  target_store_id: z.string().max(50).optional(),
  target_warehouse_id: z.string().max(50).optional(),
  items: z.array(itemSchema).min(1, "Chứng từ phải có ít nhất một dòng hàng"),
});

/** Phiếu kiểm hàng: mỗi dòng có thêm tồn hệ thống và tồn thực đếm. */
export const stockTakingPayloadSchema = z.object({
  ...baseDocumentSchema,
  store_id: z.string().max(50).optional(),
  warehouse_id: z.string().max(50).optional(),
  items: z
    .array(
      itemSchema.extend({
        system_quantity: z.number().int(),
        actual_quantity: z.number().int(),
      }),
    )
    // Nhà thuốc mới chưa có hàng vẫn phải gửi phiếu kiểm đầu kỳ (rỗng cũng được).
    .default([]),
});

export type StockInPayload = z.infer<typeof stockInPayloadSchema>;
export type StockOutPayload = z.infer<typeof stockOutPayloadSchema>;
export type StockTakingPayload = z.infer<typeof stockTakingPayloadSchema>;
export type SyncPayload = StockInPayload | StockOutPayload | StockTakingPayload;
