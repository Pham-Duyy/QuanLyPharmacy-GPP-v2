import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { storeContext } from "../../middlewares/store-context.js";
import { NdsError } from "./nds-client.js";
import * as config from "./nds-config.service.js";
import * as master from "./nds-master.service.js";
import { buildOpeningStockTakingPayload, isoDate, vnDateTime } from "./nds-payload.js";
import * as queue from "./nds-queue.service.js";

export const nationalSyncRouter = Router();

nationalSyncRouter.use("/national-sync", authenticate, storeContext);

/** Dịch lỗi của CSDL Dược thành lỗi có mã của phần mềm, để giao diện hiện đúng. */
function mapRemoteError(error: unknown): never {
  if (error instanceof NdsError) {
    const status = error.kind === "AUTH" ? 422 : error.kind === "RATE_LIMIT" ? 429 : 502;
    throw new AppError(status, `NDS_${error.kind}`, error.message);
  }
  throw error;
}

// --- Cấu hình ---------------------------------------------------------------

nationalSyncRouter.get(
  "/national-sync/config",
  requirePermission("national_sync.read"),
  async (_req, res) => {
    sendData(res, await config.getConfigView());
  },
);

const configSchema = z.object({
  enabled: z.boolean().optional(),
  environment: z.enum(["SANDBOX", "PRODUCTION"]).optional(),
  username: z.string().trim().max(200).nullish(),
  password: z.string().max(200).nullish(),
  practiceLicenseCode: z.string().trim().max(50).nullish(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate phải theo dạng YYYY-MM-DD")
    .nullish(),
});

nationalSyncRouter.patch(
  "/national-sync/config",
  requirePermission("national_sync.manage"),
  async (req, res) => {
    const input = parseOrThrow(configSchema, req.body);
    sendData(res, await config.updateConfig(input, req.auth!.userId));
  },
);

/** Thử đăng nhập với tài khoản đã lưu; không gửi dữ liệu gì lên. */
nationalSyncRouter.post(
  "/national-sync/test-connection",
  requirePermission("national_sync.manage"),
  async (_req, res) => {
    const client = await config.requireClient();
    try {
      await client.login();
      sendData(res, { ok: true, baseUrl: client.baseUrl });
    } catch (error) {
      mapRemoteError(error);
    }
  },
);

// --- Danh mục quốc gia ------------------------------------------------------

nationalSyncRouter.post(
  "/national-sync/master-sync",
  requirePermission("national_sync.manage"),
  async (req, res) => {
    const input = parseOrThrow(z.object({ full: z.boolean().default(false) }), req.body ?? {});
    const client = await config.requireClient();
    try {
      const result = await master.syncMasterData(client, { full: input.full });
      sendData(res, result);
    } catch (error) {
      mapRemoteError(error);
    }
  },
);

nationalSyncRouter.get(
  "/national-sync/drugs",
  requirePermission("national_sync.read"),
  async (req, res) => {
    const query = req.query as Record<string, string | undefined>;
    const term = query["search"]?.trim() ?? "";
    const limit = Math.min(50, Math.max(1, Number(query["limit"] ?? 20)));

    const where = term
      ? {
          OR: [
            { name: { contains: term, mode: "insensitive" as const } },
            { registrationNumber: { contains: term, mode: "insensitive" as const } },
            { id: term },
          ],
        }
      : {};

    const [items, total] = await Promise.all([
      prisma.nationalDrug.findMany({ where, take: limit, orderBy: { name: "asc" } }),
      prisma.nationalDrug.count({ where }),
    ]);

    sendData(res, {
      items: items.map((drug) => ({
        id: drug.id,
        name: drug.name,
        registrationNumber: drug.registrationNumber,
        activeIngredient: drug.activeIngredient,
        strength: drug.strength,
        prescriptionStatus: drug.prescriptionStatus,
        specialControlType: drug.specialControlType,
        manufacturerName: drug.manufacturerName,
        manufacturerCountry: drug.manufacturerCountry,
        packagings: drug.packagings,
      })),
      total,
    });
  },
);

// --- Ghép mã ----------------------------------------------------------------

nationalSyncRouter.get(
  "/national-sync/mapping",
  requirePermission("national_sync.read"),
  async (req, res) => {
    const query = req.query as Record<string, string | undefined>;
    const state = query["state"] ?? "all"; // all | linked | unlinked | needs_review
    const term = query["search"]?.trim() ?? "";

    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: "insensitive" as const } },
                { code: { contains: term, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      include: {
        nationalDrugLink: true,
        units: { where: { conversionToBase: 1 }, select: { name: true } },
      },
      orderBy: { code: "asc" },
    });

    const drugIds = products.flatMap((p) => (p.nationalDrugLink ? [p.nationalDrugLink.drugId] : []));
    const drugs = await prisma.nationalDrug.findMany({ where: { id: { in: drugIds } } });
    const drugById = new Map(drugs.map((drug) => [drug.id, drug]));

    const rows = products.map((product) => {
      const link = product.nationalDrugLink;
      const drug = link ? drugById.get(link.drugId) : undefined;
      return {
        productId: product.id,
        code: product.code,
        name: product.name,
        registrationNumber: product.registrationNumber,
        baseUnitName: product.units[0]?.name ?? null,
        link: link
          ? {
              drugId: link.drugId,
              unitId: link.unitId,
              gtin: link.gtin,
              matchedBy: link.matchedBy,
              confirmedAt: link.confirmedAt?.toISOString() ?? null,
              usable: master.isLinkUsable(link),
              drugName: drug?.name ?? null,
              drugRegistrationNumber: drug?.registrationNumber ?? null,
            }
          : null,
      };
    });

    const filtered = rows.filter((row) => {
      if (state === "linked") return row.link !== null;
      if (state === "unlinked") return row.link === null;
      if (state === "needs_review") return row.link !== null && !row.link.usable;
      return true;
    });

    sendData(res, {
      items: filtered,
      summary: {
        total: rows.length,
        linked: rows.filter((row) => row.link !== null).length,
        usable: rows.filter((row) => row.link?.usable).length,
        needsReview: rows.filter((row) => row.link !== null && !row.link.usable).length,
        unlinked: rows.filter((row) => row.link === null).length,
      },
    });
  },
);

