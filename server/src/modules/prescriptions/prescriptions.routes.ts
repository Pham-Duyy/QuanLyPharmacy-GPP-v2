import { Router } from "express";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { idempotency } from "../../middlewares/idempotency.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { storeContext } from "../../middlewares/store-context.js";
import {
  createPrescriptionSchema,
  patchPrescriptionSchema,
  rejectPrescriptionSchema,
  verifyPrescriptionSchema,
} from "./prescriptions.schema.js";
import * as service from "./prescriptions.service.js";

export const prescriptionsRouter = Router();

// Đơn thuốc dùng chung toàn chuỗi (contract §2.8): tạo ở cửa hàng nào cũng
// bán được ở cửa hàng khác, nên không đòi X-Store-Id ở toàn router — chỉ
// riêng lúc TẠO mới cần biết cửa hàng tiếp nhận (kiểm tra trong service).
prescriptionsRouter.use("/prescriptions", authenticate, storeContext);

prescriptionsRouter.get(
  "/prescriptions",
  requirePermission("prescription.read"),
  async (req, res) => {
    const query = req.query as Record<string, string | undefined>;
    sendData(res, await service.list({ customerId: query["customerId"], status: query["status"] }));
  },
);

prescriptionsRouter.get(
  "/prescriptions/:id",
  requirePermission("prescription.read"),
  async (req, res) => {
    sendData(res, await service.getDetail(String(req.params.id), req.auth!));
  },
);

prescriptionsRouter.post(
  "/prescriptions",
  requirePermission("prescription.create"),
  async (req, res) => {
    const input = parseOrThrow(createPrescriptionSchema, req.body);
    const id = await withMappedErrors(() =>
      service.createDraft(req.auth!.storeId, req.auth!.userId, input),
    );
    sendData(res, await service.getDetail(id, req.auth!), 201);
  },
);

prescriptionsRouter.patch(
  "/prescriptions/:id",
  requirePermission("prescription.create"),
  async (req, res) => {
    const input = parseOrThrow(patchPrescriptionSchema, req.body);
    const id = String(req.params.id);
    await withMappedErrors(() => service.updateDraft(id, input));
    sendData(res, await service.getDetail(id, req.auth!));
  },
);

prescriptionsRouter.post(
  "/prescriptions/:id/submit",
  requirePermission("prescription.create"),
  idempotency,
  async (req, res) => {
    const id = String(req.params.id);
    await service.submit(id);
    sendData(res, await service.getDetail(id, req.auth!));
  },
);

prescriptionsRouter.post(
  "/prescriptions/:id/verify",
  requirePermission("prescription.verify"),
  idempotency,
  async (req, res) => {
    const input = parseOrThrow(verifyPrescriptionSchema, req.body);
    const id = String(req.params.id);
    await withMappedErrors(() => service.verify(id, req.auth!, input));
    sendData(res, await service.getDetail(id, req.auth!));
  },
);

prescriptionsRouter.post(
  "/prescriptions/:id/reject",
  requirePermission("prescription.verify"),
  idempotency,
  async (req, res) => {
    const input = parseOrThrow(rejectPrescriptionSchema, req.body);
    const id = String(req.params.id);
    await service.reject(id, input.reason);
    sendData(res, await service.getDetail(id, req.auth!));
  },
);
