import { createReadStream, createWriteStream } from "node:fs";
import { readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { createGunzip, createGzip } from "node:zlib";
import type { PoolClient } from "pg";

/**
 * Định dạng tệp sao lưu (Phase 7, D30): một tệp gzip, mỗi dòng một bản ghi.
 *
 * - Dòng bắt đầu bằng `#` là dòng điều khiển, phần sau là JSON:
 *   `header` (đầu tệp), `table` (bắt đầu một bảng), `sequence`, `file`
 *   (dòng kế tiếp là nội dung tệp dạng base64), `end` (cuối tệp, kèm số dòng
 *   để phát hiện tệp bị cắt cụt).
 * - Dòng còn lại là một hàng của bảng đang đọc, đúng chuỗi `to_jsonb(row)` do
 *   PostgreSQL sinh. Khi phục hồi, chuỗi này đưa thẳng lại cho PostgreSQL
 *   (`jsonb_populate_recordset`), không qua JSON.parse của JavaScript, nên số
 *   lớn, ngày giờ, số thập phân giữ đúng như cũ.
 *
 * Không dùng `pg_dump` để chạy được trên máy không cài công cụ PostgreSQL.
 */

export const BACKUP_FORMAT = "gpp-backup";
export const BACKUP_VERSION = 1;
export const BACKUP_EXTENSION = ".ndjson.gz";
/** Tên tệp do phần mềm đặt; chỉ tệp đúng mẫu này mới được liệt kê và tải về. */
export const BACKUP_NAME = /^sao-luu-\d{8}-\d{6}-(tu-dong|thu-cong|truoc-phuc-hoi)\.ndjson\.gz$/;

export type BackupKind = "auto" | "manual" | "before-restore";

const KIND_SLUG: Record<BackupKind, string> = {
  auto: "tu-dong",
  manual: "thu-cong",
  "before-restore": "truoc-phuc-hoi",
};

export type BackupHeader = {
  type: "header";
  format: typeof BACKUP_FORMAT;
  version: number;
  kind: BackupKind;
  createdAt: string;
  createdBy: string | null;
  migrations: string[];
  tables: string[];
};

export type BackupSummary = {
  name: string;
  kind: BackupKind;
  createdAt: string;
  sizeBytes: number;
  tables: number;
};

/** Bảng không sao lưu: lịch sử migration thuộc về mã nguồn, không phải dữ liệu. */
const SKIPPED_TABLES = new Set(["_prisma_migrations"]);

const ROW_BATCH = 2_000;

export function backupFileName(kind: BackupKind, at = new Date()): string {
  const vn = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .format(at)
    .replace(/\D/g, "");
  return `sao-luu-${vn.slice(0, 8)}-${vn.slice(8, 14)}-${KIND_SLUG[kind]}${BACKUP_EXTENSION}`;
}

export async function listDataTables(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  return result.rows.map((row) => row.tablename).filter((name) => !SKIPPED_TABLES.has(name));
}

export async function appliedMigrations(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ migration_name: string }>(
    `SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY migration_name`,
  );
  return result.rows.map((row) => row.migration_name);
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Mọi tệp trong thư mục, đường dẫn tương đối dùng dấu `/`. */
async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/**
 * Ghi một bản sao lưu: đọc mọi bảng trong một giao dịch REPEATABLE READ (một
 * ảnh chụp nhất quán dù phần mềm vẫn đang bán hàng), rồi chép thư mục ảnh.
 * Ghi ra tệp `.part` rồi mới đổi tên: tệp đúng tên luôn là tệp đã ghi xong.
 */
export async function writeBackup(options: {
  client: PoolClient;
  dir: string;
  storageDir: string;
  kind: BackupKind;
  createdBy: string | null;
}): Promise<{ name: string; rows: number; files: number; sizeBytes: number }> {
  const { client, dir, storageDir, kind } = options;
  const name = backupFileName(kind);
  const finalPath = path.join(dir, name);
  const partPath = `${finalPath}.part`;

  const gzip = createGzip({ level: 6 });
  const out = createWriteStream(partPath);
  const finished = new Promise<void>((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
    gzip.on("error", reject);
  });
  gzip.pipe(out);
  const write = async (line: string) => {
    if (!gzip.write(`${line}\n`)) await new Promise((resolve) => gzip.once("drain", resolve));
  };

  let rows = 0;
  let files = 0;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = await listDataTables(client);
    const header: BackupHeader = {
      type: "header",
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      kind,
      createdAt: new Date().toISOString(),
      createdBy: options.createdBy,
      migrations: await appliedMigrations(client),
      tables,
    };
    await write(`#${JSON.stringify(header)}`);

    for (const table of tables) {
      await write(`#${JSON.stringify({ type: "table", name: table })}`);
      // Con trỏ đọc từng đợt: bảng lớn (thẻ kho, nhật ký) không phải nạp hết vào RAM.
      await client.query(
        `DECLARE backup_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS row FROM ${quoteIdent(table)} t`,
      );
      for (;;) {
        const batch = await client.query<{ row: string }>(`FETCH ${ROW_BATCH} FROM backup_rows`);
        for (const { row } of batch.rows) await write(row);
        rows += batch.rows.length;
        if (batch.rows.length < ROW_BATCH) break;
      }
      await client.query("CLOSE backup_rows");
    }

    const sequences = await client.query<{ name: string; value: string | null }>(
      `SELECT sequencename AS name, last_value::text AS value FROM pg_sequences WHERE schemaname = 'public'`,
    );
    for (const sequence of sequences.rows) {
      await write(`#${JSON.stringify({ type: "sequence", ...sequence })}`);
    }
    await client.query("COMMIT");

    for (const relative of await listFiles(storageDir)) {
      const content = await readFile(path.join(storageDir, relative));
      await write(`#${JSON.stringify({ type: "file", path: relative, size: content.length })}`);
      await write(content.toString("base64"));
      files++;
    }
    await write(`#${JSON.stringify({ type: "end", rows, files })}`);
    gzip.end();
    await finished;
    await rename(partPath, finalPath);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    gzip.destroy();
    out.destroy();
    await unlink(partPath).catch(() => {});
    throw error;
  }
  return { name, rows, files, sizeBytes: (await stat(finalPath)).size };
}

