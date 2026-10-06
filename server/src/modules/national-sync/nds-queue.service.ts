import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { NdsError, type NdsClient } from "./nds-client.js";
import { buildClient, enabledStoreConfigs } from "./nds-config.service.js";
import {
  buildCustomerReturnPayload,
  buildGoodsReceiptPayload,
  buildInvoicePayload,
  buildStockCountPayload,
  buildSupplierReturnPayload,
  buildTransferInPayload,
  buildTransferOutPayload,
  isoDate,
  type BuildResult,
} from "./nds-payload.js";

/**
 * Hộp thư đi.
 *
 * Chứng từ KHÔNG được đẩy vào hàng đợi ngay trong giao dịch bán hàng hay nhập
 * hàng. Thay vào đó một lượt quét định kỳ đối chiếu chứng từ đã lưu với hàng
 * đợi và tạo việc cho những chứng từ chưa có. Đổi lại:
 *
 *   - Đường bán hàng không đụng gì tới mã liên thông: CSDL Dược sập, mạng đứt
 *     hay token hết hạn đều không ảnh hưởng tới việc bán.
 *   - Không mất chứng từ. Máy chủ tắt giữa chừng thì lượt quét sau vẫn tìm ra,
 *     vì nguồn sự thật là bảng chứng từ chứ không phải hàng đợi.
 */

export type JobKind = "STOCK_IN" | "STOCK_OUT" | "STOCK_TAKING";

type SourceSpec = {
  sourceType: string;
  kind: JobKind;
  reason: string;
  build: (sourceId: string) => Promise<BuildResult>;
};

const SOURCES: Record<string, SourceSpec> = {
  goods_receipt: {
    sourceType: "goods_receipt",
    kind: "STOCK_IN",
    reason: "supplier",
    build: buildGoodsReceiptPayload,
  },
  invoice: {
    sourceType: "invoice",
    kind: "STOCK_OUT",
    reason: "sale-retail",
    build: buildInvoicePayload,
  },
  customer_return: {
    sourceType: "customer_return",
    kind: "STOCK_IN",
    reason: "return",
    build: buildCustomerReturnPayload,
  },
  supplier_return: {
    sourceType: "supplier_return",
    kind: "STOCK_OUT",
    reason: "return",
    build: buildSupplierReturnPayload,
  },
  stock_transfer_out: {
    sourceType: "stock_transfer_out",
    kind: "STOCK_OUT",
    reason: "transfer-out",
    build: buildTransferOutPayload,
  },
  stock_transfer_in: {
    sourceType: "stock_transfer_in",
    kind: "STOCK_IN",
    reason: "transfer-in",
    build: buildTransferInPayload,
  },
  stock_count: {
    sourceType: "stock_count",
    kind: "STOCK_TAKING",
    reason: "stock-taking",
    build: buildStockCountPayload,
  },
};

/** Giãn dần khi gặp lỗi tạm thời; không thử lại dồn dập. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 6 * 60, 24 * 60];

function nextAttempt(attempts: number): Date {
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)]!;
  return new Date(Date.now() + minutes * 60 * 1000);
}

// --- Quét chứng từ ----------------------------------------------------------

export type ScanResult = {
  created: number;
  byType: Record<string, number>;
  /** Chứng từ đã gửi nhưng sau đó bị hủy — phải xử lý bằng tay. */
  needsReview: number;
};

/**
 * Hóa đơn bị hủy sau khi đã gửi lên.
 *
 * Hệ thống quốc gia không có API xóa, và tài liệu cũng không nói cách rút lại
 * một chứng từ đã gửi. Gửi lại phiếu rỗng hay bịa ra một phiếu xuất ngược đều
 * là tự suy diễn nghiệp vụ dược, nên phần mềm **không đoán**: nó đánh dấu
 * chứng từ để dược sĩ tự xử lý trên cổng csdlduoc.com.vn.
 */
