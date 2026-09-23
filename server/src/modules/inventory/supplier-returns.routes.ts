import { Router } from "express";
import { z } from "zod";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { SETTLEMENTS } from "./supplier-returns.service.js";
import * as service from "./supplier-returns.service.js";

export const supplierReturnsRouter = Router();
supplierReturnsRouter.use("/supplier-returns", authenticate, storeContext, requireStore);

const createSchema = z.object({
  supplierId: z.uuid("supplierId không hợp lệ"),
  reason: z.string().trim().min(1, "Phải ghi lý do trả hàng").max(500),
  settlement: z.enum(SETTLEMENTS).default("DEDUCT_DEBT"),
  note: z.string().trim().max(500).nullish(),
  lines: z
    .array(
      z.object({
        batchId: z.uuid("batchId không hợp lệ"),
        unitId: z.uuid("unitId không hợp lệ"),
        quantity: z.coerce.number().int().positive("Số lượng phải lớn hơn 0"),
        note: z.string().trim().max(300).nullish(),
      }),
    )
    .min(1, "Phiếu trả phải có ít nhất một dòng"),
});

/** GET /api/v1/supplier-returns/returnable: lô còn tồn kèm nhà cung cấp đã mang về. */
supplierReturnsRouter.get("/supplier-returns/returnable", requirePermission("goods_receipt.read"), async (req, res) => {
  const query = parseOrThrow(z.object({ supplierId: z.uuid().optional(), search: z.string().trim().max(100).optional() }), req.query);
  sendData(res, await service.listReturnable(req.auth!.storeId!, query));
});

supplierReturnsRouter.get("/supplier-returns", requirePermission("goods_receipt.read"), async (req, res) => {
  const query = parseOrThrow(z.object({ status: z.enum(["DRAFT", "CONFIRMED", "CANCELLED"]).optional(), supplierId: z.uuid().optional() }), req.query);
  sendData(res, await service.list(req.auth!.storeId!, query));
});

supplierReturnsRouter.get("/supplier-returns/:id", requirePermission("goods_receipt.read"), async (req, res) => {
  sendData(res, await service.getDetail(req.auth!.storeId!, String(req.params.id)));
});

/** POST /api/v1/supplier-returns: lập phiếu trả hàng ở trạng thái nháp. */
supplierReturnsRouter.post("/supplier-returns", requirePermission("goods_receipt.create"), async (req, res) => {
  const input = parseOrThrow(createSchema, req.body);
  const id = await service.createDraft(req.auth!.storeId!, req.auth!, {
    supplierId: input.supplierId,
    reason: input.reason,
    settlement: input.settlement,
    note: input.note ?? null,
    lines: input.lines,
  });
  sendData(res, await service.getDetail(req.auth!.storeId!, id), 201);
});

/** POST /api/v1/supplier-returns/{id}/confirm: xác nhận, trừ tồn và ghi thẻ kho. */
supplierReturnsRouter.post("/supplier-returns/:id/confirm", requirePermission("goods_receipt.confirm"), async (req, res) => {
  await service.confirmReturn(req.auth!.storeId!, String(req.params.id), req.auth!);
  sendData(res, await service.getDetail(req.auth!.storeId!, String(req.params.id)));
});

/** POST /api/v1/supplier-returns/{id}/cancel: hủy phiếu còn nháp, bắt buộc có lý do. */
supplierReturnsRouter.post("/supplier-returns/:id/cancel", requirePermission("goods_receipt.create"), async (req, res) => {
  const input = parseOrThrow(z.object({ reason: z.string().trim().min(1, "Phải ghi lý do hủy phiếu").max(500) }), req.body);
  await service.cancelReturn(req.auth!.storeId!, String(req.params.id), req.auth!, input.reason);
  sendData(res, await service.getDetail(req.auth!.storeId!, String(req.params.id)));
});
