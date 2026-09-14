import { Router } from "express";
import { z } from "zod";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { getDashboard } from "./dashboard.service.js";

export const dashboardRouter = Router();

dashboardRouter.use("/dashboard", authenticate, storeContext, requireStore);

const querySchema = z.object({
  days: z.coerce
    .number()
    .refine((value): value is 7 | 30 => value === 7 || value === 30, "days chỉ nhận 7 hoặc 30")
    .default(7),
});

dashboardRouter.get("/dashboard", requirePermission("catalog.read"), async (req, res) => {
  const query = parseOrThrow(querySchema, req.query);
  sendData(res, await getDashboard(req.auth!.storeId!, req.auth!, query.days));
});