nationalSyncRouter.post(
  "/national-sync/auto-match",
  requirePermission("national_sync.manage"),
  async (_req, res) => {
    sendData(res, await master.autoMatchProducts());
  },
);

const linkSchema = z.object({
  drugId: z.string().trim().min(1).max(20),
  unitId: z.string().trim().min(1).max(20),
  gtin: z.string().trim().max(50).nullish(),
});

nationalSyncRouter.put(
  "/national-sync/mapping/:productId",
  requirePermission("national_sync.manage"),
  async (req, res) => {
    const input = parseOrThrow(linkSchema, req.body);
    await master.setLink(String(req.params.productId), input, req.auth!.userId);
    sendData(res, { ok: true });
  },
);

nationalSyncRouter.post(
  "/national-sync/mapping/:productId/confirm",
  requirePermission("national_sync.manage"),
  async (req, res) => {
    await master.confirmLink(String(req.params.productId), req.auth!.userId);
    sendData(res, { ok: true });
  },
);

nationalSyncRouter.delete(
  "/national-sync/mapping/:productId",
  requirePermission("national_sync.manage"),
  async (req, res) => {
    await master.removeLink(String(req.params.productId), req.auth!.userId);
    sendData(res, { ok: true });
  },
);

// --- Hàng đợi ---------------------------------------------------------------

nationalSyncRouter.get(
  "/national-sync/jobs",
  requirePermission("national_sync.read"),
  async (req, res) => {
    const query = req.query as Record<string, string | undefined>;
    const limit = Math.min(200, Math.max(1, Number(query["limit"] ?? 50)));
    const status = query["status"];

    const jobs = await prisma.nationalSyncJob.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    sendData(res, {
      items: jobs.map((job) => ({
        id: job.id,
        kind: job.kind,
        sourceType: job.sourceType,
        sourceId: job.sourceId,
        referenceNumber: job.referenceNumber,
        reason: job.reason,
        documentDate: isoDate(job.documentDate),
        status: job.status,
        attempts: job.attempts,
        remoteTransactionId: job.remoteTransactionId,
        lastError: job.lastError,
        messages: job.messages,
        submittedAt: job.submittedAt?.toISOString() ?? null,
        settledAt: job.settledAt?.toISOString() ?? null,
        nextAttemptAt: job.nextAttemptAt.toISOString(),
        createdAt: job.createdAt.toISOString(),
      })),
      summary: await queue.queueSummary(),
    });
  },
);

