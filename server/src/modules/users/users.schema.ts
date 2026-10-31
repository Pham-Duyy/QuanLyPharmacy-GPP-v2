import { z } from "zod";
import { optionalPhone } from "../../lib/validators.js";
import { newPasswordSchema } from "../auth/auth.schema.js";

const roleAssignmentSchema = z.object({
  roleCode: z.string().trim().min(1, "Thiếu roleCode"),
  storeId: z.uuid("storeId không hợp lệ").nullish(),
  additionalPermissions: z.array(z.string()).default([]),
  qualificationReference: z.string().trim().min(1).max(500).nullish(),
  responsibleProfessional: z.boolean().default(false),
});

/**
 * `POST /users`. Hai cách dùng (contract §21):
 * - Chỉ thông tin cơ bản: máy chủ sinh mật khẩu tạm, trả về một lần; vai trò
 *   gán sau bằng `PUT /users/{id}/roles`.
 * - Kèm `password` và/hoặc `roles`: tài khoản, mật khẩu và phân quyền được
 *   tạo trong cùng một giao dịch — lỗi ở phân quyền thì không có tài khoản nào.
 */
export const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Tên đăng nhập tối thiểu 3 ký tự")
    .max(50)
    .regex(/^[a-z0-9._-]+$/i, "Chỉ gồm chữ, số, dấu chấm, gạch dưới, gạch ngang"),
  fullName: z.string().trim().min(1, "Thiếu họ tên").max(200),
  phone: optionalPhone(),
  practiceCertificateNumber: z.string().trim().max(100).nullish(),
  defaultStoreId: z.uuid("defaultStoreId không hợp lệ").nullish(),
  password: newPasswordSchema.optional(),
  /** Chỉ có nghĩa khi gửi `password`; mật khẩu tạm do máy chủ sinh luôn bắt đổi. */
  mustChangePassword: z.boolean().default(true),
  roles: z.array(roleAssignmentSchema).max(20).optional(),
});

/**
 * `PATCH /users/{id}` chỉ sửa thông tin cơ bản (contract §21) — mật khẩu,
 * vai trò, trạng thái hoạt động đều có endpoint riêng, không lẫn vào đây.
 */
export const patchUserSchema = z.object({
  fullName: z.string().trim().min(1, "Thiếu họ tên").max(200).optional(),
  phone: optionalPhone(),
  practiceCertificateNumber: z.string().trim().max(100).nullish(),
  version: z.coerce.number().int().positive("Thiếu version"),
});

/**
 * `POST /users/me/pharmacist-role` (Phase 7, D29): quản lý nhân sự tự thêm vai
 * trò Dược sĩ cho chính mình tại một cửa hàng — chủ nhà thuốc có chứng chỉ
 * hành nghề kiêm đứng quầy.
 */
export const ownPharmacistRoleSchema = z.object({
  storeId: z.uuid("storeId không hợp lệ"),
  qualificationReference: z
    .string()
    .trim()
    .min(1, "Ghi căn cứ bằng cấp chuyên môn (ví dụ số bằng Dược sĩ, nơi cấp)")
    .max(500),
  /** Bắt buộc khi hồ sơ chưa có số chứng chỉ hành nghề. */
  practiceCertificateNumber: z.string().trim().min(1).max(100).nullish(),
  responsibleProfessional: z.boolean().default(false),
});

/** `PUT /users/{id}/roles`: thân request là chính mảng gán vai trò (contract §21). */
export const replaceRolesSchema = z.array(roleAssignmentSchema);

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type PatchUserInput = z.infer<typeof patchUserSchema>;
export type OwnPharmacistRoleInput = z.infer<typeof ownPharmacistRoleSchema>;
export type RoleAssignmentInput = z.infer<typeof roleAssignmentSchema>;