async function flagVoidedInvoices(): Promise<number> {
  const sentInvoiceJobs = await prisma.nationalSyncJob.findMany({
    where: {
      sourceType: "invoice",
      status: { in: ["ACCEPTED", "PROCESSING", "COMPLETED"] },
    },
    select: { id: true, sourceId: true, referenceNumber: true },
  });
  if (sentInvoiceJobs.length === 0) return 0;

  const voided = await prisma.invoice.findMany({
    where: { id: { in: sentInvoiceJobs.map((job) => job.sourceId) }, status: { not: "COMPLETED" } },
    select: { id: true },
  });
  if (voided.length === 0) return 0;

  const voidedIds = new Set(voided.map((invoice) => invoice.id));
  const affected = sentInvoiceJobs.filter((job) => voidedIds.has(job.sourceId));

  await prisma.nationalSyncJob.updateMany({
    where: { id: { in: affected.map((job) => job.id) } },
    data: {
      status: "NEEDS_REVIEW",
      lastError:
        "Hóa đơn đã bị hủy sau khi gửi lên CSDL Dược. Tài liệu API chưa quy định cách rút lại chứng từ đã gửi — hãy chỉnh trực tiếp trên cổng csdlduoc.com.vn hoặc gọi 19008255.",
    },
  });

  return affected.length;
}

/**
 * Phiếu chuyển đã gửi phiếu xuất lên rồi mới bị cửa hàng gửi thu hồi (hàng về
 * lại kho). Cùng lý do như hóa đơn bị hủy: không có API rút chứng từ, phần mềm
 * không tự bịa phiếu nhập bù mà đánh dấu để dược sĩ xử lý trên cổng.
 */
async function flagCancelledTransfers(): Promise<number> {
  const sent = await prisma.nationalSyncJob.findMany({
    where: {
      sourceType: "stock_transfer_out",
      status: { in: ["ACCEPTED", "PROCESSING", "COMPLETED"] },
    },
    select: { id: true, sourceId: true },
  });
  if (sent.length === 0) return 0;

  const cancelled = await prisma.stockTransfer.findMany({
    where: { id: { in: sent.map((job) => job.sourceId) }, status: "CANCELLED" },
    select: { id: true },
  });
  if (cancelled.length === 0) return 0;

  const ids = new Set(cancelled.map((row) => row.id));
  const affected = sent.filter((job) => ids.has(job.sourceId));
  await prisma.nationalSyncJob.updateMany({
    where: { id: { in: affected.map((job) => job.id) } },
    data: {
      status: "NEEDS_REVIEW",
      lastError:
        "Phiếu chuyển đã gửi phiếu xuất lên CSDL Dược rồi bị thu hồi, hàng đã về lại kho. Tài liệu API chưa quy định cách rút lại chứng từ đã gửi — hãy chỉnh trực tiếp trên cổng csdlduoc.com.vn hoặc gọi 19008255.",
    },
  });
  return affected.length;
}

/**
 * Tìm chứng từ đủ điều kiện liên thông mà chưa có việc trong hàng đợi.
 *
 * Mỗi cửa hàng có mốc `start_date` riêng (ngày phiếu kiểm hàng đầu kỳ của
 * cửa hàng đó): chứng từ trước mốc bị bỏ qua, cửa hàng chưa có mốc thì chưa
 * quét. `storeId` giới hạn lượt quét trong một cửa hàng.
 */
