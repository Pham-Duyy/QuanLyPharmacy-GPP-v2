/**
 * Sao lưu ngay từ dòng lệnh (Phase 7, D30): `npm run db:backup`. Cùng định
 * dạng với nút "Sao lưu ngay" trên trang Quản trị → Sao lưu.
 */
import path from "node:path";
import { pool } from "../db/pool.js";
import { backupDir, createBackup } from "../modules/backup/backup.service.js";

try {
  const result = await createBackup("manual", null);
  console.log(`Đã sao lưu: ${path.join(backupDir(), result.name)}`);
  console.log(
    `${result.rows} dòng, ${result.files} tệp ảnh, ${(result.sizeBytes / 1e6).toFixed(1)} MB`,
  );
} catch (error) {
  console.error("Sao lưu thất bại:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
