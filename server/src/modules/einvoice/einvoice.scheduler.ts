import { prisma } from "../../db/prisma.js";
import { drainQueue, pollStatuses, scanInvoices } from "./einvoice-queue.service.js";

/**
 * Bộ chạy nền hóa đơn điện tử: mỗi phút quét hóa đơn mới, phát hành, rồi hỏi
 * mã cơ quan thuế. Một phút vì hóa đơn máy tính tiền nên có ngay sau khi bán,
 * khách có thể cần tra cứu sớm.
 */
const TICK_MS = 60_000;

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  if ((await prisma.eInvoiceStoreConfig.count({ where: { enabled: true } })) === 0) return;
  running = true;
  try {
    await scanInvoices();
    await drainQueue();
    await pollStatuses();
  } finally {
    running = false;
  }
}

export function startEInvoiceScheduler(): () => void {
  const timer = setInterval(() => {
    void tick().catch((error: unknown) => {
      console.error(
        "Phát hành hóa đơn điện tử thất bại:",
        error instanceof Error ? error.message : error,
      );
    });
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
