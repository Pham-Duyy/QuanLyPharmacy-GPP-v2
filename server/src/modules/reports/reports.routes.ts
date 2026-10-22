import { Router } from "express";
import { AppError } from "../../lib/app-error.js";
import { parseOrThrow } from "../../lib/validate.js";
import { sendData } from "../../lib/respond.js";
import { businessDateNow } from "../../lib/settings.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { getPeriodSummary, monthRange } from "./period-summary.service.js";
import { monthlyQuerySchema, reportsQuerySchema } from "./reports.schema.js";
import { getReportsSummary } from "./reports.service.js";

export const reportsRouter = Router();

// Báo cáo kinh doanh thuộc phạm vi cửa hàng (contract §2.8, §19).
reportsRouter.use("/reports", authenticate, storeContext, requireStore);

reportsRouter.get("/reports/summary", requirePermission("report.sales"), async (req, res) => {
  const query = parseOrThrow(reportsQuerySchema, req.query);
  sendData(res, await getReportsSummary(req.auth!.storeId!, query.from, query.to));
});

/** GET /api/v1/reports/monthly?month=YYYY-MM: tổng kết tháng (nhập, bán, hàng đứng yên, nhập – xuất – tồn). */
reportsRouter.get("/reports/monthly", requirePermission("report.sales"), async (req, res) => {
  const { month } = parseOrThrow(monthlyQuerySchema, req.query);
  const range = monthRange(month, businessDateNow());
  if (range.from > businessDateNow()) throw AppError.validation("Tháng này chưa tới");
  const summary = await getPeriodSummary(req.auth!.storeId!, req.auth!, range.from, range.to);
  sendData(res, { month, partial: range.partial, ...summary });
});
