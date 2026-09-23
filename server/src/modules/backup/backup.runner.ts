import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";

const SERVER_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Thư mục chứa các bản sao lưu; đường dẫn tương đối tính từ thư mục server. */
export const backupRoot = (): string => path.resolve(SERVER_ROOT, env.BACKUP_DIR);

/** Thư mục ảnh đơn thuốc, ảnh sản phẩm — phải sao lưu cùng CSDL mới phục hồi đủ. */
export const storageRoot = (): string => path.join(SERVER_ROOT, "storage");

export const DUMP_FILE = "database.dump";
export const STORAGE_DIR = "storage";

export type BackupPaths = { folderName: string; folder: string; dumpFile: string; storageFolder: string };

/** Tên thư mục theo thời điểm bắt đầu, giờ Việt Nam: sao-luu-2026-09-23-2200. */
export function backupPaths(startedAt: Date): BackupPaths {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(startedAt);
  const [day, time] = parts.split(" ");
  const folderName = `sao-luu-${day}-${(time ?? "").replace(/:/g, "")}`;
  const folder = path.join(backupRoot(), folderName);
  return { folderName, folder, dumpFile: path.join(folder, DUMP_FILE), storageFolder: path.join(folder, STORAGE_DIR) };
}

/**
 * Chạy pg_dump. PostgreSQL cài trực tiếp thì gọi thẳng; chạy bằng Docker thì
 * gọi pg_dump bên trong container rồi hứng dữ liệu ra tệp trên máy — nhờ vậy
 * máy không cần cài PostgreSQL client.
 */
export async function dumpDatabase(targetFile: string): Promise<void> {
  const args = ["--format=custom", "--no-owner", "--no-privileges", "--dbname", env.DATABASE_URL];
  const command = env.BACKUP_DOCKER_CONTAINER ? "docker" : env.BACKUP_PG_DUMP;
  const commandArgs = env.BACKUP_DOCKER_CONTAINER ? ["exec", env.BACKUP_DOCKER_CONTAINER, "pg_dump", ...args] : args;

  const child = spawn(command, commandArgs, { windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    // Giữ phần cuối: thông điệp lỗi thật của pg_dump nằm ở cuối.
    stderr = `${stderr}${chunk.toString()}`.slice(-4000);
  });

  const writing = pipeline(child.stdout, createWriteStream(targetFile));
  const exit = new Promise<number>((resolve, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new AppError(
              500,
              "BACKUP_TOOL_MISSING",
              env.BACKUP_DOCKER_CONTAINER
                ? `Không gọi được Docker. Kiểm tra Docker Desktop đang chạy và container "${env.BACKUP_DOCKER_CONTAINER}" đang bật.`
                : `Không tìm thấy lệnh "${env.BACKUP_PG_DUMP}". Cài PostgreSQL client hoặc đặt BACKUP_PG_DUMP trỏ tới pg_dump.exe; nếu CSDL chạy bằng Docker thì đặt BACKUP_DOCKER_CONTAINER.`,
            )
          : error,
      );
    });
    child.on("close", resolve);
  });

  const [, code] = await Promise.all([writing, exit]);
  if (code !== 0) {
    throw new AppError(500, "BACKUP_FAILED", `pg_dump dừng với mã ${code}. ${stderr.trim().split("\n").slice(-3).join(" ")}`.trim());
  }
  const info = await stat(targetFile);
  if (info.size === 0) throw new AppError(500, "BACKUP_FAILED", "pg_dump không ghi được dữ liệu nào");
}

export type CopyResult = { bytes: number; files: number };

/** Sao chép thư mục ảnh; chưa có ảnh nào thì trả về 0 chứ không coi là lỗi. */
export async function copyStorage(targetFolder: string): Promise<CopyResult> {
  const source = storageRoot();
  const exists = await stat(source).catch(() => null);
  if (!exists?.isDirectory()) return { bytes: 0, files: 0 };
  await cp(source, targetFolder, { recursive: true });
  return measureFolder(targetFolder);
}

export async function measureFolder(folder: string): Promise<CopyResult> {
  let bytes = 0;
  let files = 0;
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      const nested = await measureFolder(target);
      bytes += nested.bytes;
      files += nested.files;
    } else {
      const info = await stat(target).catch(() => null);
      if (info) {
        bytes += info.size;
        files += 1;
      }
    }
  }
  return { bytes, files };
}

export async function ensureFolder(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true });
}

export async function removeFolder(folder: string): Promise<void> {
  await rm(folder, { recursive: true, force: true });
}

/**
 * Câu lệnh phục hồi, ghép sẵn đường dẫn thật của máy đang chạy. Cố ý không
 * làm nút "phục hồi" trên giao diện: phục hồi ghi đè toàn bộ dữ liệu đang
 * chạy, phải là việc có chủ đích, làm khi đã đóng cửa hàng.
 */
export function restoreCommands(folderName: string): string[] {
  const folder = path.join(backupRoot(), folderName);
  const dump = path.join(folder, DUMP_FILE);
  const database = env.DATABASE_URL.split("/").pop()?.split("?")[0] ?? "pharmacy_gpp";
  return env.BACKUP_DOCKER_CONTAINER
    ? [
        `docker cp "${dump}" ${env.BACKUP_DOCKER_CONTAINER}:/tmp/${DUMP_FILE}`,
        `docker exec ${env.BACKUP_DOCKER_CONTAINER} pg_restore --clean --if-exists --no-owner --dbname ${database} /tmp/${DUMP_FILE}`,
        `Chép thư mục "${path.join(folder, STORAGE_DIR)}" đè lên "${storageRoot()}"`,
      ]
    : [
        `pg_restore --clean --if-exists --no-owner --dbname "${env.DATABASE_URL}" "${dump}"`,
        `Chép thư mục "${path.join(folder, STORAGE_DIR)}" đè lên "${storageRoot()}"`,
      ];
}