export async function scanDocuments(storeId?: string): Promise<ScanResult> {
  const result: ScanResult = { created: 0, byType: {}, needsReview: 0 };
  const configs = await prisma.nationalSyncStoreConfig.findMany({
    where: { startDate: { not: null }, ...(storeId ? { storeId } : {}) },
    select: { storeId: true, startDate: true },
  });
  if (configs.length === 0) return result;

  result.needsReview = (await flagVoidedInvoices()) + (await flagCancelledTransfers());

  // Điều kiện "cửa hàng X, từ mốc của X" cho từng cửa hàng đã có mốc.
  const since = <K extends string>(field: K) =>
    configs.map((config) => ({ storeId: config.storeId, [field]: { gte: config.startDate! } }));

  const existing = await prisma.nationalSyncJob.findMany({
    select: { sourceType: true, sourceId: true },
  });
  const seen = new Set(existing.map((job) => `${job.sourceType}:${job.sourceId}`));

  const add = async (
    sourceType: string,
    rows: Array<{ id: string; storeId: string; code: string; at: Date }>,
  ): Promise<void> => {
    const spec = SOURCES[sourceType]!;
    for (const row of rows) {
      if (seen.has(`${sourceType}:${row.id}`)) continue;
      await prisma.nationalSyncJob.create({
        data: {
          storeId: row.storeId,
          kind: spec.kind,
          sourceType,
          sourceId: row.id,
          referenceNumber: row.code,
          reason: spec.reason,
          documentDate: new Date(`${isoDate(row.at)}T00:00:00.000Z`),
        },
      });
      result.created += 1;
      result.byType[sourceType] = (result.byType[sourceType] ?? 0) + 1;
    }
  };

  const [
    receipts,
    invoices,
    customerReturns,
    supplierReturns,
    stockCounts,
    transfersOut,
    transfersIn,
  ] = await Promise.all([
    prisma.goodsReceipt.findMany({
      where: { status: "CONFIRMED", OR: since("receivedAt") },
      select: { id: true, storeId: true, code: true, receivedAt: true },
    }),
    prisma.invoice.findMany({
      where: { status: "COMPLETED", OR: since("businessDate") },
      select: { id: true, storeId: true, code: true, businessDate: true },
    }),
    prisma.return.findMany({
      where: { disposition: "RESTOCK", OR: since("businessDate") },
      select: { id: true, storeId: true, code: true, businessDate: true },
    }),
    prisma.supplierReturn.findMany({
      where: { status: "CONFIRMED", OR: since("returnedAt") },
      select: { id: true, storeId: true, code: true, returnedAt: true },
    }),
    prisma.stockCount.findMany({
      where: { status: "CLOSED", OR: since("closedAt") },
      select: { id: true, storeId: true, code: true, closedAt: true },
    }),
    // Phiếu chuyển thuộc hai cửa hàng: phiếu xuất tính cho nơi gửi từ lúc xuất
    // kho, phiếu nhập tính cho nơi nhận từ lúc nhận. Thu hồi trước khi quét thì
    // không còn ở trạng thái đã xuất nên không gửi.
    prisma.stockTransfer.findMany({
      where: {
        status: { in: ["IN_TRANSIT", "RECEIVED"] },
        OR: configs.map((config) => ({
          fromStoreId: config.storeId,
          shippedAt: { gte: config.startDate! },
        })),
      },
      select: { id: true, fromStoreId: true, code: true, shippedAt: true },
    }),
    prisma.stockTransfer.findMany({
      where: {
        status: "RECEIVED",
        lines: { some: { receivedBaseQuantity: { gt: 0 } } },
        OR: configs.map((config) => ({
          toStoreId: config.storeId,
          receivedAt: { gte: config.startDate! },
        })),
      },
      select: { id: true, toStoreId: true, code: true, receivedAt: true },
    }),
  ]);

  await add(
    "goods_receipt",
    receipts.map((r) => ({ ...r, at: r.receivedAt })),
  );
  await add(
    "invoice",
    invoices.map((r) => ({ ...r, at: r.businessDate })),
  );
  await add(
    "customer_return",
    customerReturns.map((r) => ({ ...r, at: r.businessDate })),
  );
  await add(
    "supplier_return",
    supplierReturns.map((r) => ({ ...r, at: r.returnedAt })),
  );
  await add(
    "stock_transfer_out",
    transfersOut.map((r) => ({ id: r.id, storeId: r.fromStoreId, code: r.code, at: r.shippedAt! })),
  );
  await add(
    "stock_transfer_in",
    transfersIn.map((r) => ({ id: r.id, storeId: r.toStoreId, code: r.code, at: r.receivedAt! })),
  );
  await add(
    "stock_count",
    stockCounts.map((r) => ({ ...r, at: r.closedAt! })),
  );

  return result;
}

// --- Gửi --------------------------------------------------------------------

export type DrainResult = { sent: number; blocked: number; failed: number; rejected: number };

/** Trạng thái được phép gửi (lại). */
const SENDABLE = ["PENDING", "FAILED", "BLOCKED"];

/**
 * Giành quyền gửi một việc. `updateMany` có điều kiện trạng thái nên hai tiến
 * trình cùng chạy thì chỉ một tiến trình lấy được — không gửi trùng chứng từ.
 */
async function claim(jobId: string): Promise<boolean> {
  const claimed = await prisma.nationalSyncJob.updateMany({
    where: { id: jobId, status: { in: SENDABLE } },
    data: { status: "SENDING", updatedAt: new Date() },
  });
  return claimed.count === 1;
}

type SendOutcome = { outcome: keyof DrainResult | null; rateLimited: boolean };

