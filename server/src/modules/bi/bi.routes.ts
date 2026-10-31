import { Router } from "express";
import { z } from "zod";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requireAnyPermission } from "../../middlewares/require-permission.js";
import { agentStatus, askQuestion } from "./agent/agent.service.js";
import { fetchAnalytics } from "./bi.client.js";
import {
  biAccess,
  getAlerts,
  getAnomalies,
  getBreakdown,
  getClassification,
  getDataQuality,
  getExpiry,
  getForecast,
  getInventory,
  getPeriodView,
  getProducts,
  getReorder,
  getSalesTrend,
  getSummary,
  reorderWorkbook,
} from "./bi.service.js";

export { biAccess, type BiAccess } from "./bi.service.js";

/**
 * Cổng Bảng điều hành (Phase 1, bước 1.7): giao diện → Node → analytics-service.
 *
 * Node giữ đăng nhập và phân quyền; analytics-service chỉ tính số, không biết
 * ai đang hỏi. Quy ước: `store_code` trong tệp dữ liệu trùng mã cửa hàng của
 * phần mềm, nhờ vậy quyền "xem báo cáo cửa hàng X" áp được lên số liệu từ tệp.
 * Quy tắc ai được thấy gì nằm ở bi.service.ts, dùng chung với tool của AI Agent.
 */
export const biRouter = Router();

// report.inventory: dược sĩ xem Bảng điều hành cửa hàng mình (D24). Lọc chi tiết nằm ở bi.service.ts.
biRouter.use(
  "/bi",
  authenticate,
  requireAnyPermission("report.sales", "report.chain", "report.inventory"),
);

const storeField = z
  .string()
  .trim()
  .max(20)
  .regex(/^[A-Za-z0-9_-]+$/, "Mã cửa hàng không hợp lệ")
  .optional();
const periodField = z.enum(["day", "week", "month"]);
const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày dạng YYYY-MM-DD")
  .optional();

const summaryQuery = z.object({ store: storeField });
const periodQuery = z.object({ store: storeField, period: periodField.optional() });
const trendQuery = z.object({
  store: storeField,
  grain: periodField.default("day"),
  start: dateField,
  end: dateField,
});
const breakdownQuery = z.object({
  by: z
    .enum(["category", "sale_type", "store", "payment_method", "top_medicines"])
    .default("category"),
});
const qualityQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) });
const productsQuery = z.object({ store: storeField, period: periodField.default("month") });
const inventoryQuery = z.object({
  store: storeField,
  status: z.enum(["out_of_stock", "low", "dead", "high", "normal"]).optional(),
});
const expiryQuery = z.object({
  store: storeField,
  level: z.enum(["expired", "critical", "warning", "monitor"]).optional(),
});
const anomaliesQuery = z.object({
  store: storeField,
  days: z.coerce.number().int().min(1).max(60).default(14),
  direction: z.enum(["down", "up"]).optional(),
});
const forecastQuery = z.object({
  store: storeField,
  target: z.enum(["revenue", "demand"]).default("revenue"),
});

const classificationQuery = z.object({
  store: storeField,
  abc: z.enum(["A", "B", "C"]).optional(),
  xyz: z.enum(["X", "Y", "Z"]).optional(),
});
const reorderQuery = z.object({
  store: storeField,
  action: z.enum(["order", "transfer"]).optional(),
});

biRouter.get("/bi/access", async (req, res) => {
  sendData(res, await biAccess(req.auth!));
});

biRouter.get("/bi/version", async (_req, res) => {
  sendData(res, await fetchAnalytics("version"));
});

type Health = {
  monitor: Record<string, unknown> | null;
  last_run: Record<string, unknown> | null;
  [key: string]: unknown;
};

biRouter.get("/bi/health", async (req, res) => {
  const access = await biAccess(req.auth!);
  const health = await fetchAnalytics<Health>("health");
  // Đường dẫn thư mục trên máy chủ không cần cho giao diện.
  if (health.monitor) delete health.monitor["folder"];
  if (!access.allStores && health.last_run) delete health.last_run["error_message"];
  sendData(res, health);
});

