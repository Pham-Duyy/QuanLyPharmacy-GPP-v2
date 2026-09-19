import { z } from "zod";

const CURRENT_YEAR = new Date().getUTCFullYear();

export const searchCustomersSchema = z.object({
  search: z.string().trim().min(3, "Gõ ít nhất 3 ký tự để tìm"),
});

/** Trường thông tin cơ bản, dùng chung cho tạo mới và sửa. */
const customerFieldsSchema = z.object({
  fullName: z.string().trim().min(1, "Thiếu họ tên").max(200).nullish(),
  phone: z.string().trim().min(1, "Thiếu số điện thoại").max(20).nullish(),
  birthYear: z.coerce.number().int().min(1900).max(CURRENT_YEAR).nullish(),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).nullish(),
  note: z.string().trim().max(1000).nullish(),
  email: z
    .email("Email không hợp lệ")
    .trim()
    .max(200)
    .nullish()
    .or(z.literal("").transform(() => null)),
  address: z.string().trim().max(300).nullish(),
});

/** Danh sách khách hàng (không kèm `search`): tìm theo tên/SĐT/mã và lọc nhóm. */
export const listCustomersSchema = z.object({
  q: z.string().trim().max(100).optional(),
  segment: z.enum(["LOYAL", "NEW", "DORMANT"]).optional(),
});

/**
 * Bắt buộc có ít nhất họ tên hoặc số điện thoại lúc tạo mới — khách lẻ
 * không cần tạo bản ghi Customer. Không áp lại ràng buộc này cho PATCH: sửa
 * có thể chỉ gửi một trường, schema không biết trường còn lại trong CSDL
 * đang có giá trị hay không, nên việc "sửa xong không được rỗng cả hai"
 * phải kiểm tra ở service sau khi đã biết dữ liệu hiện có (customers.service.ts).
 */
export const createCustomerSchema = customerFieldsSchema.refine(
  (value) => Boolean(value.fullName) || Boolean(value.phone),
  { message: "Phải có ít nhất họ tên hoặc số điện thoại", path: ["fullName"] },
);

export const patchCustomerSchema = customerFieldsSchema.extend({
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

export const anonymizeCustomerSchema = z.object({
  reason: z.string().trim().min(1, "Phải ghi lý do ẩn danh").max(500),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type PatchCustomerInput = z.infer<typeof patchCustomerSchema>;
export type PatchHealthProfileInput = z.infer<typeof patchHealthProfileSchema>;
export type AnonymizeCustomerInput = z.infer<typeof anonymizeCustomerSchema>;
