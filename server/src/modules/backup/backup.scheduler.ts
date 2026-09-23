import { prisma } from "../../db/prisma.js";
import { getSetting } from "../../lib/settings.js";
import { BACKUP_SETTINGS_KEY, runBackup } from "./backup.service.js";

const TICK_MS = 60_000;

/** Mốc chạy của hôm nay theo giờ Việt Nam, quy về UTC. */
function todaySlot(hour: number, minute: number, now: Date): Date {
  const slot = new Date(now.getTime());
  slot.setUTCHours(hour - 7, minute, 0, 0);
  // hour - 7 có thể âm: setUTCHours tự lùi sang ngày hôm trước, đúng ý.
  return slot;
}

async function tick(): Promise<void> {
  const settings = await getSetting(BACKUP_SETTINGS_KEY, null);
  if (!settings.enabled) return;

  const now = new Date();
  const slot = todaySlot(settings.hour, settings.minute, now);
  if (now.getTime() < slot.getTime()) return;

  // Đã có lượt theo lịch sau mốc hôm nay thì thôi. Máy tắt lúc đến giờ thì
  // lần bật máy tiếp theo trong ngày vẫn chạy bù một lượt.
  const last = await prisma.backup.findFirst({ where: { trigger: "SCHEDULED" }, orderBy: { startedAt: "desc" } });
  if (last && last.startedAt.getTime() >= slot.getTime()) return;

  await runBackup({ trigger: "SCHEDULED", actorId: null });
}

/**
 * Bộ hẹn giờ sao lưu: kiểm tra mỗi phút thay vì giữ một cron trong bộ nhớ,
 * nhờ vậy khởi động lại máy chủ không làm mất lịch và không cần thư viện ngoài.
 */
export function startBackupScheduler(): () => void {
  const timer = setInterval(() => {
    void tick().catch((error: unknown) => {
      console.error("Sao lưu theo lịch thất bại:", error instanceof Error ? error.message : error);
    });
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
