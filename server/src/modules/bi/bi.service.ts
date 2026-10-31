import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthContext } from "../auth/auth.context.js";
import { buildWorkbook } from "../excel/workbook.js";
import { fetchAnalytics } from "./bi.client.js";

/**
 * Phân quyền và lọc số liệu của Bảng điều hành, dùng chung cho route `/bi/*`
 * và tool của AI Agent (Phase 4, quyết định D14). Một chỗ duy nhất quyết định
 * ai được thấy gì: người chỉ xem CH03 hay không có `report.inventory` bị giới
 * hạn y như nhau dù bấm trên giao diện hay hỏi Agent.
 *
 * - Được xem báo cáo ở MỌI cửa hàng: xem toàn chuỗi (ALL), cơ cấu, lỗi dữ liệu.
 * - Chỉ được xem vài cửa hàng: chỉ số của đúng các cửa hàng đó, không thấy
 *   danh sách cửa hàng khác hay lỗi dữ liệu của cả tệp.
 * - Tồn kho, hạn dùng (có giá nhập) cần thêm `report.inventory` ở phạm vi đó
 *   (quyết định D8). Thiếu quyền này thì cảnh báo, xếp hạng sản phẩm, bất
 *   thường, dự báo được lọc bỏ phần tồn kho, còn tồn kho/hạn dùng trả 403.
 * - Vào Bảng điều hành: `report.sales`, `report.chain` hoặc `report.inventory` (D24: dược sĩ
 *   xem cửa hàng mình qua quyền tồn kho, không cần `report.sales`). Xếp hạng sản phẩm vẫn cần
 *   `report.sales`/`report.chain` (D8).
 * - Lợi nhuận, giá vốn, biên lợi nhuận cần `stock.cost.read` ở phạm vi xem (D23); thiếu thì
 *   các trường này bị bỏ trước khi trả về, kể cả cho tool của Agent.
 * - Hỏi AI cần `report.ai` (D25).
 */

export type BiAccess = {
  /** Được xem số liệu gộp toàn chuỗi và mọi cửa hàng. */
  allStores: boolean;
  stores: Array<{ code: string; name: string }>;
  /** Có `report.inventory` ở mọi cửa hàng: xem tồn kho toàn chuỗi. */
  inventoryAll: boolean;
  /** Mã các cửa hàng được xem tồn kho, hạn dùng. */
  inventoryStores: string[];
  /** Có `stock.cost.read` ở mọi cửa hàng được xem: thấy lợi nhuận toàn chuỗi (D23). */
  costAll: boolean;
  /** Mã các cửa hàng được xem lợi nhuận, giá vốn. */
  costStores: string[];
  /** Mã các cửa hàng được xem xếp hạng sản phẩm (`report.sales`/`report.chain`, D8). */
  salesStores: string[];
  /** Được hỏi trợ lý AI (`report.ai`, D25). */
  canAsk: boolean;
};

export async function biAccess(auth: AuthContext): Promise<BiAccess> {
  const active = await prisma.store.findMany({
    where: { isActive: true },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  const has = (store: { id: string }, code: string) => auth.permissionsForStore(store.id).has(code);
  const allowed = active.filter((store) =>
    ["report.sales", "report.chain", "report.inventory"].some((code) => has(store, code)),
  );
  const inventory = allowed.filter((store) => has(store, "report.inventory"));
  const cost = allowed.filter((store) => has(store, "stock.cost.read"));
  const sales = allowed.filter((store) => has(store, "report.sales") || has(store, "report.chain"));
  const every = (subset: unknown[]) => subset.length > 0 && subset.length === active.length;
  return {
    allStores: every(allowed),
    stores: allowed.map(({ code, name }) => ({ code, name })),
    inventoryAll: every(inventory),
    inventoryStores: inventory.map((store) => store.code),
    costAll: every(cost),
    costStores: cost.map((store) => store.code),
    salesStores: sales.map((store) => store.code),
    canAsk: allowed.some((store) => has(store, "report.ai")),
  };
}

/** Phạm vi (ALL hoặc mã cửa hàng, đã qua resolveStore) có được xem tồn kho không. */
export function canSeeInventory(access: BiAccess, store: string): boolean {
  if (access.inventoryAll) return true;
  return store !== "ALL" && access.inventoryStores.includes(store);
}

/** Phạm vi đang xem có được thấy lợi nhuận, giá vốn, biên lợi nhuận không (D23). */
export function canSeeCost(access: BiAccess, store: string): boolean {
  if (access.costAll) return true;
  return store !== "ALL" && access.costStores.includes(store);
}

/** Xếp hạng sản phẩm: cần report.sales/report.chain ở phạm vi xem (D8). */
function requireSales(access: BiAccess, store: string): void {
  const ok =
    store === "ALL"
      ? access.allStores && access.salesStores.length === access.stores.length
      : access.salesStores.includes(store);
  if (!ok) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Xếp hạng sản phẩm cần quyền báo cáo bán hàng (report.sales)",
    );
  }
}

