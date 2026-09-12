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
import { createReturnSchema } from "./returns.schema.js";
import * as service from "./returns.service.js";

export const returnsRouter = Router();

// Trả hàng chỉ nhận tại cửa hàng đã bán, vì lô nằm trong kho cửa hàng đó (§2.8).
returnsRouter.use(authenticate, storeContext, requireStore);

returnsRouter.post(
  "/invoices/:id/returns",
  requirePermission("return.create"),
  idempotency,
  async (req, res) => {
    const input = parseOrThrow(createReturnSchema, req.body);
    const storeId = req.auth!.storeId!;
    const id = await withMappedErrors(() =>
      service.createReturn(storeId, String(req.params.id), req.auth!, input),
    );
    sendData(res, await service.getDetail(storeId, id), 201);
  },
);

returnsRouter.get("/returns", requirePermission("invoice.read"), async (req, res) => {
  const page = parsePageQuery(req.query, {
    sortable: ["createdAt", "code", "refundAmount"],
    defaultSort: "createdAt",
  });
  const query = req.query as Record<string, string | undefined>;

  const where = {
    storeId: req.auth!.storeId!,
    ...(query["invoiceId"] ? { invoiceId: query["invoiceId"] } : {}),
    ...(query["from"] || query["to"]
      ? {
          createdAt: {
            ...(query["from"] ? { gte: new Date(query["from"]) } : {}),
            ...(query["to"] ? { lt: new Date(query["to"]) } : {}),
          },
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.return.findMany({
      where,
      orderBy: { [page.sortBy]: page.order },
      skip: page.skip,
      take: page.limit,
      include: {
        invoice: { select: { code: true } },
        createdByUser: { select: { fullName: true } },
        _count: { select: { lines: true } },
      },
    }),
    prisma.return.count({ where }),
  ]);

  sendData(
    res,
    pageResult(
      items.map((item) => ({
        id: item.id,
        code: item.code,
        invoiceCode: item.invoice.code,
        disposition: item.disposition,
        refundAmount: item.refundAmount,
        createdAt: item.createdAt,
        createdByName: item.createdByUser.fullName,
        lineCount: item._count.lines,
      })),
      total,
      page,
    ),
  );
});

returnsRouter.get("/returns/:id", requirePermission("invoice.read"), async (req, res) => {
  sendData(res, await service.getDetail(req.auth!.storeId!, String(req.params.id)));
});
