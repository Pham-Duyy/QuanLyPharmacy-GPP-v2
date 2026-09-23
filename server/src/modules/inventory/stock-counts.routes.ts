import { Router } from "express";
import { z } from "zod";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { addLineSchema, closeCountSchema, listCountsSchema, openCountSchema, saveCountsSchema } from "./stock-counts.schema.js";
import * as service from "./stock-counts.service.js";

export const stockCountsRouter = Router();
stockCountsRouter.use("/stock-counts", authenticate, storeContext, requireStore);

/** GET /api/v1/stock-counts: các đợt kiểm kê của cửa hàng đang chọn. */
stockCountsRouter.get("/stock-counts", requirePermission("stock.read"), async (req, res) => {
  const query = parseOrThrow(listCountsSchema, req.query);
  const [items, open] = await Promise.all([service.list(req.auth!.storeId!, query), service.getOpen(req.auth!.storeId!)]);
  sendData(res, { items, open });
});

/** POST /api/v1/stock-counts: mở đợt kiểm kê, chụp danh sách lô cần đếm. */
stockCountsRouter.post("/stock-counts", requirePermission("stock.adjust.create"), async (req, res) => {
  const input = parseOrThrow(openCountSchema, req.body);
  const id = await service.openCount(req.auth!.storeId!, req.auth!.userId, input);
  sendData(res, await service.getDetail(req.auth!.storeId!, id, req.auth!), 201);
});

stockCountsRouter.get("/stock-counts/:id", requirePermission("stock.read"), async (req, res) => {
  sendData(res, await service.getDetail(req.auth!.storeId!, String(req.params.id), req.auth!));
});

/** PATCH /api/v1/stock-counts/{id}/counts: ghi số đếm cho nhiều dòng một lượt. */
stockCountsRouter.patch("/stock-counts/:id/counts", requirePermission("stock.adjust.create"), async (req, res) => {
  const input = parseOrThrow(saveCountsSchema, req.body);
  const result = await service.saveCounts(req.auth!.storeId!, String(req.params.id), req.auth!.userId, input);
  sendData(res, { ...result, ...(await service.getDetail(req.auth!.storeId!, String(req.params.id), req.auth!)) });
});

/** POST /api/v1/stock-counts/{id}/lines: thêm lô tìm thấy trên kệ nhưng chưa có trong đợt. */
stockCountsRouter.post("/stock-counts/:id/lines", requirePermission("stock.adjust.create"), async (req, res) => {
  const input = parseOrThrow(addLineSchema, req.body);
  const lineId = await service.addLine(req.auth!.storeId!, String(req.params.id), input.batchId);
  sendData(res, { lineId, ...(await service.getDetail(req.auth!.storeId!, String(req.params.id), req.auth!)) }, 201);
});

/** POST /api/v1/stock-counts/{id}/close: chốt đợt, sinh phiếu điều chỉnh chờ duyệt. */
stockCountsRouter.post("/stock-counts/:id/close", requirePermission("stock.adjust.create"), async (req, res) => {
  const input = parseOrThrow(closeCountSchema, req.body ?? {});
  const result = await service.closeCount(req.auth!.storeId!, String(req.params.id), req.auth!, input.note ?? null);
  sendData(res, { ...result, ...(await service.getDetail(req.auth!.storeId!, String(req.params.id), req.auth!)) });
});

/** POST /api/v1/stock-counts/{id}/cancel: bỏ đợt đang đếm, không đụng tới tồn. */
stockCountsRouter.post("/stock-counts/:id/cancel", requirePermission("stock.adjust.create"), async (req, res) => {
  const input = parseOrThrow(z.object({ reason: z.string().trim().max(500).nullish() }), req.body ?? {});
  await service.cancelCount(req.auth!.storeId!, String(req.params.id), req.auth!, input.reason ?? null);
  sendData(res, await service.getDetail(req.auth!.storeId!, String(req.params.id), req.auth!));
});
