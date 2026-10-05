import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { buildClient } from "./einvoice-config.service.js";
import { buildMisaInvoice } from "./einvoice-payload.js";
import { EInvoiceError, type MisaClient } from "./misa-client.js";

/**
 * Hàng đợi phát hành hóa đơn điện tử, theo từng cửa hàng.
 *
 * Phát hành không nằm trong đường bán hàng: mất mạng hay MISA lỗi đều không
 * chặn bán thuốc. Một lượt chạy gồm: quét hóa đơn mới → phát hành → hỏi mã
 * cơ quan thuế.
 */

const BACKOFF_MINUTES = [1, 5, 15, 60, 6 * 60];

function nextAttempt(attempts: number): Date {
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)]!;
  return new Date(Date.now() + minutes * 60_000);
}

async function enabledConfigs(storeId?: string) {
  return prisma.eInvoiceStoreConfig.findMany({
    where: { enabled: true, enabledFrom: { not: null }, ...(storeId ? { storeId } : {}) },
  });
}

export type ScanResult = { created: number; cancelled: number; flagged: number };

/**
 * Tạo việc phát hành cho hóa đơn hoàn tất từ mốc bật trở đi; đánh dấu các
 * trường hợp hóa đơn bán thay đổi sau đó:
 *   - Hủy trước khi phát hành: bỏ việc (CANCELLED), không phát hành.
 *   - Hủy hoặc trả hàng SAU khi đã phát hành: ghi `review_reason` để người
 *     có thẩm quyền lập hóa đơn điều chỉnh/thay thế. Không tự suy diễn.
 */
export async function scanInvoices(storeId?: string): Promise<ScanResult> {
  const result: ScanResult = { created: 0, cancelled: 0, flagged: 0 };

  for (const config of await enabledConfigs(storeId)) {
    const fresh = await prisma.invoice.findMany({
      where: {
        storeId: config.storeId,
        status: "COMPLETED",
        soldAt: { gte: config.enabledFrom! },
        eInvoice: null,
      },
      select: { id: true },
    });
    if (fresh.length) {
      const created = await prisma.eInvoice.createMany({
        data: fresh.map((invoice) => ({ storeId: config.storeId, invoiceId: invoice.id })),
        skipDuplicates: true,
      });
      result.created += created.count;
    }
  }

  const scope = storeId ? { storeId } : {};
  const cancelled = await prisma.eInvoice.updateMany({
    where: {
      ...scope,
      status: { in: ["PENDING", "FAILED"] },
      invoice: { status: { not: "COMPLETED" } },
    },
    data: {
      status: "CANCELLED",
      settledAt: new Date(),
      lastError: "Hóa đơn bán đã hủy trước khi phát hành",
    },
  });
  result.cancelled = cancelled.count;

  const published = { ...scope, status: { in: ["PUBLISHED", "COMPLETED"] }, reviewReason: null };
  const voided = await prisma.eInvoice.updateMany({
    where: { ...published, invoice: { status: { not: "COMPLETED" } } },
    data: {
      reviewReason:
        "Hóa đơn bán đã hủy sau khi phát hành: cần lập hóa đơn điều chỉnh hoặc thay thế",
    },
  });
  const returned = await prisma.eInvoice.updateMany({
    where: { ...published, invoice: { returnStatus: { not: "NONE" } } },
    data: { reviewReason: "Khách trả hàng sau khi phát hành: cần lập hóa đơn điều chỉnh" },
  });
  result.flagged = voided.count + returned.count;

  return result;
}

export type DrainResult = {
  published: number;
  failed: number;
  rejected: number;
  cancelled: number;
};

async function publishOne(
  client: MisaClient,
  jobId: string,
  invSeries: string,
): Promise<keyof DrainResult | null> {
  // Giữ chỗ: chỉ một lượt được gửi một việc, kể cả khi hai lượt chạy chồng nhau.
  const claimed = await prisma.eInvoice.updateMany({
    where: { id: jobId, status: { in: ["PENDING", "FAILED"] } },
    data: { status: "SENDING" },
  });
  if (claimed.count === 0) return null;
  const job = await prisma.eInvoice.findUniqueOrThrow({ where: { id: jobId } });

  try {
    // Lần gửi trước có thể đã tới MISA nhưng mất phản hồi: hỏi trước theo RefID
    // để không phát hành trùng một hóa đơn.
    if (job.attempts > 0) {
      const [found] = await client.fetchStatuses([job.invoiceId]);
      if (found?.transactionId) {
        await prisma.eInvoice.update({
          where: { id: jobId },
          data: {
            status: "PUBLISHED",
            transactionId: found.transactionId,
            publishedAt: new Date(),
            lastError: null,
            nextAttemptAt: new Date(),
          },
        });
        return "published";
      }
    }

    const built = await buildMisaInvoice(job.invoiceId, invSeries);
    if (!built.ok) {
      const invoice = await prisma.invoice.findUnique({
        where: { id: job.invoiceId },
        select: { status: true },
      });
      const voided = invoice && invoice.status !== "COMPLETED";
      await prisma.eInvoice.update({
        where: { id: jobId },
        data: {
          status: voided ? "CANCELLED" : "REJECTED",
          lastError: built.message,
          settledAt: new Date(),
        },
      });
      return voided ? "cancelled" : "rejected";
    }

    const ack = await client.publish(built.payload);
    await prisma.eInvoice.update({
      where: { id: jobId },
      data: {
        status: "PUBLISHED",
        attempts: { increment: 1 },
        transactionId: ack.transactionId,
        invSeries: ack.invSeries ?? invSeries,
        invNo: ack.invNo,
        sentPayload: built.payload as object,
        publishedAt: new Date(),
        lastError: null,
        // Mã cơ quan thuế thường có sau ít phút; hỏi lại sau 1 phút.
        nextAttemptAt: new Date(Date.now() + 60_000),
      },
    });
    return "published";
  } catch (error) {
    const permanent = error instanceof EInvoiceError && error.kind === "REJECTED";
    await prisma.eInvoice.update({
      where: { id: jobId },
      data: {
        status: permanent ? "REJECTED" : "FAILED",
        attempts: { increment: 1 },
        lastError: error instanceof Error ? error.message : String(error),
        ...(permanent ? { settledAt: new Date() } : { nextAttemptAt: nextAttempt(job.attempts) }),
      },
    });
    return permanent ? "rejected" : "failed";
  }
}

