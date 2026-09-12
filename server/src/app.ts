import express from "express";
import helmet from "helmet";
import cors from "cors";
import { pinoHttp } from "pino-http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { env } from "./config/env.js";
import { requestId } from "./middlewares/request-id.js";
import { errorHandler, notFoundHandler } from "./middlewares/error-handler.js";
import { healthRouter } from "./modules/health/health.routes.js";

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
      genReqId: (_req: IncomingMessage, res: ServerResponse) => String((res as { locals?: { requestId?: string } }).locals?.requestId ?? ""),
      ...(env.NODE_ENV === "development"
        ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } }
        : {}),
    }),
  );

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(",").map((value) => value.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  app.use("/api/v1", healthRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
