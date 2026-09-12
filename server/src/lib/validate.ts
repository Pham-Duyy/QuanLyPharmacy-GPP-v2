import type { ZodType } from "zod";
import { AppError } from "./app-error.js";

/**
 * Kiểm tra dữ liệu vào bằng zod và dịch lỗi sang khung response chuẩn
 * (contract §2.6, mã VALIDATION_ERROR).
 */
export function parseOrThrow<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const details = result.error.issues.map((issue) => ({
    field: issue.path.join(".") || "(gốc)",
    message: issue.message,
  }));

  throw new AppError(422, "VALIDATION_ERROR", "Dữ liệu gửi lên không hợp lệ", details);
}
