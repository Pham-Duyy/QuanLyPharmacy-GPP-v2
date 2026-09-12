import { Router } from "express";
import { checkDatabase } from "../../db/pool.js";
import { sendData } from "../../lib/respond.js";

export const healthRouter = Router();

/**
 * GET /api/v1/health
 * Trả 200 khi ứng dụng và CSDL đều bình thường, 503 khi CSDL không trả lời.
 * Dùng cho kiểm tra thủ công lúc phát triển và cho giám sát khi chạy thật.
 */
healthRouter.get("/health", async (_req, res) => {
  const database = await checkDatabase();

  sendData(
    res,
    {
      status: database.ok ? "ok" : "degraded",
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      database: {
        status: database.ok ? "ok" : "error",
        latencyMs: database.latencyMs,
        ...(database.message ? { message: database.message } : {}),
      },
    },
    database.ok ? 200 : 503,
  );
});