/** Trường lộ giá vốn (D23). `low_profit` là danh sách xếp theo biên lợi nhuận thấp. */
const COST_KEYS = new Set([
  "profit",
  "cogs",
  "margin_pct",
  "cost_coverage_pct",
  "below_cost",
  "low_profit",
]);

/** Bỏ mọi trường lộ giá vốn ở mọi tầng (kỳ, tăng trưởng, điểm xu hướng, dòng cơ cấu, xếp hạng). */
export function stripCost<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) stripCost(item);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (COST_KEYS.has(key)) delete record[key];
      else stripCost(record[key]);
    }
  }
  return value;
}

function requireInventory(access: BiAccess, store: string): void {
  if (!canSeeInventory(access, store)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      store === "ALL"
        ? "Bạn không được xem tồn kho toàn chuỗi (cần quyền report.inventory ở mọi cửa hàng)"
        : `Bạn không được xem tồn kho cửa hàng ${store} (cần quyền report.inventory)`,
    );
  }
}

/** Chọn cửa hàng được phép; bỏ trống thì toàn chuỗi, hoặc cửa hàng đầu tiên được xem. */
export function resolveStore(access: BiAccess, requested: string | undefined): string {
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

type Json = Record<string, unknown>;
type Period = "day" | "week" | "month";

// --- Từng mục số liệu, đã lọc theo quyền --------------------------------------------------

export async function getSummary(access: BiAccess, query: { store?: string }) {
  const store = resolveStore(access, query.store);
  const summary = await fetchAnalytics<
    Json & { stores: string[]; data_quality: unknown; overview?: unknown }
  >("summary", { store });
  // Số tồn kho, hạn dùng và số cảnh báo (gồm cảnh báo tồn kho) chỉ cho người có quyền tồn kho.
  if (!canSeeInventory(access, store)) summary.overview = null;
  if (!access.allStores) {
    const allowed = new Set(access.stores.map((item) => item.code));
    summary.stores = summary.stores.filter((code) => allowed.has(code));
    // Thống kê lỗi tính trên cả tệp, gồm dòng của cửa hàng khác.
    summary.data_quality = null;
  }
  return canSeeCost(access, store) ? summary : stripCost(summary);
}

export async function getPeriodView(
  access: BiAccess,
  view: "revenue" | "profit",
  query: { store?: string; period?: Period },
) {
  const store = resolveStore(access, query.store);
  if (view === "profit" && !canSeeCost(access, store)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Bạn không được xem lợi nhuận, giá vốn (cần stock.cost.read)",
    );
  }
  const body = await fetchAnalytics<Json>(view, { store, period: query.period });
  return canSeeCost(access, store) ? body : stripCost(body);
}

export async function getSalesTrend(
  access: BiAccess,
  query: { store?: string; grain: Period; start?: string; end?: string },
) {
  const store = resolveStore(access, query.store);
  const body = await fetchAnalytics<Json & { points: Json[] }>("sales-trend", { ...query, store });
  return canSeeCost(access, store) ? body : stripCost(body);
}

