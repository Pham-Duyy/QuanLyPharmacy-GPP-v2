import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { AppError } from "../../lib/app-error.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requireAnyPermission } from "../../middlewares/require-permission.js";
import {
  CHAIN_WINDOWS,
  analyzeDataset,
  loadChainDataset,
  vnWallClock,
  type ChainWindow,
} from "./analytics.service.js";
import { aiEnabled, aiModel } from "./llm.js";
import { MAX_CSV_BYTES, parseCsv } from "./parse.js";
import { analysisPlanSchema } from "./planner.js";

/**
 * Trợ lý phân tích dữ liệu kinh doanh (contract §20). Không gắn với một cửa
 * hàng: nguồn chuỗi tự lọc theo các cửa hàng người dùng được xem báo cáo,
 * nên không đọc X-Store-Id.
 */
export const analyticsRouter = Router();

analyticsRouter.use(
  "/analytics",
  authenticate,
  requireAnyPermission("report.sales", "report.chain"),
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CSV_BYTES, files: 1 },
});

const questionSchema = z.string().trim().max(500, "Câu hỏi tối đa 500 ký tự").default("");

const csvBodySchema = z.object({
  question: questionSchema,
  /** Multipart chỉ chở chuỗi: kế hoạch gửi kèm dạng JSON. */
  plan: z
    .string()
    .optional()
    .transform((value, context) => {
      if (!value) return undefined;
      try {
        return analysisPlanSchema.parse(JSON.parse(value));
      } catch {
        context.addIssue({ code: "custom", message: "Kế hoạch phân tích không hợp lệ" });
        return z.NEVER;
      }
    }),
  narrate: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

const chainBodySchema = z.object({
  question: questionSchema,
  window: z.enum(Object.keys(CHAIN_WINDOWS) as [ChainWindow, ...ChainWindow[]]).default("day"),
  plan: analysisPlanSchema.optional(),
  narrate: z.boolean().default(true),
});

/** Excel lưu "CSV" kiểu cũ bằng bảng mã Windows; UTF-8 lỗi thì đọc lại theo windows-1258. */
function decodeCsv(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1258").decode(buffer);
  }
}

analyticsRouter.get("/analytics/config", (_req, res) => {
  sendData(res, {
    aiEnabled: aiEnabled(),
    model: aiEnabled() ? aiModel() : null,
    windows: Object.keys(CHAIN_WINDOWS),
  });
});

/** POST /api/v1/analytics/csv: tải một tệp CSV kèm câu hỏi. */
analyticsRouter.post("/analytics/csv", upload.single("file"), async (req, res) => {
  if (!req.file) throw AppError.validation("Chưa chọn tệp CSV");
  const body = parseOrThrow(csvBodySchema, req.body);
  const dataset = parseCsv(decodeCsv(req.file.buffer), req.file.originalname);
  sendData(res, await analyzeDataset(dataset, body));
});

/** POST /api/v1/analytics/chain: phân tích hóa đơn của các cửa hàng được xem. */
analyticsRouter.post("/analytics/chain", async (req, res) => {
  const body = parseOrThrow(chainBodySchema, req.body);
  const dataset = await loadChainDataset(req.auth!, body.window);
  sendData(
    res,
    await analyzeDataset(dataset, {
      question: body.question,
      plan: body.plan,
      narrate: body.narrate,
      now: vnWallClock(),
    }),
  );
});
