import { Router } from "express";
import { AppError } from "../../lib/app-error.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { loyaltySettingsSchema } from "./loyalty.schema.js";
import * as service from "./loyalty.service.js";

export const loyaltyRouter = Router();

// Cài đặt tích điểm gắn với cửa hàng đang làm việc nên bắt buộc X-Store-Id.
// Giới hạn theo tiền tố "/loyalty": nhiều router cùng gắn vào "/api/v1".
loyaltyRouter.use("/loyalty", authenticate, storeContext, requireStore);

/**
 * GET /api/v1/loyalty/settings: cài đặt đang áp dụng. Quầy bán cũng phải đọc
 * được (để biết 1 điểm đổi ra bao nhiêu tiền), nên nhận cả `customer.read`;
 * chỉ `settings.manage` mới được sửa.
 */
loyaltyRouter.get("/loyalty/settings", async (req, res) => {
  const auth = req.auth!;
  if (!auth.can("settings.manage") && !auth.can("customer.read")) {
    throw new AppError(403, "FORBIDDEN", "Bạn không có quyền xem cài đặt tích điểm");
  }
  sendData(res, await service.getSettings(auth.storeId!));
});

/** PUT /api/v1/loyalty/settings: lưu cài đặt tích điểm cho cửa hàng hiện tại. */
loyaltyRouter.put("/loyalty/settings", requirePermission("settings.manage"), async (req, res) => {
  const input = parseOrThrow(loyaltySettingsSchema, req.body);
  const auth = req.auth!;
  sendData(
    res,
    await service.saveSettings(
      auth.storeId!,
      auth.userId,
      input,
      (res.locals.requestId as string | undefined) ?? null,
    ),
  );
});
