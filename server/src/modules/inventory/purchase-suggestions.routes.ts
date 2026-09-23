import { Router } from "express";
import { z } from "zod";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import * as service from "./purchase-suggestions.service.js";

export const purchaseSuggestionsRouter = Router();
purchaseSuggestionsRouter.use("/purchase-suggestions", authenticate, storeContext, requireStore);

const querySchema = z.object({
  windowDays: z.coerce.number().int().min(7).max(365).default(30),
  coverDays: z.coerce.number().int().min(1).max(180).default(30),
  leadTimeDays: z.coerce.number().int().min(0).max(90).default(7),
  onlyNeeded: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  categoryId: z.uuid("categoryId không hợp lệ").optional(),
  search: z.string().trim().max(100).optional(),
});

/**
 * GET /api/v1/purchase-suggestions: hôm nay cần gọi hàng gì, bao nhiêu.
 * Chỉ đọc và tính toán, không tạo chứng từ nào.
 */
purchaseSuggestionsRouter.get("/purchase-suggestions", requirePermission("stock.read"), async (req, res) => {
  const query = parseOrThrow(querySchema, req.query);
  const items = await service.buildSuggestions(req.auth!.storeId!, query);
  sendData(res, { items, summary: service.summarize(items), settings: { windowDays: query.windowDays, coverDays: query.coverDays, leadTimeDays: query.leadTimeDays } });
});
