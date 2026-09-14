import { Router } from "express";
import { z } from "zod";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { createStorageLogSchema } from "./storage-logs.schema.js";
import * as service from "./storage-logs.service.js";

export const storageLogsRouter = Router();

// Sổ nhiệt độ – độ ẩm thuộc phạm vi cửa hàng (contract §2.8, §17).
storageLogsRouter.use("/storage-logs", authenticate, storeContext, requireStore);

const listQuerySchema = z.object({
  location: z.string().trim().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  outOfRange: z.enum(["true", "false"]).optional(),
});

storageLogsRouter.get("/storage-logs", requirePermission("storage_log.read"), async (req, res) => {
  const query = parseOrThrow(listQuerySchema, req.query);
  sendData(
    res,
    await service.list(req.auth!.storeId!, {
      location: query.location,
      from: query.from,
      to: query.to,
      outOfRange: query.outOfRange !== undefined ? query.outOfRange === "true" : undefined,
    }),
  );
});

const summaryQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, "month phải theo định dạng YYYY-MM"),
});

storageLogsRouter.get(
  "/storage-logs/summary",
  requirePermission("storage_log.read"),
  async (req, res) => {
    const query = parseOrThrow(summaryQuerySchema, req.query);
    sendData(res, await service.getSummary(req.auth!.storeId!, query.month));
  },
);

// Ghi một lần đo, không phải action đổi trạng thái nên không cần Idempotency-Key (contract §2.3).
storageLogsRouter.post(
  "/storage-logs",
  requirePermission("storage_log.write"),
  async (req, res) => {
    const input = parseOrThrow(createStorageLogSchema, req.body);
    const result = await withMappedErrors(() =>
      service.createLog(req.auth!.storeId!, req.auth!.userId, input),
    );
    sendData(res, result, 201);
  },
);