export async function getBreakdown(access: BiAccess, query: { by: string }) {
  requireAllStores(access);
  const body = await fetchAnalytics<Json & { rows: Json[] }>("breakdown", query);
  return access.costAll ? body : stripCost(body);
}

export async function getDataQuality(access: BiAccess, query: { limit: number }) {
  requireAllStores(access);
  const body = await fetchAnalytics<Json>("data-quality", query);
  return access.costAll ? body : stripCost(body);
}

type StockRow = Json;

export async function getProducts(access: BiAccess, query: { store?: string; period: Period }) {
  const store = resolveStore(access, query.store);
  requireSales(access, store);
  const products = await fetchAnalytics<
    Json & { stock: Json & { slow: StockRow[]; not_sold: StockRow[] } }
  >("products", { store, period: query.period });
  if (!canSeeInventory(access, store)) {
    // Bán chậm, không bán được vẫn xem được; số tồn và tiền vốn (theo giá nhập) thì không.
    for (const row of [...products.stock.slow, ...products.stock.not_sold]) {
      delete row["stock_quantity"];
      delete row["stock_value"];
    }
  }
  return canSeeCost(access, store) ? products : stripCost(products);
}

export async function getInventory(access: BiAccess, query: { store?: string; status?: string }) {
  const store = resolveStore(access, query.store);
  requireInventory(access, store);
  return fetchAnalytics<Json>("inventory", { store, status: query.status });
}

export async function getExpiry(access: BiAccess, query: { store?: string; level?: string }) {
  const store = resolveStore(access, query.store);
  requireInventory(access, store);
  return fetchAnalytics<Json>("expiry", { store, level: query.level });
}

export async function getAlerts(access: BiAccess, query: { store?: string }) {
  const store = resolveStore(access, query.store);
  const body = await fetchAnalytics<Json & { alerts: Array<{ section: string }> }>("alerts", {
    store,
  });
  if (!canSeeInventory(access, store)) {
    body.alerts = body.alerts.filter((alert) => !["inventory", "expiry"].includes(alert.section));
  }
  return body;
}

export async function getAnomalies(
  access: BiAccess,
  query: { store?: string; days: number; direction?: "down" | "up" },
) {
  const store = resolveStore(access, query.store);
  const body = await fetchAnalytics<Json & { events: Array<{ kind: string }> }>("anomalies", {
    ...query,
    store,
  });
  // "Tồn tăng bất thường" là số tồn kho: chỉ cho người có report.inventory.
  if (!canSeeInventory(access, store)) {
    body.events = body.events.filter((event) => event.kind !== "stock_jump");
  }
  return body;
}

export async function getForecast(
  access: BiAccess,
  query: { store?: string; target: "revenue" | "demand" },
) {
  const store = resolveStore(access, query.store);
  const body = await fetchAnalytics<Json & { stockout?: unknown[] }>("forecast", {
    store,
    target: query.target,
  });
  // Nhu cầu dự báo tính từ bán hàng: report.sales là đủ. Ngày hết hàng dựa trên tồn kho: cần report.inventory.
  if (!canSeeInventory(access, store) && body.stockout) body.stockout = [];
  return body;
}

// --- Phase 5: ABC–XYZ, gợi ý đặt hàng, chuyển hàng ------------------------------------------

/** Phân loại ABC–XYZ: doanh thu và nhu cầu bán, không có số tồn: report.sales là đủ. */
export async function getClassification(
  access: BiAccess,
  query: { store?: string; abc?: "A" | "B" | "C"; xyz?: "X" | "Y" | "Z" },
) {
  return fetchAnalytics<Json>("classification", {
    ...query,
    store: resolveStore(access, query.store),
  });
}

type Move = Json & { from_store: string; to_store: string };
type ReorderItem = Json & { transfers?: Array<{ from_store: string }> };
export type ReorderPlan = Json & {
  available: boolean;
  items: ReorderItem[];
  transfers?: Move[];
};

