import { z } from "zod";
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
  phone: z.string().trim().max(20).nullish(),
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
  phone: z.string().trim().max(20).nullish(),
  practiceCertificateNumber: z.string().trim().max(100).nullish(),
  version: z.coerce.number().int().positive("Thiếu version"),
});

/** `PUT /users/{id}/roles`: thân request là chính mảng gán vai trò (contract §21). */
export const replaceRolesSchema = z.array(roleAssignmentSchema);

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type PatchUserInput = z.infer<typeof patchUserSchema>;
export type RoleAssignmentInput = z.infer<typeof roleAssignmentSchema>;