async function sendOne(client: NdsClient, jobId: string): Promise<SendOutcome> {
  const idle: SendOutcome = { outcome: null, rateLimited: false };
  if (!(await claim(jobId))) return idle;

  const job = await prisma.nationalSyncJob.findUnique({ where: { id: jobId } });
  if (!job) return idle;

  const spec = SOURCES[job.sourceType];
  if (!spec) {
    await prisma.nationalSyncJob.update({
      where: { id: jobId },
      data: { status: "BLOCKED", lastError: `Loại chứng từ không hỗ trợ: ${job.sourceType}` },
    });
    return { outcome: "blocked", rateLimited: false };
  }

  const built = await spec.build(job.sourceId);
  if (!built.ok) {
    await prisma.nationalSyncJob.update({
      where: { id: jobId },
      data: {
        status: "BLOCKED",
        lastError: built.message,
        messages: built.missing as object,
        // Ghép mã xong thì bấm gửi lại; không tự thử lại dồn dập.
        nextAttemptAt: nextAttempt(job.attempts),
      },
    });
    return { outcome: "blocked", rateLimited: false };
  }

  try {
    const ack = await client.submit(job.kind as JobKind, built.payload);
    await prisma.nationalSyncJob.update({
      where: { id: jobId },
      data: {
        status: "ACCEPTED",
        attempts: job.attempts + 1,
        remoteTransactionId: ack.transactionId,
        sentPayload: built.payload as object,
        lastError: null,
        messages: undefined,
        submittedAt: new Date(),
        // Hỏi trạng thái sau một phút, hệ thống quốc gia xử lý bất đồng bộ.
        nextAttemptAt: new Date(Date.now() + 60 * 1000),
      },
    });
    return { outcome: "sent", rateLimited: false };
  } catch (error) {
    const ndsError = error instanceof NdsError ? error : null;
    const message = error instanceof Error ? error.message : String(error);
    const attempts = job.attempts + 1;

    // Sai tài khoản hay dữ liệu không hợp lệ thì thử lại cũng vô ích.
    const permanent = ndsError !== null && !ndsError.retryable;
    await prisma.nationalSyncJob.update({
      where: { id: jobId },
      data: {
        status: permanent ? "REJECTED" : "FAILED",
        attempts,
        lastError: message,
        sentPayload: built.payload as object,
        ...(permanent ? { settledAt: new Date() } : { nextAttemptAt: nextAttempt(attempts) }),
      },
    });
    return {
      outcome: permanent ? "rejected" : "failed",
      rateLimited: ndsError?.kind === "RATE_LIMIT",
    };
  }
}

/** Cửa hàng đang bật liên thông (lọc theo `storeId` nếu có) cùng máy khách của từng cửa hàng. */
async function activeStoreClients(storeId?: string) {
  const configs = (await enabledStoreConfigs()).filter(
    (config) => !storeId || config.storeId === storeId,
  );
  const clients = [];
  for (const config of configs) {
    const client = await buildClient(config.storeId);
    if (client) clients.push({ storeId: config.storeId, client });
  }
  return clients;
}

/**
 * Gửi các chứng từ tới hạn. Chứng từ của cửa hàng nào gửi bằng tài khoản của
 * cửa hàng đó; cửa hàng chưa bật liên thông thì chứng từ nằm chờ.
 */
export async function drainQueue(limit = 25, storeId?: string): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, blocked: 0, failed: 0, rejected: 0 };

  for (const { storeId: store, client } of await activeStoreClients(storeId)) {
    const due = await prisma.nationalSyncJob.findMany({
      where: {
        storeId: store,
        status: { in: ["PENDING", "FAILED"] },
        nextAttemptAt: { lte: new Date() },
      },
      orderBy: [{ documentDate: "asc" }, { createdAt: "asc" }],
      take: limit,
      select: { id: true },
    });

    for (const job of due) {
      const { outcome, rateLimited } = await sendOne(client, job.id);
      if (outcome) result[outcome] += 1;
      // Bị chặn tần suất thì dừng lượt của tài khoản này, gửi tiếp chỉ càng bị chặn lâu hơn.
      if (rateLimited) break;
    }
  }

  return result;
}

// --- Theo dõi trạng thái ----------------------------------------------------

const REMOTE_TO_LOCAL: Record<string, string> = {
  accepted: "ACCEPTED",
  processing: "PROCESSING",
  completed: "COMPLETED",
  error: "FAILED",
  rejected: "REJECTED",
};

export type PollResult = { checked: number; completed: number; rejected: number };

