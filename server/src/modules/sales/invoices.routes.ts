import { Router } from "express";
import { prisma } from "../../db/prisma.js";
import { pageResult, parsePageQuery } from "../../lib/pagination.js";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { idempotency } from "../../middlewares/idempotency.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { resolveCartLines } from "./cart.js";
import * as service from "./invoices.service.js";
import { runSafetyCheck } from "./safety-check.service.js";
import { createInvoiceSchema, safetyCheckSchema, voidInvoiceSchema } from "./sales.schema.js";

export const invoicesRouter = Router();

// Bán hàng luôn diễn ra tại một cửa hàng cụ thể (contract §2.8).
invoicesRouter.use(authenticate, storeContext, requireStore);

invoicesRouter.post(
  "/sales/safety-check",
  requirePermission("invoice.create"),
  async (req, res) => {
    const input = parseOrThrow(safetyCheckSchema, req.body);
    const storeId = req.auth!.storeId!;
    const lines = await resolveCartLines(prisma, input.lines);

    sendData(
      res,
      await runSafetyCheck(prisma, {
        storeId,
        lines,
        customerId: input.customerId,
        prescriptionId: input.prescriptionId,
      }),
    );
  },
);

invoicesRouter.get("/invoices", requirePermission("invoice.read"), async (req, res) => {
  const page = parsePageQuery(req.query, {
    sortable: ["soldAt", "code", "totalAmount"],
    defaultSort: "soldAt",
  });
  const query = req.query as Record<string, string | undefined>;

  const where = {
    storeId: req.auth!.storeId!,
    ...(query["status"] ? { status: query["status"] } : {}),
    ...(query["customerId"] ? { customerId: query["customerId"] } : {}),
    ...(query["sellerId"] ? { sellerId: query["sellerId"] } : {}),
    ...(query["from"] || query["to"]
      ? {
          soldAt: {
            ...(query["from"] ? { gte: new Date(query["from"]) } : {}),
            ...(query["to"] ? { lt: new Date(query["to"]) } : {}),
          },
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { [page.sortBy]: page.order },
      skip: page.skip,
      take: page.limit,
      include: {
        customer: { select: { fullName: true, phone: true } },
        seller: { select: { fullName: true } },
        _count: { select: { lines: true } },
      },
    }),
    prisma.invoice.count({ where }),
  ]);

  sendData(
    res,
    pageResult(
      items.map((invoice) => ({
        id: invoice.id,
        code: invoice.code,
        status: invoice.status,
        returnStatus: invoice.returnStatus,
        customerName: invoice.customer?.fullName ?? null,
        sellerName: invoice.seller.fullName,
        soldAt: invoice.soldAt,
        totalAmount: invoice.totalAmount,
        lineCount: invoice._count.lines,
      })),
      total,
      page,
    ),
  );
});

invoicesRouter.get("/invoices/:id", requirePermission("invoice.read"), async (req, res) => {
  sendData(res, await service.getDetail(req.auth!.storeId!, String(req.params.id)));
});

invoicesRouter.post(
  "/invoices",
  requirePermission("invoice.create"),
  idempotency,
  async (req, res) => {
    const input = parseOrThrow(createInvoiceSchema, req.body);
    const storeId = req.auth!.storeId!;
    const id = await withMappedErrors(() => service.createInvoice(storeId, req.auth!, input));
    sendData(res, await service.getDetail(storeId, id), 201);
  },
);

invoicesRouter.post(
  "/invoices/:id/void",
  requirePermission("invoice.void"),
  idempotency,
  async (req, res) => {
    const input = parseOrThrow(voidInvoiceSchema, req.body);
    const storeId = req.auth!.storeId!;
    const id = String(req.params.id);
    await withMappedErrors(() => service.voidInvoice(storeId, id, req.auth!, input.reason));
    sendData(res, await service.getDetail(storeId, id));
  },
);
