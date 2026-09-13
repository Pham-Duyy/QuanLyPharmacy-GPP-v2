import { Router } from "express";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { idempotency } from "../../middlewares/idempotency.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { storeContext } from "../../middlewares/store-context.js";
import { createRecallSchema } from "./recalls.schema.js";
import * as service from "./recalls.service.js";

export const recallsRouter = Router();

// Thu hồi là tài nguyên toàn chuỗi, không cần X-Store-Id (contract §2.8).
recallsRouter.use(authenticate, storeContext, requirePermission("recall.manage"));

recallsRouter.post("/recalls", idempotency, async (req, res) => {
  const input = parseOrThrow(createRecallSchema, req.body);
  const id = await withMappedErrors(() => service.createRecall(req.auth!, input), {
    conflictMessage: "Số công văn thu hồi này đã được dùng",
  });
  sendData(res, await service.getDetail(id), 201);
});

recallsRouter.get("/recalls", async (req, res) => {
  const query = req.query as Record<string, string | undefined>;
  const items = await service.list({ status: query["status"] });
  sendData(res, items);
});

recallsRouter.get("/recalls/:id", async (req, res) => {
  sendData(res, await service.getDetail(String(req.params.id)));
});

recallsRouter.get("/recalls/:id/affected-sales", async (req, res) => {
  sendData(res, await service.getAffectedSales(String(req.params.id), req.auth!));
});

recallsRouter.post("/recalls/:id/close", idempotency, async (req, res) => {
  const id = String(req.params.id);
  await withMappedErrors(() => service.closeRecall(id, req.auth!));
  sendData(res, await service.getDetail(id));
});
