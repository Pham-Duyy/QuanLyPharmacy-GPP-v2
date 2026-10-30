import { Router } from "express";
import { z } from "zod";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { forecastByCode } from "./purchase-suggestions.forecast.js";
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
purchaseSuggestionsRouter.get(
  "/purchase-suggestions",
  requirePermission("stock.read"),
  async (req, res) => {
    const query = parseOrThrow(querySchema, req.query);
    // Cột "Theo dự báo" (Phase 5, quyết định D18): có thì thêm, analytics-service tắt thì thôi.
    const forecast = await forecastByCode(req.auth!.storeId!);
    const all = await service.buildSuggestions(req.auth!.storeId!, {
      ...query,
      onlyNeeded: query.onlyNeeded && !forecast,
    });
    const merged = all.map((item) => ({
      ...item,
      forecast: forecast?.items.get(item.code) ?? null,
    }));
    // "Chỉ dòng cần đặt": cần theo cách tính này HOẶC theo dự báo, để không giấu dòng dự báo thấy thiếu.
    const items = query.onlyNeeded
      ? merged.filter(
          (item) =>
            item.suggestedOrderQuantity > 0 ||
            (item.forecast !== null &&
              item.forecast.orderQuantity + item.forecast.transferQuantity > 0),
        )
      : merged;
    sendData(res, {
      items,
      forecast: forecast ? { asOf: forecast.asOf, coverDays: forecast.coverDays } : null,
      summary: service.summarize(items),
      settings: {
        windowDays: query.windowDays,
        coverDays: query.coverDays,
        leadTimeDays: query.leadTimeDays,
      },
    });
  },
);
