import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { getSetting, type BackupSettings } from "../../lib/settings.js";
import {
  DUMP_FILE,
  STORAGE_DIR,
  backupPaths,
  backupRoot,
  copyStorage,
  dumpDatabase,
  ensureFolder,
  removeFolder,
  restoreCommands,
} from "./backup.runner.js";

export const BACKUP_SETTINGS_KEY = "backupSettings";

/** Gom hai việc nặng vào một chỗ để test thay bằng hàm giả, không cần cài pg_dump. */
export const runners = { dumpDatabase, copyStorage };

export const backupSettingsSchema = z.object({
  enabled: z.boolean(),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  keepCount: z.number().int().min(1).max(90),
  includeStorage: z.boolean(),
  staleAfterHours: z.number().int().min(1).max(720),
});

export type BackupRow = {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: string;
  trigger: string;
  folderName: string;
  databaseBytes: bigint | null;
  storageBytes: bigint | null;
  storageFiles: number | null;
  errorText: string | null;
  deletedAt: Date | null;
  actor: { fullName: string } | null;
};

/**
 * Một lượt sao lưu tại một thời điểm: chạy hai lượt song song vừa tốn tài
 * nguyên vừa dễ ra bản dở dang.
 */
let current: Promise<BackupRow> | null = null;

export type RunOptions = { trigger: "MANUAL" | "SCHEDULED"; actorId: string | null; requestId?: string | null };

export function isRunning(): boolean {
  return current !== null;
}

export async function runBackup(options: RunOptions): Promise<BackupRow> {
  if (current) throw AppError.invalidState("Đang có một lượt sao lưu chạy, chờ xong rồi thử lại");
  current = execute(options).finally(() => {
    current = null;
  });
  return current;
}

async function execute({ trigger, actorId, requestId = null }: RunOptions): Promise<BackupRow> {
  const settings = await getSetting(BACKUP_SETTINGS_KEY, null);
  const startedAt = new Date();
  const paths = await freePaths(startedAt);
  const backup = await prisma.backup.create({
    data: { startedAt, status: "RUNNING", trigger, actorId, folderName: paths.folderName },
  });

  try {
    await ensureFolder(paths.folder);
    await runners.dumpDatabase(paths.dumpFile);
    const dumpInfo = await stat(paths.dumpFile);
    const storage = settings.includeStorage ? await runners.copyStorage(paths.storageFolder) : { bytes: 0, files: 0 };

    const saved = await prisma.backup.update({
      where: { id: backup.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        databaseBytes: BigInt(dumpInfo.size),
        storageBytes: BigInt(storage.bytes),
        storageFiles: storage.files,
      },
      include: { actor: { select: { fullName: true } } },
    });
    await writeAudit(actorId, "BACKUP_RUN", backup.id, requestId, {
      trigger,
      folderName: paths.folderName,
      databaseBytes: dumpInfo.size,
      storageBytes: storage.bytes,
      storageFiles: storage.files,
    });
    await pruneOld(settings.keepCount);
    return saved;
  } catch (error) {
    // Bản dở dang không phục hồi được, giữ lại chỉ gây nhầm lẫn khi cần dùng.
    await removeFolder(paths.folder);
    const message = error instanceof Error ? error.message : String(error);
    await prisma.backup.update({
      where: { id: backup.id },
      data: { status: "FAILED", finishedAt: new Date(), errorText: message.slice(0, 1000), deletedAt: new Date() },
    });
    await writeAudit(actorId, "BACKUP_FAILED", backup.id, requestId, { trigger, error: message.slice(0, 1000) });
    throw error;
  }
}

/** Tên thư mục tính theo giây, nên hai lượt sát nhau cần thêm hậu tố. */
async function freePaths(startedAt: Date) {
  const base = backupPaths(startedAt);
  for (let suffix = 1; suffix < 100; suffix++) {
    const folderName = suffix === 1 ? base.folderName : `${base.folderName}-${suffix}`;
    const taken = await prisma.backup.findUnique({ where: { folderName }, select: { id: true } });
    if (!taken) return { ...backupPaths(startedAt), ...pathsFor(folderName) };
  }
  throw AppError.invalidState("Không đặt được tên thư mục sao lưu, thử lại sau một phút");
}

function pathsFor(folderName: string) {
  const folder = path.join(backupRoot(), folderName);
  return { folderName, folder, dumpFile: path.join(folder, DUMP_FILE), storageFolder: path.join(folder, STORAGE_DIR) };
}

async function writeAudit(actorId: string | null, action: string, resourceId: string, requestId: string | null, after: object): Promise<void> {
  await prisma.auditLog.create({
    data: { storeId: null, actorId, action, resourceType: "backup", resourceId, requestId, after },
  });
}