export type BackupLine =
  | { kind: "header"; header: BackupHeader }
  | { kind: "table"; name: string }
  | { kind: "row"; json: string }
  | { kind: "sequence"; name: string; value: string | null }
  | { kind: "file"; path: string; content: Buffer }
  | { kind: "end"; rows: number; files: number };

/** Đọc lần lượt từng bản ghi của tệp sao lưu. */
export async function* readBackup(file: string): AsyncGenerator<BackupLine> {
  const input = createReadStream(file);
  const lines = createInterface({ input: input.pipe(createGunzip()), crlfDelay: Infinity });
  try {
    yield* parseLines(lines);
  } finally {
    // Đóng tệp cả khi người đọc dừng giữa chừng (Windows không xóa được tệp đang mở).
    lines.close();
    input.destroy();
  }
}

async function* parseLines(lines: AsyncIterable<string>): AsyncGenerator<BackupLine> {
  let pendingFile: { path: string } | null = null;
  for await (const line of lines) {
    if (pendingFile) {
      yield { kind: "file", path: pendingFile.path, content: Buffer.from(line, "base64") };
      pendingFile = null;
      continue;
    }
    if (!line.startsWith("#")) {
      yield { kind: "row", json: line };
      continue;
    }
    const control = JSON.parse(line.slice(1)) as { type: string } & Record<string, unknown>;
    switch (control.type) {
      case "header":
        yield { kind: "header", header: control as unknown as BackupHeader };
        break;
      case "table":
        yield { kind: "table", name: String(control["name"]) };
        break;
      case "sequence":
        yield {
          kind: "sequence",
          name: String(control["name"]),
          value: (control["value"] as string | null) ?? null,
        };
        break;
      case "file":
        pendingFile = { path: String(control["path"]) };
        break;
      case "end":
        yield { kind: "end", rows: Number(control["rows"]), files: Number(control["files"]) };
        break;
      default:
        throw new Error(`Dòng điều khiển không rõ: ${control.type}`);
    }
  }
}

/** Chỉ giải nén tới hết dòng đầu: đủ để liệt kê bản sao lưu mà không đọc cả tệp. */
export async function readHeader(file: string): Promise<BackupHeader | null> {
  const input = createReadStream(file);
  const gunzip = createGunzip();
  input.pipe(gunzip);
  let text = "";
  try {
    for await (const chunk of gunzip) {
      text += (chunk as Buffer).toString("utf8");
      const end = text.indexOf("\n");
      if (end < 0 && text.length < 1_000_000) continue;
      const first = end < 0 ? text : text.slice(0, end);
      if (!first.startsWith("#")) return null;
      const header = JSON.parse(first.slice(1)) as BackupHeader;
      return header.type === "header" && header.format === BACKUP_FORMAT ? header : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    gunzip.destroy();
    input.destroy();
  }
}

export async function listBackups(dir: string): Promise<BackupSummary[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) =>
    BACKUP_NAME.test(name),
  );
  const items: BackupSummary[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const header = await readHeader(file);
    if (!header) continue;
    items.push({
      name,
      kind: header.kind,
      createdAt: header.createdAt,
      sizeBytes: (await stat(file)).size,
      tables: header.tables.length,
    });
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
