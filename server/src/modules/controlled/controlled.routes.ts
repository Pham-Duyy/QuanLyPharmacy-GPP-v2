import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/app-error.js";
import { sendData } from "../../lib/respond.js";
import { businessDateNow } from "../../lib/settings.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import * as service from "./controlled.service.js";

export const controlledRouter = Router();
controlledRouter.use("/controlled-drugs", authenticate, storeContext, requireStore, requirePermission("controlled.read"));

const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày phải có dạng YYYY-MM-DD")
  .transform((value) => new Date(`${value}T00:00:00.000Z`));

const ledgerQuerySchema = z.object({
  from: daySchema.optional(),
  to: daySchema.optional(),
  productId: z.uuid("productId không hợp lệ").optional(),
});

/** GET /api/v1/controlled-drugs: danh mục thuốc kiểm soát đặc biệt và tồn hiện tại. */
controlledRouter.get("/controlled-drugs", async (req, res) => {
  sendData(res, await service.listControlledProducts(req.auth!.storeId!));
});

/**
 * GET /api/v1/controlled-drugs/ledger?from&to&productId: sổ theo dõi xuất
 * nhập, dựng lại từ thẻ kho nên luôn khớp tồn kho thật.
 */
controlledRouter.get("/controlled-drugs/ledger", async (req, res) => {
  const query = parseOrThrow(ledgerQuerySchema, req.query);
  const today = businessDateNow();
  const to = query.to ?? today;
  const from = query.from ?? new Date(to.getTime() - 29 * 86_400_000);
  if (from.getTime() > to.getTime()) throw AppError.validation("Từ ngày phải trước hoặc bằng đến ngày");
  if ((to.getTime() - from.getTime()) / 86_400_000 > 366) throw AppError.validation("Chỉ xem tối đa 366 ngày mỗi lần");

  const ledger = await service.buildLedger({ storeId: req.auth!.storeId!, from, to, productId: query.productId });
  sendData(res, {
    from,
    to,
    products: ledger,
    // Kỳ kết thúc hôm nay thì số cuối kỳ phải bằng tồn kho; lệch là dấu hiệu
    // dữ liệu có vấn đề, phải báo ngay cho người phụ trách chuyên môn.
    mismatches: service.reconcile(ledger, to.getTime() === today.getTime()),
  });
});