nationalSyncRouter.post(
  "/national-sync/scan",
  requirePermission("national_sync.manage"),
  async (_req, res) => {
    sendData(res, await queue.scanDocuments());
  },
);

/** Gửi ngay một lượt, không chờ bộ hẹn giờ. */
nationalSyncRouter.post(
  "/national-sync/drain",
  requirePermission("national_sync.manage"),
  async (_req, res) => {
    const sent = await queue.drainQueue();
    const polled = await queue.pollStatuses();
    sendData(res, { sent, polled });
  },
);

nationalSyncRouter.post(
  "/national-sync/jobs/:jobId/retry",
  requirePermission("national_sync.manage"),
  async (req, res) => {
    await queue.retryJob(String(req.params.jobId), req.auth!.userId);
    sendData(res, { ok: true });
  },
);

// --- Phiếu kiểm hàng đầu kỳ -------------------------------------------------

/**
 * Gửi phiếu kiểm hàng đầu kỳ: ảnh chụp tồn hiện tại. Bắt buộc đúng một lần
 * khi bắt đầu liên thông, vì hệ thống quốc gia chỉ ghi nhận chứng từ phát
 * sinh SAU ngày của phiếu này. Ngày phiếu được lưu lại làm mốc `start_date`.
 */
nationalSyncRouter.post(
  "/national-sync/opening-stock-taking",
  requirePermission("national_sync.manage"),
  async (req, res) => {
    const auth = req.auth!;
    if (!auth.storeId) {
      throw new AppError(400, "BAD_REQUEST", "Phải chọn cửa hàng trước khi gửi tồn đầu kỳ");
    }

    const existing = await prisma.nationalSyncJob.findFirst({
      where: { kind: "STOCK_TAKING", sourceType: "opening_balance", storeId: auth.storeId },
    });
    if (existing) {
      throw AppError.invalidState(
        `Tồn đầu kỳ đã gửi (chứng từ ${existing.referenceNumber}, trạng thái ${existing.status}). Hệ thống quốc gia không cho gửi lại phiếu đầu kỳ thứ hai.`,
      );
    }

    const store = await prisma.store.findUniqueOrThrow({ where: { id: auth.storeId } });
    const now = new Date();
    const referenceNumber = `TDK-${store.code}-${isoDate(now).replace(/-/g, "")}`;

    const built = await buildOpeningStockTakingPayload(auth.storeId, referenceNumber, now);
    if (!built.ok) throw AppError.invalidState(built.message, built.missing);

    const client = await config.requireClient();
    try {
      const ack = await client.submit("STOCK_TAKING", built.payload);

      // Chốt mốc liên thông và ghi việc vào hàng đợi trong cùng một giao dịch:
      // gửi xong mà mất mốc thì lượt quét sau sẽ bỏ sót hoặc gửi trùng.
      await prisma.$transaction(async (tx) => {
        await tx.nationalSyncJob.create({
          data: {
            storeId: auth.storeId!,
            kind: "STOCK_TAKING",
            sourceType: "opening_balance",
            sourceId: store.id,
            referenceNumber,
            reason: "opening-balance",
            documentDate: new Date(`${isoDate(now)}T00:00:00.000Z`),
            status: "ACCEPTED",
            attempts: 1,
            remoteTransactionId: ack.transactionId,
            sentPayload: built.payload as object,
            submittedAt: now,
            nextAttemptAt: new Date(Date.now() + 60 * 1000),
          },
        });
        await tx.nationalSyncConfig.update({
          where: { id: true },
          data: { startDate: new Date(`${isoDate(now)}T00:00:00.000Z`), updatedBy: auth.userId },
        });
      });

      await prisma.auditLog.create({
        data: {
          actorId: auth.userId,
          action: "NATIONAL_SYNC_OPENING_STOCK_TAKING",
          resourceType: "store",
          resourceId: store.id,
          after: {
            referenceNumber,
            transactionId: ack.transactionId,
            items: built.payload.items.length,
            transactionDate: vnDateTime(now),
          },
        },
      });

      sendData(
        res,
        { referenceNumber, transactionId: ack.transactionId, items: built.payload.items.length },
        201,
      );
    } catch (error) {
      mapRemoteError(error);
    }
  },
);
