import { config } from "dotenv";

import { tmpdir } from "node:os";
import path from "node:path";

// Phải đổi DATABASE_URL trước khi bất kỳ module nào của ứng dụng được nạp,
// vì db/pool.ts đọc biến này ngay lúc import.
config();
process.env["DATABASE_URL"] = process.env["DATABASE_URL_TEST"] ?? process.env["DATABASE_URL"];
// Sao lưu trong test luôn ghi vào thư mục tạm: test xóa sạch thư mục này
// trước mỗi ca, không được phép đụng tới thư mục sao lưu thật trong .env.
process.env["BACKUP_DIR"] = path.join(tmpdir(), "gpp-test-backups");
process.env["JWT_SECRET"] ??= "chuoi-bi-mat-danh-rieng-cho-kiem-thu";

// Tắt log HTTP khi chạy test để kết quả đọc được.
process.env["LOG_LEVEL"] = "silent";
