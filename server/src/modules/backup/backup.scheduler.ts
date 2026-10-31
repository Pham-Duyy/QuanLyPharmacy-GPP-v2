import { env } from "../../config/env.js";
import { listBackups } from "./backup-file.js";
import { backupDir, createBackup } from "./backup.service.js";

/**
 * Sao lưu tự động mỗi ngày (Phase 7, D30). Mỗi phút xem đã tới giờ
 * BACKUP_TIME (giờ Việt Nam) chưa và hôm nay đã có bản tự động chưa. Máy tắt
 * lúc 23:00 thì lần bật sau trong ngày sẽ sao lưu bù; qua ngày mới thì thôi.
 */
const TICK_MS = 60_000;
/** Lỗi thì đợi 30 phút mới thử lại, không thử mỗi phút. */
const RETRY_AFTER_MS = 30 * 60_000;

let lastFailureAt = 0;

function vnNow(): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
  const [day = "", time = ""] = parts.split(" ");
  return { day: day.replace(/-/g, ""), time };
}

async function tick(): Promise<void> {
  const now = vnNow();
  if (now.time < env.BACKUP_TIME) return;
  if (Date.now() - lastFailureAt < RETRY_AFTER_MS) return;
  const items = await listBackups(backupDir());
  if (items.some((item) => item.kind === "auto" && item.name.startsWith(`sao-luu-${now.day}-`)))
    return;
  try {
    const result = await createBackup("auto", null);
    console.log(`Đã sao lưu tự động: ${result.name} (${result.rows} dòng, ${result.files} tệp)`);
  } catch (error) {
    lastFailureAt = Date.now();
    throw error;
  }
}

export function startBackupScheduler(): () => void {
  if (!env.BACKUP_AUTO) return () => {};
  const timer = setInterval(() => {
    void tick().catch((error: unknown) => {
      console.error("Sao lưu tự động thất bại:", error instanceof Error ? error.message : error);
    });
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
