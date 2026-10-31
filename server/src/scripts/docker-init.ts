/**
 * Việc khởi tạo khi chạy trong Docker (Phase 7, D33), gọi từ docker-entrypoint.sh
 * sau khi áp migration:
 * - CSDL chưa có tài khoản nào thì chạy seed (cửa hàng, quyền, admin, danh mục mẫu).
 * - Tạo hoặc đặt lại tài khoản chỉ đọc analytics_reader theo ANALYTICS_READER_PASSWORD.
 */
import { spawnSync } from "node:child_process";
import { prisma } from "../db/prisma.js";

function run(script: string, args: string[] = []): void {
  const result = spawnSync("npx", ["tsx", script, ...args], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Chạy ${script} thất bại`);
}

try {
  if ((await prisma.user.count()) === 0) {
    console.log("CSDL mới: tạo dữ liệu nền và tài khoản admin...");
    run("prisma/seed.ts");
  }
  const password = process.env["ANALYTICS_READER_PASSWORD"];
  if (password) {
    // Không in mật khẩu ra log.
    const result = spawnSync("npx", ["tsx", "src/scripts/analytics-reader.ts", password], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (result.status !== 0) throw new Error("Không tạo được tài khoản analytics_reader");
    console.log("Đã cập nhật tài khoản chỉ đọc analytics_reader.");
  }
} finally {
  await prisma.$disconnect();
}
