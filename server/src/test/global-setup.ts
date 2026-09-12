import { execSync } from "node:child_process";
import { config } from "dotenv";

/**
 * Chạy một lần trước toàn bộ test: áp migration lên CSDL kiểm thử.
 * Dùng đúng chuỗi migration của dự án nên môi trường test giống hệt môi
 * trường thật, gồm cả CHECK, chỉ mục từng phần và extension.
 */
export default function setup(): void {
  config();
  const url = process.env["DATABASE_URL_TEST"];
  if (!url) throw new Error("Thiếu DATABASE_URL_TEST trong server/.env");

  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url, CHECKPOINT_DISABLE: "1" },
    stdio: "pipe",
  });
}
