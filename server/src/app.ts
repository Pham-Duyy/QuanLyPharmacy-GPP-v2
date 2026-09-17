import "./lib/bigint-json.js";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { pinoHttp } from "pino-http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { env } from "./config/env.js";
import { requestId } from "./middlewares/request-id.js";
import { errorHandler, notFoundHandler } from "./middlewares/error-handler.js";
import cookieParser from "cookie-parser";
import { healthRouter } from "./modules/health/health.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { storesRouter } from "./modules/stores/stores.routes.js";
import { categoriesRouter } from "./modules/catalog/categories.routes.js";
import { ingredientsRouter } from "./modules/catalog/ingredients.routes.js";
import { suppliersRouter } from "./modules/catalog/suppliers.routes.js";
import { customersRouter } from "./modules/customers/customers.routes.js";
import { productsRouter } from "./modules/catalog/products.routes.js";
import { unitsRouter } from "./modules/catalog/units.routes.js";
import { pricesRouter } from "./modules/catalog/prices.routes.js";
import { goodsReceiptsRouter } from "./modules/inventory/goods-receipts.routes.js";
import { invoicesRouter } from "./modules/sales/invoices.routes.js";
import { returnsRouter } from "./modules/sales/returns.routes.js";
import { recallsRouter } from "./modules/recalls/recalls.routes.js";
import { stockAdjustmentsRouter } from "./modules/inventory/stock-adjustments.routes.js";
import { openingBalanceRouter } from "./modules/inventory/opening-balance.routes.js";
import { batchesRouter } from "./modules/inventory/batches.routes.js";
import { inventoryRouter } from "./modules/inventory/inventory.routes.js";
import { storageLogsRouter } from "./modules/inventory/storage-logs.routes.js";
import { prescriptionsRouter } from "./modules/prescriptions/prescriptions.routes.js";
import { prescriptionImagesRouter } from "./modules/prescriptions/prescription-images.routes.js";
import { dashboardRouter } from "./modules/dashboard/dashboard.routes.js";
import { usersRouter } from "./modules/users/users.routes.js";
import { auditRouter } from "./modules/audit/audit.routes.js";
import { reportsRouter } from "./modules/reports/reports.routes.js";
import { settingsRouter } from "./modules/settings/settings.routes.js";

/**
 * Lắp ráp ứng dụng Express. Thứ tự middleware quan trọng:
 * requestId -> log -> bảo mật -> đọc body -> route -> 404 -> xử lý lỗi.
 */
export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  app.use(requestId);

  app.use(
    pinoHttp({
      level: env.LOG_LEVEL,
      // Dùng lại requestId đã gắn ở middleware trên để log và response khớp nhau.
      genReqId: (_req: IncomingMessage, res: ServerResponse) =>
        String((res as { locals?: { requestId?: string } }).locals?.requestId ?? ""),
      ...(env.NODE_ENV === "development"
        ? {
            transport: {
              target: "pino-pretty",
              options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
            },
          }
        : {}),
    }),
  );

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(",").map((value) => value.trim()),
      credentials: true,
      // Giao diện đọc khổ giấy của trang in để hiển thị bản xem trước đúng kích thước.
      exposedHeaders: ["X-Paper-Size"],
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.use("/api/v1", healthRouter);
  app.use("/api/v1", authRouter);
  app.use("/api/v1", storesRouter);
  app.use("/api/v1", categoriesRouter);
  app.use("/api/v1", ingredientsRouter);
  app.use("/api/v1", suppliersRouter);
  app.use("/api/v1", customersRouter);
  app.use("/api/v1", productsRouter);
  app.use("/api/v1", unitsRouter);
  app.use("/api/v1", pricesRouter);
  app.use("/api/v1", goodsReceiptsRouter);
  app.use("/api/v1", invoicesRouter);
  app.use("/api/v1", returnsRouter);
  app.use("/api/v1", recallsRouter);
  app.use("/api/v1", stockAdjustmentsRouter);
  app.use("/api/v1", openingBalanceRouter);
  app.use("/api/v1", batchesRouter);
  app.use("/api/v1", inventoryRouter);
  app.use("/api/v1", storageLogsRouter);
  app.use("/api/v1", prescriptionsRouter);
  app.use("/api/v1", prescriptionImagesRouter);
  app.use("/api/v1", dashboardRouter);
  app.use("/api/v1", usersRouter);
  app.use("/api/v1", auditRouter);
  app.use("/api/v1", reportsRouter);
  app.use("/api/v1", settingsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
