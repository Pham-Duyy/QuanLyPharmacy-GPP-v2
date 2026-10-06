import { Router } from "express";
import { z } from "zod";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { idempotency } from "../../middlewares/idempotency.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { loadStockTransferDocument } from "../printing/documents.js";
import { sendDocumentPrint } from "../printing/send-print.js";
import * as service from "./stock-transfers.service.js";

/**
 * Chuyển hàng giữa các cửa hàng (contract §10.9). `X-Store-Id` là cửa hàng
 * đang thao tác: lập, xuất, hủy ở cửa hàng gửi; nhận ở cửa hàng nhận. Quyền
 * vì vậy xét đúng tại nơi làm việc đó.
 */
export const stockTransfersRouter = Router();
stockTransfersRouter.use("/stock-transfers", authenticate, storeContext, requireStore);

const STATUSES = ["DRAFT", "IN_TRANSIT", "RECEIVED", "CANCELLED"] as const;

const createSchema = z.object({
  toStoreId: z.uuid("toStoreId không hợp lệ"),
  note: z.string().trim().max(500).nullish(),
  lines: z
    .array(
      z.object({
        batchId: z.uuid("batchId không hợp lệ"),
        unitId: z.uuid("unitId không hợp lệ"),
        quantity: z.coerce.number().int().positive("Số lượng phải lớn hơn 0"),
      }),
    )
    .min(1, "Phiếu chuyển phải có ít nhất một dòng")
    .max(200, "Một phiếu chuyển tối đa 200 dòng"),
});

const receiveSchema = z.object({
  note: z.string().trim().max(500).nullish(),
  lines: z
    .array(
      z.object({
        lineId: z.uuid("lineId không hợp lệ"),
        receivedBaseQuantity: z.coerce.number().int().min(0, "Số thực nhận không được âm"),
        passed: z.boolean(),
        rejectReason: z.string().trim().max(300).nullish(),
      }),
    )
    .min(1, "Phải ghi kết quả nhận cho từng dòng"),
});

const reasonSchema = z.object({
  reason: z.string().trim().min(1, "Phải ghi lý do hủy phiếu").max(500),
});

stockTransfersRouter.get(
  "/stock-transfers/destinations",
  requirePermission("stock.transfer.create"),
  async (req, res) => {
    sendData(res, await service.listDestinations(req.auth!.storeId!));
  },
);

stockTransfersRouter.get(
  "/stock-transfers/transferable",
  requirePermission("stock.transfer.create"),
  async (req, res) => {
    const query = parseOrThrow(
      z.object({ search: z.string().trim().max(100).optional() }),
      req.query,
    );
    sendData(res, await service.listTransferable(req.auth!.storeId!, query.search || undefined));
  },
);

stockTransfersRouter.get(
  "/stock-transfers/incoming-count",
  requirePermission("stock.read"),
  async (req, res) => {
    sendData(res, { inTransit: await service.incomingCount(req.auth!.storeId!) });
  },
);

stockTransfersRouter.get("/stock-transfers", requirePermission("stock.read"), async (req, res) => {
  const query = parseOrThrow(
    z.object({
      direction: z.enum(["OUT", "IN"]).default("OUT"),
      status: z.enum(STATUSES).optional(),
    }),
    req.query,
  );
  sendData(res, await service.list(req.auth!.storeId!, req.auth!, query));
});

/** GET /api/v1/stock-transfers/{id}/print: phiếu chuyển kho theo mẫu của cửa hàng đang in. */
stockTransfersRouter.get(
  "/stock-transfers/:id/print",
  requirePermission("stock.read"),
  async (req, res) => {
    await sendDocumentPrint(req, res, "stockTransfer", loadStockTransferDocument);
  },
);

stockTransfersRouter.get(
  "/stock-transfers/:id",
  requirePermission("stock.read"),
  async (req, res) => {
    sendData(res, await service.getDetail(req.auth!.storeId!, String(req.params.id), req.auth!));
  },
);

/** POST /api/v1/stock-transfers: lập phiếu nháp; chưa trừ tồn. */
stockTransfersRouter.post(
  "/stock-transfers",
  requirePermission("stock.transfer.create"),
  idempotency,
  async (req, res) => {
    const input = parseOrThrow(createSchema, req.body);
    const id = await service.createDraft(req.auth!.storeId!, req.auth!, {
      toStoreId: input.toStoreId,
      note: input.note || null,
      lines: input.lines,
    });
    sendData(res, await service.getDetail(req.auth!.storeId!, id, req.auth!), 201);
  },
);

/** POST /api/v1/stock-transfers/{id}/ship: xác nhận xuất, trừ tồn cửa hàng gửi. */
stockTransfersRouter.post(
  "/stock-transfers/:id/ship",
  requirePermission("stock.transfer.create"),
  idempotency,
  async (req, res) => {
    const id = String(req.params.id);
    await service.ship(req.auth!.storeId!, id, req.auth!);
    sendData(res, await service.getDetail(req.auth!.storeId!, id, req.auth!));
  },
);

/** POST /api/v1/stock-transfers/{id}/receive: kiểm nhập ở cửa hàng nhận, cộng tồn. */
stockTransfersRouter.post(
  "/stock-transfers/:id/receive",
  requirePermission("stock.transfer.receive"),
  idempotency,
  async (req, res) => {
    const id = String(req.params.id);
    const input = parseOrThrow(receiveSchema, req.body);
    await service.receive(req.auth!.storeId!, id, req.auth!, {
      note: input.note || null,
      lines: input.lines,
    });
    sendData(res, await service.getDetail(req.auth!.storeId!, id, req.auth!));
  },
);

/** POST /api/v1/stock-transfers/{id}/cancel: hủy nháp, hoặc thu hồi phiếu đang chuyển. */
stockTransfersRouter.post(
  "/stock-transfers/:id/cancel",
  requirePermission("stock.transfer.create"),
  idempotency,
  async (req, res) => {
    const id = String(req.params.id);
    const input = parseOrThrow(reasonSchema, req.body);
    await service.cancel(req.auth!.storeId!, id, req.auth!, input.reason);
    sendData(res, await service.getDetail(req.auth!.storeId!, id, req.auth!));
  },
);
