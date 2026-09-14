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
import { cancelSchema, createReceiptSchema, patchReceiptSchema } from "./goods-receipts.schema.js";
import * as service from "./goods-receipts.service.js";

export const goodsReceiptsRouter = Router();

// Phiếu nhập thuộc phạm vi cửa hàng, nên mọi endpoint đều cần X-Store-Id.
// Giới hạn theo tiền tố "/goods-receipts": nhiều router được app.ts gắn
// chung vào "/api/v1", nếu dùng .use() không kèm đường dẫn thì middleware
// này sẽ chạy cho MỌI request đi qua (kể cả của router khác như /recalls)
// và làm chúng bị đòi X-Store-Id một cách sai chỗ.
goodsReceiptsRouter.use("/goods-receipts", authenticate, storeContext, requireStore);

goodsReceiptsRouter.get(
  "/goods-receipts",
  requirePermission("goods_receipt.read"),
  async (req, res) => {
    const page = parsePageQuery(req.query, {
      sortable: ["receivedAt", "createdAt", "code"],
      defaultSort: "receivedAt",
    });
    const query = req.query as Record<string, string | undefined>;

    const where = {
      storeId: req.auth!.storeId!,
      ...(query["status"] ? { status: query["status"] } : {}),
      ...(query["supplierId"] ? { supplierId: query["supplierId"] } : {}),
      ...(query["from"] || query["to"]
        ? {
            receivedAt: {
              ...(query["from"] ? { gte: new Date(query["from"]) } : {}),
              ...(query["to"] ? { lt: new Date(query["to"]) } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.goodsReceipt.findMany({
        where,
        orderBy: { [page.sortBy]: page.order },
        skip: page.skip,
        take: page.limit,
        include: { supplier: { select: { name: true } }, _count: { select: { lines: true } } },
      }),
      prisma.goodsReceipt.count({ where }),
    ]);

    sendData(
      res,
      pageResult(
        items.map((receipt) => ({
          id: receipt.id,
          code: receipt.code,
          status: receipt.status,
          supplierName: receipt.supplier?.name ?? null,
          receivedAt: receipt.receivedAt,
          totalCost: receipt.totalCost,
          lineCount: receipt._count.lines,
        })),
        total,
        page,
      ),
    );
  },
);

goodsReceiptsRouter.get(
  "/goods-receipts/:id",
  requirePermission("goods_receipt.read"),
  async (req, res) => {
    sendData(res, await service.getDetail(req.auth!.storeId!, String(req.params.id)));
  },
);

goodsReceiptsRouter.post(
  "/goods-receipts",
  requirePermission("goods_receipt.create"),
  idempotency,
  async (req, res) => {
    const input = parseOrThrow(createReceiptSchema, req.body);
    const id = await withMappedErrors(() =>
      service.createDraft(req.auth!.storeId!, req.auth!.userId, input),
    );
    sendData(res, await service.getDetail(req.auth!.storeId!, id), 201);
  },
);

// Không cần Idempotency-Key: PATCH đã tự chống ghi trùng bằng version,
// gửi lại y hệt thì lần hai lệch version nên bị 409 chứ không sửa đè.
goodsReceiptsRouter.patch(
  "/goods-receipts/:id",
  requirePermission("goods_receipt.create"),
  async (req, res) => {
    const input = parseOrThrow(patchReceiptSchema, req.body);
    const storeId = req.auth!.storeId!;
    const id = String(req.params.id);
    await withMappedErrors(() => service.updateDraft(storeId, id, input));
    sendData(res, await service.getDetail(storeId, id));
  },
);

goodsReceiptsRouter.post(
  "/goods-receipts/:id/confirm",
  requirePermission("goods_receipt.confirm"),
  idempotency,
  async (req, res) => {
    const storeId = req.auth!.storeId!;
    const id = String(req.params.id);
    await withMappedErrors(() => service.confirm(storeId, id, req.auth!.userId));
    sendData(res, await service.getDetail(storeId, id));
  },
);

goodsReceiptsRouter.post(
  "/goods-receipts/:id/cancel",
  requirePermission("goods_receipt.confirm"),
  idempotency,
  async (req, res) => {
    const storeId = req.auth!.storeId!;
    const id = String(req.params.id);
    const input = parseOrThrow(cancelSchema, req.body);
    await service.cancel(storeId, id, req.auth!.userId, input.reason);
    sendData(res, await service.getDetail(storeId, id));
  },
);
