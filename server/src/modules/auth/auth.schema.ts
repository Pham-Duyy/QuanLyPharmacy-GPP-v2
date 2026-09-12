import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().trim().min(1, "Thiếu tên đăng nhập").max(100),
  password: z.string().min(1, "Thiếu mật khẩu").max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Thiếu mật khẩu hiện tại").max(200),
  newPassword: z
    .string()
    .min(10, "Mật khẩu mới phải dài ít nhất 10 ký tự")
    .max(200)
    .regex(/[a-zA-Z]/, "Mật khẩu mới phải có chữ")
    .regex(/[0-9]/, "Mật khẩu mới phải có số"),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
