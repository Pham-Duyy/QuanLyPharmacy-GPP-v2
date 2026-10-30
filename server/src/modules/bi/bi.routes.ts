import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { sendData } from "../../lib/respond.js";
import { parseOrThrow } from "../../lib/validate.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { requireAnyPermission } from "../../middlewares/require-permission.js";
import type { AuthContext } from "../auth/auth.context.js";
import { fetchAnalytics } from "./bi.client.js";

/**
 * Cổng Bảng điều hành (Phase 1, bước 1.7): giao diện → Node → analytics-service.
 *
 * Node giữ đăng nhập và phân quyền; analytics-service chỉ tính số, không biết
 * ai đang hỏi. Quy ước: `store_code` trong tệp dữ liệu trùng mã cửa hàng của
 * phần mềm, nhờ vậy quyền "xem báo cáo cửa hàng X" áp được lên số liệu từ tệp.
 *
 * - Được xem báo cáo ở MỌI cửa hàng: xem toàn chuỗi (ALL), cơ cấu, lỗi dữ liệu.
 * - Chỉ được xem vài cửa hàng: chỉ số của đúng các cửa hàng đó, không thấy
 *   danh sách cửa hàng khác hay lỗi dữ liệu của cả tệp.
 */
export const biRouter = Router();

biRouter.use("/bi", authenticate, requireAnyPermission("report.sales", "report.chain"));

export type BiAccess = {
  /** Được xem số liệu gộp toàn chuỗi và mọi cửa hàng. */
  allStores: boolean;
  stores: Array<{ code: string; name: string }>;
};

export async function biAccess(auth: AuthContext): Promise<BiAccess> {
  const active = await prisma.store.findMany({
    where: { isActive: true },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  const allowed = active.filter((store) => {
    const permissions = auth.permissionsForStore(store.id);
    return permissions.has("report.sales") || permissions.has("report.chain");
  });
  return {
    allStores: allowed.length > 0 && allowed.length === active.length,
    stores: allowed.map(({ code, name }) => ({ code, name })),
  };
}

/** Chọn cửa hàng được phép; bỏ trống thì toàn chuỗi, hoặc cửa hàng đầu tiên được xem. */
function resolveStore(access: BiAccess, requested: string | undefined): string {
  const code = requested?.toUpperCase();
  if (!code) {
    if (access.allStores) return "ALL";
    const first = access.stores[0];
    if (!first) throw new AppError(403, "FORBIDDEN", "Bạn chưa được xem báo cáo cửa hàng nào");
    return first.code;
  }
  if (code === "ALL") {
    if (!access.allStores)
      throw new AppError(403, "FORBIDDEN", "Bạn không được xem số liệu toàn chuỗi");
    return code;
  }
  // Người xem toàn chuỗi được hỏi cả mã chỉ có trong tệp, chưa có trong phần mềm.
  if (!access.allStores && !access.stores.some((store) => store.code === code)) {
    throw new AppError(403, "FORBIDDEN", `Bạn không được xem số liệu cửa hàng ${code}`);
  }
  return code;
}

function requireAllStores(access: BiAccess): void {
  if (!access.allStores) {
    throw new AppError(403, "FORBIDDEN", "Chỉ người xem được toàn chuỗi mới xem được mục này");
  }
}

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

type Summary = { stores: string[]; data_quality: unknown; [key: string]: unknown };

biRouter.get("/bi/summary", async (req, res) => {
  const query = parseOrThrow(summaryQuery, req.query);
  const access = await biAccess(req.auth!);
  const summary = await fetchAnalytics<Summary>("summary", {
    store: resolveStore(access, query.store),
  });
  if (!access.allStores) {
    const allowed = new Set(access.stores.map((store) => store.code));
    summary.stores = summary.stores.filter((code) => allowed.has(code));
    // Thống kê lỗi tính trên cả tệp, gồm dòng của cửa hàng khác.
    summary.data_quality = null;
  }
  sendData(res, summary);
});

for (const view of ["revenue", "profit"] as const) {
  biRouter.get(`/bi/${view}`, async (req, res) => {
    const query = parseOrThrow(periodQuery, req.query);
    const access = await biAccess(req.auth!);
    sendData(
      res,
      await fetchAnalytics(view, {
        store: resolveStore(access, query.store),
        period: query.period,
      }),
    );
  });
}

biRouter.get("/bi/sales-trend", async (req, res) => {
  const query = parseOrThrow(trendQuery, req.query);
  const access = await biAccess(req.auth!);
  sendData(
    res,
    await fetchAnalytics("sales-trend", { ...query, store: resolveStore(access, query.store) }),
  );
});

biRouter.get("/bi/breakdown", async (req, res) => {
  const query = parseOrThrow(breakdownQuery, req.query);
  requireAllStores(await biAccess(req.auth!));
  sendData(res, await fetchAnalytics("breakdown", query));
});

biRouter.get("/bi/data-quality", async (req, res) => {
  const query = parseOrThrow(qualityQuery, req.query);
  requireAllStores(await biAccess(req.auth!));
  sendData(res, await fetchAnalytics("data-quality", query));
});
