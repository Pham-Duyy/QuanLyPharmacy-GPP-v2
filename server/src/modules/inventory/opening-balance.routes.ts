import { Router } from "express";
import { withMappedErrors } from "../../lib/prisma-errors.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { idempotency } from "../../middlewares/idempotency.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { getDetail } from "./goods-receipts.service.js";
import { openingBalanceSchema } from "./opening-balance.schema.js";
import { createOpeningBalance } from "./opening-balance.service.js";

export const openingBalanceRouter = Router();

// Thuộc phạm vi cửa hàng (contract §2.8). Giới hạn theo tiền tố "/inventory"
// để không đè lên request của router khác cùng gắn vào "/api/v1".
openingBalanceRouter.use("/inventory", authenticate, storeContext, requireStore);

openingBalanceRouter.post(
  "/inventory/opening-balances",
  requirePermission("stock.opening_balance"),
  idempotency,
  async (req, res) => {
    const input = parseOrThrow(openingBalanceSchema, req.body);
    const storeId = req.auth!.storeId!;
    const id = await withMappedErrors(() => createOpeningBalance(storeId, req.auth!.userId, input));
    // Xem lại chi tiết dùng chung với phiếu nhập: cùng bảng, khác `type`.
    sendData(res, await getDetail(storeId, id), 201);
  },
);
