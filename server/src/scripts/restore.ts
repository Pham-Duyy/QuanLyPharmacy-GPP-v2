/**
 * Phục hồi dữ liệu từ một bản sao lưu (Phase 7, D30). GHI ĐÈ toàn bộ dữ liệu.
 *
 *   npm run db:restore -- <tệp sao lưu>
 *   npm run db:restore -- <tệp> --yes                  bỏ bước gõ xác nhận
 *   npm run db:restore -- <tệp> --khong-sao-luu-truoc  không sao lưu dữ liệu hiện tại trước
 *
 * Nên dừng máy chủ trước khi phục hồi. Mặc định lệnh tự sao lưu dữ liệu hiện
 * tại (loại "trước phục hồi") rồi mới ghi đè, để còn đường quay lại.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pool } from "../db/pool.js";
import { STORAGE_BASE } from "../lib/file-storage.js";
import { RestoreError, checkRestorable, restoreBackup } from "../modules/backup/backup-restore.js";
import { backupDir, createBackup } from "../modules/backup/backup.service.js";

const KIND_LABEL = { auto: "tự động", manual: "thủ công", "before-restore": "trước phục hồi" };

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fileArg = args.find((arg) => !arg.startsWith("--"));
  if (!fileArg) {
    console.log("Cách dùng: npm run db:restore -- <tệp sao lưu> [--yes] [--khong-sao-luu-truoc]");
    console.log(`Các bản sao lưu nằm ở: ${backupDir()}`);
    process.exitCode = 1;
    return;
  }
  // Cho phép chỉ gõ tên tệp: tìm trong thư mục sao lưu.
  const file = existsSync(fileArg) ? path.resolve(fileArg) : path.join(backupDir(), fileArg);
  if (!existsSync(file)) throw new RestoreError(`Không thấy tệp ${fileArg}`);

  const client = await pool.connect();
  try {
    const header = await checkRestorable(client, file);
    const db = new URL(process.env["DATABASE_URL"] ?? "postgresql://x/?").pathname.slice(1);
    console.log(`Tệp:       ${file}`);
    console.log(
      `Sao lưu:   ${new Date(header.createdAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} (${KIND_LABEL[header.kind]})`,
    );
    console.log(`Số bảng:   ${header.tables.length}`);
    console.log(`Ghi đè:    CSDL "${db}" và thư mục ảnh ${STORAGE_BASE}`);
    console.log("");
    console.log("TOÀN BỘ dữ liệu hiện tại sẽ bị thay bằng dữ liệu trong tệp sao lưu.");

    if (!args.includes("--yes")) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Gõ "PHUC HOI" để tiếp tục: ');
      rl.close();
      if (answer.trim().toUpperCase() !== "PHUC HOI") {
        console.log("Đã hủy, không thay đổi gì.");
        return;
      }
    }

    if (!args.includes("--khong-sao-luu-truoc")) {
      const safety = await createBackup("before-restore", null);
      console.log(`Đã sao lưu dữ liệu hiện tại: ${path.join(backupDir(), safety.name)}`);
    }

    console.log("Đang phục hồi...");
    const result = await restoreBackup({ client, file, storageDir: STORAGE_BASE });
    console.log(
      `Xong: ${result.tables} bảng, ${result.rows} dòng, ${result.files} tệp ảnh. Mọi người cần đăng nhập lại.`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof RestoreError
      ? `Không phục hồi được: ${error.message}. Dữ liệu hiện tại giữ nguyên.`
      : error,
  );
  process.exitCode = 1;
});
