import "dotenv/config";
import { readFileSync } from "node:fs";
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
  /**
   * Địa chỉ analytics-service (Python, `python main.py serve`) mà cổng
   * `/api/v1/bi/*` chuyển tiếp tới. Bỏ trống thì dùng máy này, cổng 8000.
   */
  ANALYTICS_SERVICE_URL: z.string().url().optional(),
  ANALYTICS_AI_MODEL: z.string().min(1).default("claude-opus-5-5"),
  /**
   * Sao lưu trong phần mềm (Phase 7, D30). Thư mục chứa bản sao lưu; nên đặt
   * ngoài thư mục dự án, ví dụ `D:\sao-luu-nha-thuoc` trên Windows. Bỏ trống
   * thì dùng thư mục `backups/` cạnh mã nguồn.
   */
  BACKUP_DIR: z.string().min(1).optional(),
  /** Số bản sao lưu tự động giữ lại; bản cũ hơn bị xóa. */
  BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(14),
  /** Giờ sao lưu tự động mỗi ngày, giờ Việt Nam, dạng HH:mm. */
  BACKUP_TIME: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "BACKUP_TIME dạng HH:mm, ví dụ 23:00")
    .default("23:00"),
  /**
   * Máy chủ thư để gửi đơn đặt hàng cho nhà cung cấp (Phase 7, D32). Bỏ trống
   * SMTP_HOST thì chỉ in / tải Excel để tự gửi. Gmail: smtp.gmail.com, cổng
   * 465, SMTP_SECURE=true, mật khẩu ứng dụng (không phải mật khẩu Gmail).
   */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  /** Địa chỉ người gửi, ví dụ `Nhà thuốc GPP <donhang@nhathuoc.vn>`. Bỏ trống thì dùng SMTP_USER. */
  SMTP_FROM: z.string().min(3).optional(),
  /**
   * Cờ `Secure` của cookie đăng nhập. Mặc định bật khi NODE_ENV=production.
   * Chạy trong mạng nội bộ bằng http (máy khác mở http://192.168.x.x) thì
   * phải đặt `false`, nếu không trình duyệt bỏ cookie và cứ 15 phút bị đăng
   * xuất. Có https thì để mặc định.
   */
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  /** `false` thì tắt sao lưu tự động (vẫn sao lưu tay được). */
  BACKUP_AUTO: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

// Docker: khóa bí mật nằm trong tệp (JWT_SECRET_FILE) thay vì biến môi trường, để
// lệnh chạy bằng `docker compose exec` (seed, sao lưu, phục hồi) cũng đọc được.
if (!process.env["JWT_SECRET"] && process.env["JWT_SECRET_FILE"]) {
  try {
    process.env["JWT_SECRET"] = readFileSync(process.env["JWT_SECRET_FILE"], "utf8").trim();
  } catch {
    // Không đọc được tệp: để kiểm tra bên dưới báo thiếu JWT_SECRET.
  }
}

// Biến đặt mà để trống (VAR= trong .env, hoặc ${VAR:-} trong docker-compose) coi như không đặt.
const parsed = envSchema.safeParse(
  Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== "")),
);

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

/** Cờ Secure của cookie đăng nhập (xem COOKIE_SECURE). */
export const cookieSecure =
  env.COOKIE_SECURE === undefined ? isProduction : env.COOKIE_SECURE === "true";
