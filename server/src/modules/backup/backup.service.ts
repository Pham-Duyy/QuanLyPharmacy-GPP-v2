import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { STORAGE_BASE } from "../../lib/file-storage.js";
import {
  BACKUP_NAME,
  listBackups,
  writeBackup,
  type BackupKind,
  type BackupSummary,
} from "./backup-file.js";

/** Khóa tư vấn của PostgreSQL: hai tiến trình không sao lưu cùng lúc. */
const BACKUP_LOCK = 724_092;
/** Bản "trước phục hồi" chỉ cần vài bản gần nhất. */
const KEEP_BEFORE_RESTORE = 5;

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../backups");

export function backupDir(): string {
  // Đọc lại biến môi trường mỗi lần gọi để test trỏ được sang thư mục tạm.
  return path.resolve(process.env["BACKUP_DIR"] || env.BACKUP_DIR || DEFAULT_DIR);
}

export type BackupRun = {
  kind: BackupKind;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  name: string | null;
  error: string | null;
};

/** Lần chạy gần nhất (kể cả thất bại) để trang Sao lưu báo lỗi. Mất khi khởi động lại. */
let lastRun: BackupRun | null = null;
let running = false;

export async function createBackup(
  kind: BackupKind,
  createdBy: string | null,
): Promise<{ name: string; rows: number; files: number; sizeBytes: number }> {
  if (running) throw new AppError(409, "BACKUP_RUNNING", "Đang sao lưu, đợi xong lượt này");
  running = true;
  const run: BackupRun = {
    kind,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: null,
    name: null,
    error: null,
  };
  lastRun = run;
  const client = await pool.connect();
  try {
    const locked = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [
      BACKUP_LOCK,
    ]);
    if (!locked.rows[0]?.ok)
      throw new AppError(409, "BACKUP_RUNNING", "Đang có lượt sao lưu khác chạy");
    try {
      const dir = backupDir();
      await mkdir(dir, { recursive: true });
      const result = await writeBackup({
        client,
        dir,
        storageDir: STORAGE_BASE,
        kind,
        createdBy,
      });
      await prune(dir);
      run.ok = true;
      run.name = result.name;
      return result;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [BACKUP_LOCK]);
    }
  } catch (error) {
    run.ok = false;
    run.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    run.finishedAt = new Date().toISOString();
    running = false;
    client.release();
  }
}

/** Giữ BACKUP_KEEP bản mới nhất của mỗi loại tự động / thủ công. */
async function prune(dir: string): Promise<void> {
  const items = await listBackups(dir);
  const limits: Record<BackupKind, number> = {
    auto: env.BACKUP_KEEP,
    manual: env.BACKUP_KEEP,
    "before-restore": KEEP_BEFORE_RESTORE,
  };
  for (const kind of Object.keys(limits) as BackupKind[]) {
    const old = items.filter((item) => item.kind === kind).slice(limits[kind]);
    for (const item of old) await unlink(path.join(dir, item.name)).catch(() => {});
  }
}

export async function backupStatus(): Promise<{
  dir: string;
  auto: boolean;
  time: string;
  keep: number;
  running: boolean;
  lastRun: BackupRun | null;
  items: BackupSummary[];
}> {
  return {
    dir: backupDir(),
    auto: env.BACKUP_AUTO,
    time: env.BACKUP_TIME,
    keep: env.BACKUP_KEEP,
    running,
    lastRun,
    items: await listBackups(backupDir()),
  };
}

/** Đường dẫn của một bản sao lưu theo tên; tên lạ (dò đường dẫn) bị từ chối. */
export async function resolveBackup(name: string): Promise<string> {
  if (!BACKUP_NAME.test(name)) throw AppError.notFound("Không tìm thấy bản sao lưu");
  const items = await listBackups(backupDir());
  if (!items.some((item) => item.name === name))
    throw AppError.notFound("Không tìm thấy bản sao lưu");
  return path.join(backupDir(), name);
}

export async function auditBackup(
  action: "BACKUP_CREATE" | "BACKUP_DOWNLOAD",
  actorId: string,
  name: string,
  requestId?: string,
): Promise<void> {
  await prisma.auditLog.create({
    data: { actorId, action, resourceType: "backup", resourceId: name, requestId },
  });
}
