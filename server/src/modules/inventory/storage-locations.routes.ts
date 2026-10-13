import { Router } from "express";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { createLocationSchema, updateLocationSchema } from "./storage-logs.schema.js";
import * as service from "./storage-locations.service.js";

export const storageLocationsRouter = Router();

// Khu vực bảo quản thuộc cửa hàng đang chọn; người ghi sổ xem được, chủ nhà thuốc sửa.
storageLocationsRouter.use("/storage-locations", authenticate, storeContext, requireStore);

storageLocationsRouter.get(
  "/storage-locations",
  requirePermission("storage_log.read"),
  async (req, res) => {
    sendData(res, await service.listLocations(req.auth!.storeId!));
  },
);

/** Tạo hai khu mặc định cho cửa hàng chưa có khu nào. */
storageLocationsRouter.post(
  "/storage-locations/defaults",
  requirePermission("store.manage"),
  async (req, res) => {
    sendData(res, await service.createDefaults(req.auth!.storeId!, req.auth!.userId), 201);
  },
);

storageLocationsRouter.post(
  "/storage-locations",
  requirePermission("store.manage"),
  async (req, res) => {
    const input = parseOrThrow(createLocationSchema, req.body);
    sendData(res, await service.createLocation(req.auth!.storeId!, req.auth!.userId, input), 201);
  },
);

storageLocationsRouter.patch(
  "/storage-locations/:id",
  requirePermission("store.manage"),
  async (req, res) => {
    const input = parseOrThrow(updateLocationSchema, req.body);
    sendData(
      res,
      await service.updateLocation(
        req.auth!.storeId!,
        req.auth!.userId,
        String(req.params.id),
        input,
      ),
    );
  },
);
