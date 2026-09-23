import { Router } from "express";
import { z } from "zod";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { EXPIRY_ACTIONS } from "./expiry-alerts.service.js";
import * as service from "./expiry-alerts.service.js";

export const expiryAlertsRouter = Router();
expiryAlertsRouter.use("/expiry-alerts", authenticate, storeContext, requireStore);

const listSchema = z.object({
  horizonDays: z.coerce.number().int().min(1).max(365).default(90),
  bucket: z.enum(["EXPIRED", "D30", "D60", "D90"]).optional(),
  onlyWithoutPlan: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

const planSchema = z.object({
  batchId: z.uuid("batchId không hợp lệ"),
  action: z.enum(EXPIRY_ACTIONS),
  dueDate: z.coerce.date().nullish(),
  note: z.string().trim().max(500).nullish(),
});

const closeSchema = z.object({
  status: z.enum(["DONE", "CANCELLED"]).default("DONE"),
  outcome: z.string().trim().max(500).nullish(),
});

/** GET /api/v1/expiry-alerts: lô cận hạn và đã hết hạn, kèm kế hoạch xử lý. */
expiryAlertsRouter.get("/expiry-alerts", requirePermission("stock.read"), async (req, res) => {
  const query = parseOrThrow(listSchema, req.query);
  sendData(res, await service.listExpiring(req.auth!.storeId!, req.auth!, query));
});

/** POST /api/v1/expiry-alerts/plans: lập hoặc sửa kế hoạch xử lý cho một lô. */
expiryAlertsRouter.post("/expiry-alerts/plans", requirePermission("stock.adjust.create"), async (req, res) => {
  const input = parseOrThrow(planSchema, req.body);
  const id = await service.savePlan(req.auth!.storeId!, req.auth!, {
    batchId: input.batchId,
    action: input.action,
    dueDate: input.dueDate ?? null,
    note: input.note ?? null,
  });
  sendData(res, { id }, 201);
});

/** POST /api/v1/expiry-alerts/plans/{id}/close: đánh dấu đã xong hoặc bỏ kế hoạch. */
expiryAlertsRouter.post("/expiry-alerts/plans/:id/close", requirePermission("stock.adjust.create"), async (req, res) => {
  const input = parseOrThrow(closeSchema, req.body ?? {});
  await service.closePlan(req.auth!.storeId!, String(req.params.id), req.auth!, input.status, input.outcome ?? null);
  sendData(res, { ok: true });
});

/** GET /api/v1/expiry-alerts/batches/{batchId}/plans: lịch sử xử lý của một lô. */
expiryAlertsRouter.get("/expiry-alerts/batches/:batchId/plans", requirePermission("stock.read"), async (req, res) => {
  sendData(res, await service.planHistory(req.auth!.storeId!, String(req.params.batchId)));
});
