import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import {
  appliedMigrations,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  listDataTables,
  readBackup,
  readHeader,
  type BackupHeader,
} from "./backup-file.js";

/**
 * Phục hồi một bản sao lưu (Phase 7, D30). Chỉ gọi từ lệnh `npm run db:restore`,
 * không có API: phục hồi ghi đè toàn bộ dữ liệu.
 *
 * Mọi việc với CSDL nằm trong **một giao dịch**: tệp hỏng, cắt cụt hay sai
 * phiên bản thì giao dịch hủy, dữ liệu hiện có giữ nguyên.
 *
 * Khóa ngoại tạm gỡ rồi tạo lại trong cùng giao dịch, nên nạp bảng theo thứ
 * tự nào cũng được; tạo lại khóa ngoại thì PostgreSQL kiểm tra lại toàn bộ.
 * Không cần quyền superuser (chỉ cần là chủ các bảng, như khi chạy migration).
 */

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const ROW_BATCH = 500;

export class RestoreError extends Error {}

/** Kiểm tra trước khi phục hồi: đúng định dạng, cùng phiên bản CSDL. */
export async function checkRestorable(client: PoolClient, file: string): Promise<BackupHeader> {
  const header = await readHeader(file);
  if (!header) throw new RestoreError("Không phải tệp sao lưu của phần mềm, hoặc tệp đã hỏng");
  if (header.version > BACKUP_VERSION || header.format !== BACKUP_FORMAT)
    throw new RestoreError("Tệp sao lưu do phiên bản phần mềm mới hơn tạo; hãy cập nhật phần mềm");
  const current = await appliedMigrations(client);
  const missing = header.migrations.filter((name) => !current.includes(name));
  const extra = current.filter((name) => !header.migrations.includes(name));
  if (missing.length > 0)
    throw new RestoreError(
      `Bản sao lưu được tạo ở phiên bản phần mềm mới hơn CSDL hiện tại (thiếu migration ${missing.join(", ")}). Cập nhật mã nguồn và chạy npm run db:migrate trước.`,
    );
  if (extra.length > 0)
    throw new RestoreError(
      `CSDL hiện tại đã nâng cấp sau khi tạo bản sao lưu (migration mới: ${extra.join(", ")}). Phục hồi bản này cần mã nguồn và CSDL ở đúng phiên bản lúc sao lưu.`,
    );
  return header;
}

export async function restoreBackup(options: {
  client: PoolClient;
  file: string;
  storageDir: string;
}): Promise<{ rows: number; files: number; tables: number }> {
  const { client, file, storageDir } = options;
  const header = await checkRestorable(client, file);
  const staging = `${storageDir}.phuc-hoi-${Date.now()}`;
  let rows = 0;
  let files = 0;
  let ended: { rows: number; files: number } | null = null;

  await client.query("BEGIN");
  try {
    const tables = await listDataTables(client);
    const sameTables =
      tables.length === header.tables.length && tables.every((t) => header.tables.includes(t));
    if (!sameTables) throw new RestoreError("Danh sách bảng trong tệp không khớp CSDL hiện tại");

    const foreignKeys = await client.query<{ table: string; name: string; definition: string }>(
      `SELECT c.conrelid::regclass::text AS table, c.conname AS name,
              pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.contype = 'f' AND n.nspname = 'public'`,
    );
    for (const fk of foreignKeys.rows) {
      await client.query(`ALTER TABLE ${fk.table} DROP CONSTRAINT ${quoteIdent(fk.name)}`);
    }
    await client.query(`TRUNCATE ${tables.map(quoteIdent).join(", ")}`);

    let table: string | null = null;
    let batch: string[] = [];
    const flush = async () => {
      if (!table || batch.length === 0) return;
      await client.query(
        `INSERT INTO ${quoteIdent(table)} SELECT * FROM jsonb_populate_recordset(NULL::${quoteIdent(table)}, $1::jsonb)`,
        [`[${batch.join(",")}]`],
      );
      rows += batch.length;
      batch = [];
    };

    for await (const line of readBackup(file)) {
      switch (line.kind) {
        case "table":
          await flush();
          if (!tables.includes(line.name))
            throw new RestoreError(`Bảng lạ trong tệp: ${line.name}`);
          table = line.name;
          break;
        case "row":
          batch.push(line.json);
          if (batch.length >= ROW_BATCH) await flush();
          break;
        case "sequence":
          await flush();
          await client.query(
            line.value === null
              ? "SELECT setval($1::regclass, 1, false)"
              : "SELECT setval($1::regclass, $2::bigint, true)",
            line.value === null
              ? [`public.${quoteIdent(line.name)}`]
              : [`public.${quoteIdent(line.name)}`, line.value],
          );
          break;
        case "file": {
          await flush();
          const target = path.resolve(staging, line.path);
          if (!target.startsWith(path.resolve(staging) + path.sep))
            throw new RestoreError(`Đường dẫn tệp không hợp lệ: ${line.path}`);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, line.content);
          files++;
          break;
        }
        case "end":
          await flush();
          ended = { rows: line.rows, files: line.files };
          break;
        default:
          break;
      }
    }
    if (!ended || ended.rows !== rows || ended.files !== files)
      throw new RestoreError("Tệp sao lưu bị cắt cụt hoặc hỏng (số dòng không khớp)");

    for (const fk of foreignKeys.rows) {
      await client.query(
        `ALTER TABLE ${fk.table} ADD CONSTRAINT ${quoteIdent(fk.name)} ${fk.definition}`,
      );
    }
    // Phiên đăng nhập trong bản sao lưu đã cũ: bắt mọi người đăng nhập lại.
    await client.query(
      `UPDATE refresh_sessions SET revoked_at = now(), revoked_reason = 'RESTORED'
        WHERE revoked_at IS NULL`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  // CSDL đã phục hồi xong mới thay thư mục ảnh: thư mục cũ giữ lại bên cạnh.
  if (files > 0) {
    const previous = `${storageDir}.truoc-phuc-hoi-${Date.now()}`;
    await rename(storageDir, previous).catch(() => {});
    await rename(staging, storageDir);
  } else {
    await rm(staging, { recursive: true, force: true });
  }
  return { rows, files, tables: header.tables.length };
}