biRouter.get("/bi/summary", async (req, res) => {
  const query = parseOrThrow(summaryQuery, req.query);
  sendData(res, await getSummary(await biAccess(req.auth!), query));
});

for (const view of ["revenue", "profit"] as const) {
  biRouter.get(`/bi/${view}`, async (req, res) => {
    const query = parseOrThrow(periodQuery, req.query);
    sendData(res, await getPeriodView(await biAccess(req.auth!), view, query));
  });
}

biRouter.get("/bi/sales-trend", async (req, res) => {
  const query = parseOrThrow(trendQuery, req.query);
  sendData(res, await getSalesTrend(await biAccess(req.auth!), query));
});

biRouter.get("/bi/breakdown", async (req, res) => {
  const query = parseOrThrow(breakdownQuery, req.query);
  sendData(res, await getBreakdown(await biAccess(req.auth!), query));
});

biRouter.get("/bi/data-quality", async (req, res) => {
  const query = parseOrThrow(qualityQuery, req.query);
  sendData(res, await getDataQuality(await biAccess(req.auth!), query));
});

biRouter.get("/bi/products", async (req, res) => {
  const query = parseOrThrow(productsQuery, req.query);
  sendData(res, await getProducts(await biAccess(req.auth!), query));
});

biRouter.get("/bi/inventory", async (req, res) => {
  const query = parseOrThrow(inventoryQuery, req.query);
  sendData(res, await getInventory(await biAccess(req.auth!), query));
});

biRouter.get("/bi/expiry", async (req, res) => {
  const query = parseOrThrow(expiryQuery, req.query);
  sendData(res, await getExpiry(await biAccess(req.auth!), query));
});

biRouter.get("/bi/alerts", async (req, res) => {
  const query = parseOrThrow(summaryQuery, req.query);
  sendData(res, await getAlerts(await biAccess(req.auth!), query));
});

biRouter.get("/bi/anomalies", async (req, res) => {
  const query = parseOrThrow(anomaliesQuery, req.query);
  sendData(res, await getAnomalies(await biAccess(req.auth!), query));
});

biRouter.get("/bi/forecast", async (req, res) => {
  const query = parseOrThrow(forecastQuery, req.query);
  sendData(res, await getForecast(await biAccess(req.auth!), query));
});

// --- Phase 5: ABC–XYZ, gợi ý đặt hàng ------------------------------------------------------

biRouter.get("/bi/classification", async (req, res) => {
  const query = parseOrThrow(classificationQuery, req.query);
  sendData(res, await getClassification(await biAccess(req.auth!), query));
});

biRouter.get("/bi/reorder", async (req, res) => {
  const query = parseOrThrow(reorderQuery, req.query);
  sendData(res, await getReorder(await biAccess(req.auth!), query));
});

biRouter.get("/bi/reorder/export", async (req, res) => {
  const query = parseOrThrow(reorderQuery, req.query);
  const plan = await getReorder(await biAccess(req.auth!), query);
  const fileName = `goi-y-dat-hang-${String(plan["store"] ?? "ALL")}-${String(plan["as_of"] ?? "").slice(0, 10)}.xlsx`;
  res
    .set(
      "Content-Disposition",
      `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    )
    .set("Cache-Control", "no-store")
    .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .send(await reorderWorkbook(plan));
});

// --- AI Agent (Phase 4, bước 4.4) -----------------------------------------------------------

const askBody = z.object({
  question: z.string().trim().min(1, "Câu hỏi trống").max(1_000, "Câu hỏi tối đa 1.000 ký tự"),
  conversationId: z.uuid("Mã hội thoại không hợp lệ").optional(),
  /** Cửa hàng đang chọn trên Bảng điều hành: phạm vi mặc định khi câu hỏi không nêu. */
  store: storeField,
});

biRouter.get("/bi/ask/status", async (req, res) => {
  sendData(res, await agentStatus(req.auth!));
});

biRouter.post("/bi/ask", async (req, res) => {
  const body = parseOrThrow(askBody, req.body);
  sendData(res, await askQuestion(req.auth!, body));
});