/** Mã thay cho cửa hàng mà người xem không được xem tồn kho. */
export const HIDDEN_STORE = "Cửa hàng khác";

/**
 * Gợi ý đặt hàng: có số tồn, giá nhập nên cần report.inventory ở phạm vi xem (D8).
 * Chuyến chuyển hàng nhắc tới cửa hàng mà người xem không được xem tồn kho thì
 * thay mã cửa hàng đó bằng "Cửa hàng khác": vẫn biết là chuyển được, không lộ
 * cửa hàng nào đang thừa bao nhiêu.
 */
export async function getReorder(
  access: BiAccess,
  query: { store?: string; action?: "order" | "transfer" },
) {
  const store = resolveStore(access, query.store);
  requireInventory(access, store);
  const plan = await fetchAnalytics<ReorderPlan>("reorder", { ...query, store });
  if (access.inventoryAll) return plan;
  const visible = (code: string) => access.inventoryStores.includes(code);
  const mask = (code: string) => (visible(code) ? code : HIDDEN_STORE);
  for (const item of plan.items) {
    for (const move of item.transfers ?? []) move.from_store = mask(move.from_store);
  }
  for (const move of plan.transfers ?? []) {
    move.from_store = mask(move.from_store);
    move.to_store = mask(move.to_store);
  }
  return plan;
}

const REASON_TEXT: Record<string, string> = {
  out_of_stock: "Hết hàng",
  stockout_before_arrival: "Hết trước khi hàng về",
  below_min: "Dưới tồn tối thiểu",
  reorder: "Bổ sung cho kỳ tới",
};

/** Excel gợi ý đặt hàng: sheet "Mua" (xếp theo nhà cung cấp) và sheet "Chuyển hàng". */
export async function reorderWorkbook(plan: ReorderPlan): Promise<Buffer> {
  const buying = plan.items
    .filter((item) => Number(item["order_quantity"]) > 0)
    .sort((a, b) => String(a["supplier"] ?? "~").localeCompare(String(b["supplier"] ?? "~"), "vi"));
  return buildWorkbook([
    {
      name: "Mua",
      columns: [
        { key: "supplier", header: "Nhà cung cấp", width: 24 },
        { key: "store_code", header: "Cửa hàng", width: 10 },
        { key: "medicine_code", header: "Mã thuốc", width: 12 },
        { key: "medicine_name", header: "Tên thuốc", width: 32 },
        { key: "order_quantity", header: "Số lượng", kind: "int" },
        { key: "unit", header: "Đơn vị", width: 10 },
        { key: "order_packs", header: "Số đơn vị đặt", kind: "int" },
        { key: "pack_size", header: "Quy cách", kind: "int" },
        { key: "unit_cost", header: "Giá nhập", kind: "money" },
        { key: "order_value", header: "Thành tiền", kind: "money" },
        { key: "reason", header: "Lý do", width: 22 },
        { key: "days_until_stockout", header: "Hết sau (ngày)", kind: "int" },
        { key: "cell", header: "Nhóm ABC–XYZ", width: 12 },
      ],
      rows: buying.map((item) => ({
        ...item,
        supplier: item["supplier"] ?? "Chưa rõ",
        reason: REASON_TEXT[String(item["reason"])] ?? item["reason"],
      })),
    },
    {
      name: "Chuyển hàng",
      columns: [
        { key: "from_store", header: "Từ cửa hàng", width: 14 },
        { key: "to_store", header: "Đến cửa hàng", width: 14 },
        { key: "medicine_code", header: "Mã thuốc", width: 12 },
        { key: "medicine_name", header: "Tên thuốc", width: 32 },
        { key: "quantity", header: "Số lượng", kind: "int" },
        { key: "unit", header: "Đơn vị", width: 10 },
        { key: "value", header: "Giá trị (giá nhập)", kind: "money" },
      ],
      rows: plan.transfers ?? [],
    },
  ]);
}
