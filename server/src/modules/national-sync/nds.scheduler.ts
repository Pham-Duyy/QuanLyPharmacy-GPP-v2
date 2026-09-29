import { readConfigRow } from "./nds-config.service.js";
import { drainQueue, pollStatuses, scanDocuments } from "./nds-queue.service.js";

/**
 * Bộ chạy nền của liên thông CSDL Dược: mỗi lượt quét chứng từ mới, gửi những
 * việc tới hạn rồi hỏi lại trạng thái các chứng từ đã gửi.
 *
 * Năm phút một lượt là đủ: nghĩa vụ liên thông tính theo ngày, không theo
 * phút, mà API lại có giới hạn tần suất nên gọi dày chỉ tăng rủi ro bị chặn.
 * Muốn gửi ngay thì có nút "Gửi ngay" ở màn liên thông.
 */
const TICK_MS = 5 * 60_000;

let running = false;

async function tick(): Promise<void> {
  // Lượt trước chưa xong thì bỏ lượt này: không chạy chồng.
  if (running) return;
  const config = await readConfigRow();
  if (!config.enabled) return;

  running = true;
  try {
    await scanDocuments();
    await drainQueue();
    await pollStatuses();
  } finally {
    running = false;
  }
}

export function startNationalSyncScheduler(): () => void {
  const timer = setInterval(() => {
    void tick().catch((error: unknown) => {
      console.error(
        "Liên thông CSDL Dược thất bại:",
        error instanceof Error ? error.message : error,
      );
    });
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