/**
 * Hỏi lại kết quả xử lý của các chứng từ đã gửi.
 *
 * `force` bỏ qua lịch hẹn giờ: người dùng bấm "Gửi ngay" là muốn biết kết quả
 * ngay lúc đó, không phải chờ hết chu kỳ lùi giờ dành cho bộ chạy nền.
 */
export async function pollStatuses(
  limit = 25,
  options: { force?: boolean; storeId?: string } = {},
): Promise<PollResult> {
  const result: PollResult = { checked: 0, completed: 0, rejected: 0 };
  for (const { storeId, client } of await activeStoreClients(options.storeId)) {
    await pollStore(client, storeId, limit, options.force ?? false, result);
  }
  return result;
}

async function pollStore(
  client: NonNullable<Awaited<ReturnType<typeof buildClient>>>,
  storeId: string,
  limit: number,
  force: boolean,
  result: PollResult,
): Promise<void> {
  const pending = await prisma.nationalSyncJob.findMany({
    where: {
      storeId,
      status: { in: ["ACCEPTED", "PROCESSING"] },
      remoteTransactionId: { not: null },
      ...(force ? {} : { nextAttemptAt: { lte: new Date() } }),
    },
    orderBy: { submittedAt: "asc" },
    take: limit,
  });

  for (const job of pending) {
    result.checked += 1;
    try {
      const status = await client.fetchStatus(job.kind as JobKind, job.remoteTransactionId!);
      const mapped = REMOTE_TO_LOCAL[(status.status ?? "").toLowerCase()] ?? "PROCESSING";
      const settled = mapped === "COMPLETED" || mapped === "REJECTED";

      await prisma.nationalSyncJob.update({
        where: { id: job.id },
        data: {
          status: mapped,
          messages: status.messages.length > 0 ? (status.messages as object) : undefined,
          ...(status.messages.length > 0 ? { lastError: status.messages.join("; ") } : {}),
          ...(settled
            ? { settledAt: new Date() }
            : { nextAttemptAt: new Date(Date.now() + 5 * 60 * 1000) }),
        },
      });

      if (mapped === "COMPLETED") result.completed += 1;
      if (mapped === "REJECTED") result.rejected += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.nationalSyncJob.update({
        where: { id: job.id },
        data: { lastError: message, nextAttemptAt: nextAttempt(job.attempts) },
      });
    }
  }
}

// --- Thao tác tay -----------------------------------------------------------

export async function retryJob(jobId: string, userId: string, storeId: string): Promise<void> {
  const job = await prisma.nationalSyncJob.findUnique({ where: { id: jobId } });
  // Chứng từ của cửa hàng khác: báo không tìm thấy, không lộ việc nó tồn tại.
  if (!job || job.storeId !== storeId) throw AppError.notFound("Không tìm thấy việc gửi dữ liệu");
  if (job.status === "SENDING") {
    throw AppError.invalidState("Chứng từ đang được gửi, chờ xong rồi thử lại");
  }
  if (job.status === "COMPLETED") {
    throw AppError.invalidState("Chứng từ đã được CSDL Dược xử lý xong");
  }

  await prisma.nationalSyncJob.update({
    where: { id: jobId },
    data: { status: "PENDING", nextAttemptAt: new Date(), lastError: null, messages: undefined },
  });

  await prisma.auditLog.create({
    data: {
      storeId,
      actorId: userId,
      action: "NATIONAL_SYNC_RETRY",
      resourceType: "national_sync_job",
      resourceId: jobId,
      after: { referenceNumber: job.referenceNumber, previousStatus: job.status },
    },
  });
}

export type QueueSummary = {
  total: number;
  byStatus: Record<string, number>;
  oldestPendingAt: string | null;
};

export async function queueSummary(storeId?: string): Promise<QueueSummary> {
  const scope = storeId ? { storeId } : {};
  const grouped = await prisma.nationalSyncJob.groupBy({
    by: ["status"],
    where: scope,
    _count: true,
  });
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of grouped) {
    const count = typeof row._count === "number" ? row._count : 0;
    byStatus[row.status] = count;
    total += count;
  }

  const oldest = await prisma.nationalSyncJob.findFirst({
    where: { ...scope, status: { in: ["PENDING", "FAILED", "BLOCKED"] } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });

  return { total, byStatus, oldestPendingAt: oldest?.createdAt.toISOString() ?? null };
}
