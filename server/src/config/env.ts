import "dotenv/config";
import { z } from "zod";

/**
 * Đọc và kiểm tra biến môi trường ngay khi khởi động.
 * Thiếu hoặc sai biến thì dừng hẳn, không để server chạy với cấu hình lỗi.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, "Thiếu chuỗi kết nối CSDL"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET phải dài ít nhất 16 ký tự"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Cấu hình môi trường không hợp lệ:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  console.error("Kiểm tra lại file server/.env, xem mẫu ở .env.example");
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
