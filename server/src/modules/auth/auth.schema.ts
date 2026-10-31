import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().trim().min(1, "Thiếu tên đăng nhập").max(100),
  password: z.string().min(1, "Thiếu mật khẩu").max(200),
});

/**
 * Luật mật khẩu dùng chung: đổi mật khẩu và đặt mật khẩu khi tạo tài khoản.
 * bcrypt chỉ dùng 72 byte đầu, phần dư bị bỏ qua mà người dùng không biết,
 * nên chặn ngay từ đầu (chữ có dấu tính 2–3 byte).
 */
export const newPasswordSchema = z
  .string()
  .min(10, "Mật khẩu mới phải dài ít nhất 10 ký tự")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 72,
    "Mật khẩu quá dài: tối đa 72 ký tự không dấu",
  )
  .regex(/[a-zA-Z]/, "Mật khẩu mới phải có chữ")
  .regex(/[0-9]/, "Mật khẩu mới phải có số");

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Thiếu mật khẩu hiện tại").max(200),
  newPassword: newPasswordSchema,
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** Mã 6 số từ ứng dụng xác thực, hoặc mã dự phòng dạng XXXXX-XXXXX. */
const mfaCode = z.string().trim().min(6, "Nhập mã xác thực").max(20);

export const mfaLoginSchema = z.object({
  mfaToken: z.string().min(1),
  code: mfaCode,
});

export const mfaCodeSchema = z.object({ code: mfaCode });

export const mfaDisableSchema = z.object({
  password: z.string().min(1, "Nhập mật khẩu"),
  code: mfaCode,
});

export const mfaPolicySchema = z.object({ requiredForManagers: z.boolean() });
