import { config } from "dotenv";
import { testDatabaseUrl } from "./test-database.js";

// Phải đổi DATABASE_URL trước khi bất kỳ module nào của ứng dụng được nạp,
// vì db/pool.ts đọc biến này ngay lúc import. Không có đường lùi về
// DATABASE_URL: đó là CSDL đang dùng, test sẽ xóa sạch nó.
config();
process.env["DATABASE_URL"] = testDatabaseUrl();
process.env["JWT_SECRET"] ??= "chuoi-bi-mat-danh-rieng-cho-kiem-thu";

// Tắt log HTTP khi chạy test để kết quả đọc được.
process.env["LOG_LEVEL"] = "silent";
