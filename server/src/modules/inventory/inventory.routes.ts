import { Router } from "express";
import { z } from "zod";
import { MAX_LIMIT } from "../../lib/pagination.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireStore, storeContext } from "../../middlewares/store-context.js";
import { getInventoryOverview, listStockLedger } from "./inventory.service.js";

export const inventoryRouter = Router();

// Tồn kho luôn thuộc một cửa hàng cụ thể (contract §2.8).
inventoryRouter.use(
  ["/inventory", "/inventory/transactions"],
  authenticate,
  storeContext,
  requireStore,
);

const overviewQuerySchema = z.object({
  productId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  belowMinStock: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(20),
});

inventoryRouter.get("/inventory", requirePermission("stock.read"), async (req, res) => {
  const query = parseOrThrow(overviewQuerySchema, req.query);
  const all = await getInventoryOverview(req.auth!.storeId!, {
    productId: query.productId,
    categoryId: query.categoryId,
    belowMinStock: query.belowMinStock === "true",
  });

  const skip = (query.page - 1) * query.limit;
  sendData(res, {
    items: all.slice(skip, skip + query.limit),
    pagination: { page: query.page, limit: query.limit, total: all.length },
  });
});

const MOVEMENT_TYPES = [
  "RECEIPT",
  "OPENING_BALANCE",
  "SALE",
  "SALE_VOID",
  "CUSTOMER_RETURN",
  "ADJUSTMENT",
  "DISPOSAL",
] as const;

const ledgerQuerySchema = z.object({
  batchId: z.uuid().optional(),
  productId: z.uuid().optional(),
  type: z.enum(MOVEMENT_TYPES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().regex(/^\d+$/, "cursor không hợp lệ").optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(50),
});

inventoryRouter.get(
  "/inventory/transactions",
  requirePermission("stock.read"),
  async (req, res) => {
    const query = parseOrThrow(ledgerQuerySchema, req.query);
    sendData(res, await listStockLedger(req.auth!.storeId!, query));
  },
);
