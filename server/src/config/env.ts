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
  /**
   * Chạy sau reverse proxy (nginx…) thì đặt số proxy tin cậy, ví dụ `1`, để
   * máy chủ đọc đúng IP người dùng (ghi phiên đăng nhập, chặn dò mật khẩu theo
   * IP). Bỏ trống khi trình duyệt gọi thẳng máy chủ: không tin X-Forwarded-For.
   */
  TRUST_PROXY: z.coerce.number().int().min(1).max(5).optional(),
  /**
   * Địa chỉ API Hệ thống CSDL về Dược. Bỏ trống thì lấy theo môi trường đã
   * chọn ở màn cấu hình (sandbox hoặc thật). Đặt biến này để trỏ sang máy
   * chủ giả khi chạy test, hoặc khi Bộ Y tế đổi tên miền.
   */
  NDS_BASE_URL: z.string().url().optional(),
  /**
   * Gốc API của nhà cung cấp hóa đơn điện tử MISA meInvoice (phần trước
   * `/v3` và `/integration`). Bỏ trống thì lấy theo môi trường đã chọn. Đặt
   * biến này để trỏ sang máy chủ giả khi chạy test.
   */
  EINVOICE_BASE_URL: z.string().url().optional(),
  /**
   * Gốc Hệ thống đơn thuốc quốc gia (QĐ 808/QĐ-BYT). Bỏ trống thì dùng địa chỉ
   * công bố; đặt biến này để trỏ sang máy chủ giả khi chạy test.
   */
  EPRESCRIPTION_BASE_URL: z.string().url().optional(),
  /**
   * Khóa Claude API cho trợ lý phân tích (contract §20). Bỏ trống thì trợ lý
   * vẫn chạy bằng luật, không gửi dữ liệu nào ra ngoài.
   */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANALYTICS_AI_MODEL: z.string().min(1).default("claude-opus-5-5"),
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