/** Giữ lại `keepCount` bản thành công gần nhất, xóa tệp của bản cũ hơn. */
export async function pruneOld(keepCount: number): Promise<number> {
  const olds = await prisma.backup.findMany({
    where: { status: "SUCCESS", deletedAt: null },
    orderBy: { startedAt: "desc" },
    skip: keepCount,
    select: { id: true, folderName: true },
  });
  for (const old of olds) {
    await removeFolder(path.join(backupRoot(), old.folderName));
    await prisma.backup.update({ where: { id: old.id }, data: { deletedAt: new Date() } });
  }
  return olds.length;
}

export async function listBackups(limit = 30): Promise<BackupRow[]> {
  return prisma.backup.findMany({
    orderBy: { startedAt: "desc" },
    take: limit,
    include: { actor: { select: { fullName: true } } },
  });
}

/** Lần chạy kế tiếp theo lịch, tính theo giờ Việt Nam. */
export function nextRunAt(settings: BackupSettings, now = new Date()): Date | null {
  if (!settings.enabled) return null;
  const next = new Date(now.getTime());
  // Giờ Việt Nam (UTC+7) quy về UTC để không phụ thuộc múi giờ của máy chủ.
  next.setUTCHours(settings.hour - 7, settings.minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export type BackupStatus = {
  settings: BackupSettings;
  running: boolean;
  lastSuccessAt: Date | null;
  /** Số giờ kể từ lần sao lưu thành công gần nhất; null khi chưa có bản nào. */
  hoursSinceLastSuccess: number | null;
  lastAttempt: BackupRow | null;
  isStale: boolean;
  nextRunAt: Date | null;
  keptCount: number;
  totalBytes: number;
  backupDir: string;
  /** "docker" khi CSDL chạy trong container, "local" khi PostgreSQL cài trên máy. */
  toolMode: "docker" | "local";
  restoreCommands: string[];
};

export async function getStatus(): Promise<BackupStatus> {
  const settings = await getSetting(BACKUP_SETTINGS_KEY, null);
  const [lastSuccess, lastAttempt, kept] = await Promise.all([
    prisma.backup.findFirst({ where: { status: "SUCCESS" }, orderBy: { startedAt: "desc" } }),
    prisma.backup.findFirst({ orderBy: { startedAt: "desc" }, include: { actor: { select: { fullName: true } } } }),
    prisma.backup.findMany({
      where: { status: "SUCCESS", deletedAt: null },
      select: { databaseBytes: true, storageBytes: true },
    }),
  ]);

  const staleMs = settings.staleAfterHours * 3_600_000;
  return {
    settings,
    running: isRunning(),
    lastSuccessAt: lastSuccess?.startedAt ?? null,
    hoursSinceLastSuccess: lastSuccess ? Math.floor((Date.now() - lastSuccess.startedAt.getTime()) / 3_600_000) : null,
    lastAttempt,
    isStale: !lastSuccess || Date.now() - lastSuccess.startedAt.getTime() > staleMs,
    nextRunAt: nextRunAt(settings),
    keptCount: kept.length,
    totalBytes: kept.reduce((sum, row) => sum + Number(row.databaseBytes ?? 0n) + Number(row.storageBytes ?? 0n), 0),
    backupDir: backupRoot(),
    toolMode: env.BACKUP_DOCKER_CONTAINER ? "docker" : "local",
    restoreCommands: restoreCommands(lastSuccess?.folderName ?? "<thư mục bản sao lưu>"),
  };
}

export type DownloadTarget = { filePath: string; fileName: string };

/** Tệp dump để tải về máy khác hoặc USB — sao lưu cùng ổ đĩa không cứu được khi hỏng ổ. */
export async function resolveDownload(id: string): Promise<DownloadTarget> {
  const backup = await prisma.backup.findUnique({ where: { id } });
  if (!backup) throw AppError.notFound("Không tìm thấy bản sao lưu");
  if (backup.status !== "SUCCESS") throw AppError.invalidState("Lượt sao lưu này không thành công, không có tệp để tải");
  if (backup.deletedAt) throw AppError.invalidState("Tệp của bản sao lưu này đã được dọn theo số bản được giữ");

  const filePath = path.join(backupRoot(), backup.folderName, DUMP_FILE);
  const info = await stat(filePath).catch(() => null);
  if (!info) throw AppError.invalidState("Không còn tệp trên đĩa — có thể thư mục sao lưu đã bị di chuyển hoặc xóa tay");
  return { filePath, fileName: `${backup.folderName}.dump` };
}

export async function saveSettings(input: BackupSettings, actorId: string, requestId: string | null): Promise<BackupSettings> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.setting.findFirst({ where: { key: BACKUP_SETTINGS_KEY, storeId: null } });
    const saved = existing
      ? await tx.setting.update({ where: { id: existing.id }, data: { value: input, updatedBy: actorId } })
      : await tx.setting.create({ data: { key: BACKUP_SETTINGS_KEY, storeId: null, value: input, updatedBy: actorId } });
    await tx.auditLog.create({
      data: {
        storeId: null,
        actorId,
        action: "SETTING_UPDATE",
        resourceType: "setting",
        resourceId: saved.id,
        requestId,
        after: { key: BACKUP_SETTINGS_KEY, ...input },
      },
    });
  });
  return input;
}
