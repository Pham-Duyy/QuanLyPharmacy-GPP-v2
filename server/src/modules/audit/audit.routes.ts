import { Router } from "express";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { listAuditLogsSchema } from "./audit.schema.js";
import * as service from "./audit.service.js";

export const auditRouter = Router();

// Audit log không thuộc phạm vi một cửa hàng cụ thể (contract §18) — nhiều
// hành động (tạo tài khoản, mở cửa hàng...) vốn không gắn với cửa hàng nào.
auditRouter.use("/audit-logs", authenticate, requirePermission("audit.read"));

auditRouter.get("/audit-logs", async (req, res) => {
  const query = parseOrThrow(listAuditLogsSchema, req.query);
  sendData(res, await service.list(query));
});
