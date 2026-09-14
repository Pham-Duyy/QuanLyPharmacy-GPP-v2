import { Router } from "express";
import { parseOrThrow } from "../../lib/validate.js";
import { sendData } from "../../lib/respond.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { reportsQuerySchema } from "./reports.schema.js";
import { getReportsSummary } from "./reports.service.js";

export const reportsRouter = Router();

// Báo cáo kinh doanh thuộc phạm vi cửa hàng (contract §2.8, §19).
reportsRouter.use("/reports", authenticate, storeContext, requireStore);

reportsRouter.get("/reports/summary", requirePermission("report.sales"), async (req, res) => {
  const query = parseOrThrow(reportsQuerySchema, req.query);
  sendData(res, await getReportsSummary(req.auth!.storeId!, query.from, query.to));
});
