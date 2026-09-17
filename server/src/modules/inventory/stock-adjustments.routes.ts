import { Router } from "express";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { idempotency } from "../../middlewares/idempotency.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { createAdjustmentSchema, rejectAdjustmentSchema } from "./stock-adjustments.schema.js";
import { loadStockAdjustmentDocument } from "../printing/documents.js";
import { sendDocumentPrint } from "../printing/send-print.js";
import * as service from "./stock-adjustments.service.js";

export const stockAdjustmentsRouter = Router();

// Điều chỉnh tồn thuộc phạm vi cửa hàng, nên mọi endpoint đều cần X-Store-Id.
// Giới hạn theo tiền tố "/stock-adjustments" để không đè lên request của
// router khác cùng gắn vào "/api/v1" (xem ghi chú tương tự ở goods-receipts).
stockAdjustmentsRouter.use("/stock-adjustments", authenticate, storeContext, requireStore);

stockAdjustmentsRouter.get(
  "/stock-adjustments",
  requirePermission("stock.read"),
  async (req, res) => {
    const query = req.query as Record<string, string | undefined>;
    const items = await service.list(req.auth!.storeId!, {
      status: query["status"],
      from: query["from"] ? new Date(query["from"]) : undefined,
      to: query["to"] ? new Date(query["to"]) : undefined,
    });
    sendData(res, items);
  },
);

stockAdjustmentsRouter.get(
  "/stock-adjustments/:id",
  requirePermission("stock.read"),
  async (req, res) => {
    sendData(res, await service.getDetail(req.auth!.storeId!, String(req.params.id)));
  },
);

// Không cần Idempotency-Key: tạo DRAFT chưa đụng tới tồn, gửi trùng chỉ
// tạo thêm bản nháp vô hại, không như các action đổi trạng thái (contract §2.3).
stockAdjustmentsRouter.post(
  "/stock-adjustments",
  requirePermission("stock.adjust.create"),
  async (req, res) => {
    const input = parseOrThrow(createAdjustmentSchema, req.body);
    const id = await withMappedErrors(() =>
      service.createDraft(req.auth!.storeId!, req.auth!.userId, input),
    );
    sendData(res, await service.getDetail(req.auth!.storeId!, id), 201);
  },
);

stockAdjustmentsRouter.post(
  "/stock-adjustments/:id/approve",
  requirePermission("stock.adjust.approve"),
  idempotency,
  async (req, res) => {
    const storeId = req.auth!.storeId!;
    const id = String(req.params.id);
    await withMappedErrors(() => service.approve(storeId, id, req.auth!));
    sendData(res, await service.getDetail(storeId, id));
  },
);

stockAdjustmentsRouter.post(
  "/stock-adjustments/:id/reject",
  requirePermission("stock.adjust.approve"),
  idempotency,
  async (req, res) => {
    const input = parseOrThrow(rejectAdjustmentSchema, req.body);
    const storeId = req.auth!.storeId!;
    const id = String(req.params.id);
    await service.reject(storeId, id, req.auth!, input.reason);
    sendData(res, await service.getDetail(storeId, id));
  },
);

stockAdjustmentsRouter.post(
  "/stock-adjustments/:id/cancel",
  requirePermission("stock.adjust.create"),
  idempotency,
  async (req, res) => {
    const storeId = req.auth!.storeId!;
    const id = String(req.params.id);
    await service.cancel(storeId, id, req.auth!);
    sendData(res, await service.getDetail(storeId, id));
  },
);

/** GET /api/v1/stock-adjustments/{id}/print: in phiếu điều chỉnh tồn theo mẫu của cửa hàng. */
stockAdjustmentsRouter.get(
  "/stock-adjustments/:id/print",
  requirePermission("stock.read"),
  async (req, res) => {
    await sendDocumentPrint(req, res, "stockAdjustment", loadStockAdjustmentDocument);
  },
);
