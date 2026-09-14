import { z } from "zod";

const CURRENT_YEAR = new Date().getUTCFullYear();

export const searchCustomersSchema = z.object({
  search: z.string().trim().min(3, "Gõ ít nhất 3 ký tự để tìm"),
});

export const createCustomerSchema = z.object({
  fullName: z.string().trim().min(1, "Thiếu họ tên").max(200).nullish(),
  phone: z.string().trim().max(20).nullish(),
  birthYear: z.coerce.number().int().min(1900).max(CURRENT_YEAR).nullish(),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).nullish(),
  note: z.string().trim().max(1000).nullish(),
});

export const patchCustomerSchema = createCustomerSchema.extend({
  version: z.coerce.number().int().positive("Thiếu version"),
});

const allergySchema = z.object({
  ingredientId: z.uuid("ingredientId không hợp lệ"),
  note: z.string().trim().max(500).nullish(),
});

/**
 * Hồ sơ sức khỏe chỉ được lưu khi khách đã đồng ý (contract §11, P8).
 * `consent: true` là staff xác nhận đã hỏi và được khách đồng ý ngay lúc
 * này; thời điểm đồng ý do server tự ghi (`new Date()`), không nhận
 * timestamp từ client — tương tự mọi mốc thời gian nghiệp vụ khác trong
 * hệ thống. Nếu khách đã đồng ý từ trước (`healthDataConsentAt` đã có) thì
 * không cần gửi lại `consent`.
 */
export const patchHealthProfileSchema = z.object({
  consent: z.literal(true).nullish(),
  chronicConditions: z.string().trim().max(2000).nullish(),
  note: z.string().trim().max(1000).nullish(),
  allergies: z.array(allergySchema).default([]),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type PatchCustomerInput = z.infer<typeof patchCustomerSchema>;
export type PatchHealthProfileInput = z.infer<typeof patchHealthProfileSchema>;