export async function drainQueue(limit = 25, storeId?: string): Promise<DrainResult> {
  const result: DrainResult = { published: 0, failed: 0, rejected: 0, cancelled: 0 };
  for (const config of await enabledConfigs(storeId)) {
    const client = await buildClient(config.storeId);
    if (!client || !config.invSeries) continue;
    const due = await prisma.eInvoice.findMany({
      where: {
        storeId: config.storeId,
        status: { in: ["PENDING", "FAILED"] },
        nextAttemptAt: { lte: new Date() },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true },
    });
    for (const job of due) {
      const outcome = await publishOne(client, job.id, config.invSeries);
      if (outcome) result[outcome] += 1;
    }
  }
  return result;
}

export type PollResult = { checked: number; completed: number; rejected: number };

/** Hỏi mã cơ quan thuế cho hóa đơn đã phát hành. */
export async function pollStatuses(
  limit = 50,
  options: { force?: boolean; storeId?: string } = {},
): Promise<PollResult> {
  const result: PollResult = { checked: 0, completed: 0, rejected: 0 };
  for (const config of await enabledConfigs(options.storeId)) {
    const client = await buildClient(config.storeId);
    if (!client) continue;
    const pending = await prisma.eInvoice.findMany({
      where: {
        storeId: config.storeId,
        status: "PUBLISHED",
        ...(options.force ? {} : { nextAttemptAt: { lte: new Date() } }),
      },
      orderBy: { publishedAt: "asc" },
      take: limit,
    });
    if (pending.length === 0) continue;

    let statuses;
    try {
      statuses = await client.fetchStatuses(pending.map((job) => job.invoiceId));
    } catch (error) {
      await prisma.eInvoice.updateMany({
        where: { id: { in: pending.map((job) => job.id) } },
        data: {
          lastError: error instanceof Error ? error.message : String(error),
          nextAttemptAt: new Date(Date.now() + 5 * 60_000),
        },
      });
      continue;
    }

    for (const job of pending) {
      result.checked += 1;
      const status = statuses.find(
        (item) =>
          item.refId === job.invoiceId ||
          (item.transactionId && item.transactionId === job.transactionId),
      );
      if (status?.sendTaxStatus === 2 && status.taxAuthorityCode) {
        await prisma.eInvoice.update({
          where: { id: job.id },
          data: {
            status: "COMPLETED",
            taxAuthorityCode: status.taxAuthorityCode,
            settledAt: new Date(),
            lastError: null,
          },
        });
        result.completed += 1;
      } else if (status?.sendTaxStatus === 3) {
        await prisma.eInvoice.update({
          where: { id: job.id },
          data: {
            status: "REJECTED",
            lastError: "Cơ quan thuế từ chối cấp mã cho hóa đơn",
            settledAt: new Date(),
          },
        });
        result.rejected += 1;
      } else {
        await prisma.eInvoice.update({
          where: { id: job.id },
          data: {
            lastError:
              status?.sendTaxStatus === 1 ? "MISA gửi cơ quan thuế bị lỗi, đang chờ gửi lại" : null,
            nextAttemptAt: new Date(Date.now() + 5 * 60_000),
          },
        });
      }
    }
  }
  return result;
}

/** Đưa việc lỗi hoặc bị từ chối về hàng chờ, sau khi đã sửa dữ liệu hay cấu hình. */
export async function retryJob(jobId: string, userId: string, storeId: string): Promise<void> {
  const job = await prisma.eInvoice.findUnique({ where: { id: jobId } });
  if (!job || job.storeId !== storeId) throw AppError.notFound("Không tìm thấy hóa đơn điện tử");
  if (!["FAILED", "REJECTED"].includes(job.status)) {
    throw AppError.invalidState("Chỉ gửi lại được hóa đơn điện tử đang lỗi hoặc bị từ chối");
  }
  await prisma.eInvoice.update({
    where: { id: jobId },
    data: { status: "PENDING", nextAttemptAt: new Date(), lastError: null, settledAt: null },
  });
  await prisma.auditLog.create({
    data: {
      storeId,
      actorId: userId,
      action: "EINVOICE_RETRY",
      resourceType: "e_invoice",
      resourceId: jobId,
      after: { invoiceId: job.invoiceId, previousStatus: job.status },
    },
  });
}

export async function summary(storeId: string) {
  const grouped = await prisma.eInvoice.groupBy({
    by: ["status"],
    where: { storeId },
    _count: true,
  });
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of grouped) {
    const count = typeof row._count === "number" ? row._count : 0;
    byStatus[row.status] = count;
    total += count;
  }
  const needsReview = await prisma.eInvoice.count({
    where: { storeId, reviewReason: { not: null } },
  });
  return { total, byStatus, needsReview };
}
