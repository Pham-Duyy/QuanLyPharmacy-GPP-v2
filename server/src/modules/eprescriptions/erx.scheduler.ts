import { prisma } from "../../db/prisma.js";
import { drainQueue, scanInvoices } from "./erx-queue.service.js";

/**
 * Bộ chạy nền báo "đã bán" lên Hệ thống đơn thuốc quốc gia: mỗi phút quét hóa
 * đơn bán theo đơn điện tử rồi gửi. Chưa bật kết nối thì không làm gì.
 */
const TICK_MS = 60_000;

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  const config = await prisma.ePrescriptionConfig.findUnique({
    where: { id: 1 },
    select: { enabled: true },
  });
  if (!config?.enabled) return;
  running = true;
  try {
    await scanInvoices();
    await drainQueue();
  } finally {
    running = false;
  }
}

export function startEPrescriptionScheduler(): () => void {
  const timer = setInterval(() => {
    void tick().catch((error: unknown) => {
      console.error(
        "Báo bán đơn thuốc điện tử thất bại:",
        error instanceof Error ? error.message : error,
      );
    });
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
