import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { storeContext } from "../../middlewares/store-context.js";
import * as config from "./einvoice-config.service.js";
import * as queue from "./einvoice-queue.service.js";
import { EInvoiceError } from "./misa-client.js";

/** Hóa đơn điện tử máy tính tiền (contract §26). Mọi thao tác theo cửa hàng đang chọn. */
export const einvoiceRouter = Router();

einvoiceRouter.use("/einvoices", authenticate, storeContext);

function storeOf(req: Request): string {
  const storeId = req.auth?.storeId;
  if (!storeId) {
    throw new AppError(
      400,
      "STORE_REQUIRED",
      "Phải chọn cửa hàng: mỗi cơ sở có cấu hình hóa đơn điện tử riêng",
    );
  }
  return storeId;
}

function mapRemoteError(error: unknown): never {
  if (error instanceof EInvoiceError) {
    throw new AppError(error.kind === "AUTH" ? 422 : 502, `EINVOICE_${error.kind}`, error.message);
  }
  throw error;
}

einvoiceRouter.get("/einvoices/config", requirePermission("invoice.read"), async (req, res) => {
  sendData(res, await config.getConfigView(storeOf(req)));
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  environment: z.enum(["SANDBOX", "PRODUCTION"]).optional(),
  appId: z.string().trim().max(200).nullish(),
  taxCode: z
    .string()
    .trim()
    .regex(/^\d{10}(-\d{3})?$/, "Mã số thuế gồm 10 số, chi nhánh thêm -XXX")
    .nullish(),
  username: z.string().trim().max(200).nullish(),
  password: z.string().max(200).nullish(),
  invSeries: z
    .string()
    .trim()
    .regex(
      /^[1-9][CK]\d{2}M[A-Z]{2}$/i,
      "Ký hiệu hóa đơn máy tính tiền dạng 1C26MAB (ký tự thứ 4 là M)",
    )
    .nullish(),
});

einvoiceRouter.patch(
  "/einvoices/config",
  requirePermission("einvoice.manage"),
  async (req, res) => {
    const input = parseOrThrow(configSchema, req.body);
    sendData(res, await config.updateConfig(storeOf(req), input, req.auth!.userId));
  },
);

/** Thử lấy token với thông tin đã lưu; không phát hành gì. */
einvoiceRouter.post(
  "/einvoices/test-connection",
  requirePermission("einvoice.manage"),
  async (req, res) => {
    const client = await config.requireClient(storeOf(req));
    try {
      await client.login();
      sendData(res, { ok: true, baseUrl: client.root });
    } catch (error) {
      mapRemoteError(error);
    }
  },
);

einvoiceRouter.get("/einvoices", requirePermission("invoice.read"), async (req, res) => {
  const storeId = storeOf(req);
  const query = req.query as Record<string, string | undefined>;
  const limit = Math.min(200, Math.max(1, Number(query["limit"] ?? 50)));
  const status = query["status"];
  const needsReview = query["needsReview"] === "true";

  const items = await prisma.eInvoice.findMany({
    where: {
      storeId,
      ...(status ? { status } : {}),
      ...(needsReview ? { reviewReason: { not: null } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { invoice: { select: { code: true, soldAt: true, totalAmount: true, status: true } } },
  });

  sendData(res, {
    items: items.map((item) => ({
      id: item.id,
      invoiceId: item.invoiceId,
      invoiceCode: item.invoice.code,
      invoiceStatus: item.invoice.status,
      soldAt: item.invoice.soldAt.toISOString(),
      totalAmount: item.invoice.totalAmount,
      status: item.status,
      attempts: item.attempts,
      invSeries: item.invSeries,
      invNo: item.invNo,
      transactionId: item.transactionId,
      taxAuthorityCode: item.taxAuthorityCode,
      lastError: item.lastError,
      reviewReason: item.reviewReason,
      publishedAt: item.publishedAt?.toISOString() ?? null,
      settledAt: item.settledAt?.toISOString() ?? null,
    })),
    summary: await queue.summary(storeId),
  });
});

/** Chạy ngay một lượt cho cửa hàng đang chọn: quét → phát hành → hỏi mã CQT. */
einvoiceRouter.post("/einvoices/run", requirePermission("einvoice.manage"), async (req, res) => {
  const storeId = storeOf(req);
  const scanned = await queue.scanInvoices(storeId);
  const drained = await queue.drainQueue(25, storeId);
  const polled = await queue.pollStatuses(50, { force: true, storeId });
  sendData(res, { scanned, drained, polled });
});

einvoiceRouter.post(
  "/einvoices/:id/retry",
  requirePermission("einvoice.manage"),
  async (req, res) => {
    await queue.retryJob(String(req.params.id), req.auth!.userId, storeOf(req));
    sendData(res, { ok: true });
  },
);
