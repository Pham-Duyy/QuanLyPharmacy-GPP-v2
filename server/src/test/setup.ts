import { config } from "dotenv";

// Phải đổi DATABASE_URL trước khi bất kỳ module nào của ứng dụng được nạp,
// vì db/pool.ts đọc biến này ngay lúc import.
config();
process.env["DATABASE_URL"] = process.env["DATABASE_URL_TEST"] ?? process.env["DATABASE_URL"];
process.env["JWT_SECRET"] ??= "chuoi-bi-mat-danh-rieng-cho-kiem-thu";

// Tắt log HTTP khi chạy test để kết quả đọc được.
process.env["LOG_LEVEL"] = "silent";
