import { Router } from "express";
import { z } from "zod";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { getConfigView, updateChainConfig, updateStoreConfig } from "./erx-config.service.js";
import { importByCode, matchPrescriptionItem } from "./erx-import.service.js";
import { listJobs, retryJob } from "./erx-queue.service.js";

/** Đơn thuốc điện tử — Hệ thống đơn thuốc quốc gia (contract §12.1). */
export const eprescriptionsRouter = Router();
eprescriptionsRouter.use("/eprescriptions", authenticate, storeContext);

eprescriptionsRouter.get(
  "/eprescriptions/config",
  requirePermission("national_sync.read"),
  async (req, res) => {
    sendData(res, await getConfigView(req.auth!.storeId ?? null));
  },
);

/** Cấu hình chung cả chuỗi: app-name/app-key cấp cho đơn vị làm phần mềm. */
eprescriptionsRouter.put(
  "/eprescriptions/config",
  requirePermission("national_sync.manage"),
  async (req, res) => {
    const input = parseOrThrow(
      z.object({
        enabled: z.boolean().optional(),
        appName: z.string().trim().max(200).nullish(),
        appKey: z.string().trim().max(500).nullish(),
      }),
      req.body,
    );
    await updateChainConfig(req.auth!.userId, input);
    sendData(res, await getConfigView(req.auth!.storeId ?? null));
  },
);

/** Mã định danh cơ sở cung ứng thuốc của cửa hàng đang chọn. */
eprescriptionsRouter.put(
  "/eprescriptions/store-config",
  requireStore,
  requirePermission("national_sync.manage"),
  async (req, res) => {
    const input = parseOrThrow(
      z.object({ facilityCode: z.string().trim().min(1, "Nhập mã định danh cơ sở").max(200) }),
      req.body,
    );
    await updateStoreConfig(req.auth!.storeId!, req.auth!.userId, input.facilityCode);
    sendData(res, await getConfigView(req.auth!.storeId!));
  },
);

/** POST /api/v1/eprescriptions/import: lấy đơn theo mã về thành đơn thuốc nháp. */
eprescriptionsRouter.post(
  "/eprescriptions/import",
  requireStore,
  requirePermission("prescription.create"),
  async (req, res) => {
    const input = parseOrThrow(
      z.object({ code: z.string().trim().min(1, "Nhập mã đơn thuốc").max(40) }),
      req.body,
    );
    const result = await importByCode(req.auth!.storeId!, req.auth!, input.code);
    sendData(res, result, result.created ? 201 : 200);
  },
);

/** Dược sĩ chọn sản phẩm cho dòng đơn điện tử chưa khớp; lần sau tự khớp. */
eprescriptionsRouter.post(
  "/eprescriptions/prescriptions/:id/items/:itemId/match",
  requirePermission("prescription.create"),
  async (req, res) => {
    const input = parseOrThrow(z.object({ productId: z.uuid(), unitId: z.uuid() }), req.body);
    await matchPrescriptionItem(String(req.params.id), String(req.params.itemId), req.auth!, input);
    sendData(res, { matched: true });
  },
);

eprescriptionsRouter.get(
  "/eprescriptions/jobs",
  requireStore,
  requirePermission("national_sync.read"),
  async (req, res) => {
    const query = parseOrThrow(
      z.object({
        status: z
          .enum(["PENDING", "SENDING", "SENT", "FAILED", "REJECTED", "CANCELLED", "NEEDS_REVIEW"])
          .optional(),
      }),
      req.query,
    );
    sendData(res, await listJobs(req.auth!.storeId!, query.status));
  },
);

eprescriptionsRouter.post(
  "/eprescriptions/jobs/:id/retry",
  requireStore,
  requirePermission("national_sync.manage"),
  async (req, res) => {
    await retryJob(String(req.params.id), req.auth!.storeId!, req.auth!.userId);
    sendData(res, { retried: true });
  },
);
