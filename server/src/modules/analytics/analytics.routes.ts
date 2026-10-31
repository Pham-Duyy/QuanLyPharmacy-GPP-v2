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
import { MAX_CSV_BYTES } from "./parse.js";
import { readUpload } from "./upload.js";
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

const fileBodySchema = z.object({
  question: questionSchema,
  /** Tên sheet Excel; bỏ trống thì lấy sheet đầu tiên có bảng số liệu. */
  sheet: z.string().trim().max(100).optional(),
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

analyticsRouter.get("/analytics/config", (_req, res) => {
  sendData(res, {
    aiEnabled: aiEnabled(),
    model: aiEnabled() ? aiModel() : null,
    windows: Object.keys(CHAIN_WINDOWS),
  });
});

/**
 * POST /api/v1/analytics/file: tải một tệp Excel (.xlsx) hoặc CSV kèm câu hỏi.
 * `/analytics/csv` là tên cũ, giữ lại cho tương thích.
 */
analyticsRouter.post(
  ["/analytics/file", "/analytics/csv"],
  upload.single("file"),
  async (req, res) => {
    if (!req.file) throw AppError.validation("Chưa chọn tệp Excel hoặc CSV");
    const body = parseOrThrow(fileBodySchema, req.body);
    const { dataset, source } = await readUpload(
      req.file.buffer,
      req.file.originalname,
      body.sheet,
    );
    sendData(res, await analyzeDataset(dataset, { ...body, source }));
  },
);

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
      source: { kind: "chain", sheets: [], sheet: null, notes: [] },
    }),
  );
});
