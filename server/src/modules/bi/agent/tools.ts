import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AppError } from "../../../lib/app-error.js";
import {
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
  type BiAccess,
} from "../bi.service.js";

/**
 * Lớp tool của AI Agent (Phase 4, bước 4.1; master prompt §21).
 *
 * Mỗi tool gọi đúng một hàm của bi.service.ts, tức đúng đường mà Bảng điều hành
 * dùng: cùng phân quyền theo cửa hàng và `report.inventory` (quyết định D14).
 * Không có tool ghi, không có tool SQL: Agent chỉ đọc được số analytics-service
 * đã tính sẵn. Kết quả được cắt gọn (top N dòng, trường cần thiết) để mỗi lần
 * gọi tốn vài trăm token, và luôn kèm thời điểm số liệu (`as_of`).
 *
 * Tham số khai báo MỘT lần bằng Zod: vừa sinh JSON Schema gửi cho Claude
 * (chế độ `strict`), vừa kiểm tra lại đầu vào ở server trước khi chạy.
 */

type Json = Record<string, unknown>;

export type AgentTool = {
  name: string;
  description: string;
  input: z.ZodObject;
  run: (access: BiAccess, input: never) => Promise<Json>;
};

/** Số dòng tối đa mỗi danh sách trả cho Agent. */
const TOP = 10;

const storeParam = z
  .string()
  .max(20)
  .regex(/^[A-Za-z0-9_-]+$/)
  .describe(
    "Mã cửa hàng (ví dụ CH01) hoặc ALL cho toàn chuỗi. Câu hỏi không nêu cửa hàng thì dùng phạm vi người dùng đang xem.",
  );
const periodParam = z
  .enum(["day", "week", "month"])
  .describe("Kỳ: day = hôm nay, week = tuần này (từ thứ Hai), month = tháng này");

function pick(row: unknown, fields: readonly string[]): Json {
  const source = (row ?? {}) as Json;
  return Object.fromEntries(
    fields.filter((field) => field in source).map((field) => [field, source[field]]),
  );
}

function top(rows: unknown, fields: readonly string[], limit = TOP): Json[] {
  return ((rows as unknown[] | undefined) ?? []).slice(0, limit).map((row) => pick(row, fields));
}

const PERIOD_FIELDS = [
  "label",
  "previous_label",
  "current",
  "previous_same_span",
  "growth",
] as const;
const PRODUCT_FIELDS = [
  "medicine_code",
  "medicine_name",
  "category",
  "revenue",
  "profit",
  "margin_pct",
  "units",
  "orders",
  "previous_revenue",
  "growth_pct",
] as const;
const STOCK_FIELDS = [
  "store_code",
  "medicine_code",
  "medicine_name",
  "status",
  "stock_quantity",
  "unit",
  "ads",
  "days_of_cover",
  "stock_value",
  "last_sale",
  "days_since_sale",
] as const;
const LOT_FIELDS = [
  "store_code",
  "medicine_code",
  "medicine_name",
  "batch_code",
  "expiry_date",
  "days_left",
  "level",
  "quantity",
  "value",
  "fefo_rank",
  "sellable_before_expiry",
  "at_risk_quantity",
  "at_risk_value",
] as const;

function unavailable(what: string): Json {
  return {
    available: false,
    message: `Hệ thống phân tích chưa có dữ liệu ${what}. Không có số liệu để trả lời; đừng ước đoán.`,
  };
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "get_business_summary",
    description:
      "Tổng quan kinh doanh: doanh thu, lợi nhuận, biên, số đơn, giá trị đơn của hôm nay / tuần này / tháng này, kèm tăng trưởng so với kỳ trước CÙNG THỜI ĐIỂM, và (nếu có quyền) tổng quan tồn kho, số cảnh báo. Dùng cho câu hỏi chung 'tình hình kinh doanh thế nào'.",
    input: z.object({ store: storeParam }),
    run: async (access, input: { store: string }) => {
      const data = await getSummary(access, input);
      const periods = data["periods"] as Record<string, Json>;
      return {
        as_of: data["as_of"],
        store: data["store"],
        stores: data["stores"],
        periods: Object.fromEntries(
          Object.entries(periods).map(([key, period]) => [key, pick(period, PERIOD_FIELDS)]),
        ),
        inventory_overview: data["overview"] ?? null,
      };
    },
  },
  {
    name: "get_revenue",
    description:
      "Doanh thu, số đơn, số lượng bán, giá trị đơn trung bình của một kỳ, so với kỳ trước cùng thời điểm (growth là %).",
    input: z.object({ store: storeParam, period: periodParam }),
    run: async (access, input: { store: string; period: "day" | "week" | "month" }) =>
      pick(await getPeriodView(access, "revenue", input), [
        "as_of",
        "store",
        "period",
        ...PERIOD_FIELDS,
      ]),
  },
  {
    name: "get_profit",
    description:
      "Giá vốn, lợi nhuận gộp, biên lợi nhuận của một kỳ, so với kỳ trước cùng thời điểm. cost_coverage_pct < 100 nghĩa là một phần doanh thu chưa có giá vốn.",
    input: z.object({ store: storeParam, period: periodParam }),
    run: async (access, input: { store: string; period: "day" | "week" | "month" }) =>
      pick(await getPeriodView(access, "profit", input), [
        "as_of",
        "store",
        "period",
        ...PERIOD_FIELDS,
      ]),
  },
  {
    name: "get_sales_trend",
    description:
      "Chuỗi doanh thu, lợi nhuận, số đơn theo ngày (30 ngày gần nhất), theo tuần (12 tuần) hoặc theo tháng (12 tháng). partial = true là kỳ đang diễn ra, chưa đủ.",
    input: z.object({
      store: storeParam,
      grain: z.enum(["day", "week", "month"]).describe("Độ chi tiết của chuỗi"),
    }),
    run: async (access, input: { store: string; grain: "day" | "week" | "month" }) => {
      const data = await getSalesTrend(access, input);
      return {
        ...pick(data, ["as_of", "store", "grain", "start", "end"]),
        points: top(data.points, ["period_start", "revenue", "profit", "orders", "partial"], 40),
      };
    },
  },
  {
    name: "get_breakdown",
    description:
      "Cơ cấu doanh thu THÁNG NÀY của toàn chuỗi theo nhóm thuốc, cửa hàng, loại bán (lẻ/buôn) hoặc hình thức thanh toán; mỗi dòng có tỷ trọng %. Chỉ người xem được toàn chuỗi.",
    input: z.object({
      by: z.enum(["category", "store", "sale_type", "payment_method"]).describe("Chia theo"),
    }),
    run: async (access, input: { by: string }) => {
      const data = await getBreakdown(access, input);
      return {
        ...pick(data, ["as_of", "by", "window"]),
        rows: top(data.rows, ["label", "revenue", "profit", "margin_pct", "orders", "share_pct"]),
      };
    },
  },
  {
    name: "get_top_products",
    description:
      "Xếp hạng thuốc trong một kỳ: revenue = doanh thu cao nhất, profit = lợi nhuận cao nhất, low_profit = biên lợi nhuận thấp nhất, declining = giảm doanh thu mạnh nhất so với kỳ trước cùng thời điểm.",
    input: z.object({
      store: storeParam,
      period: periodParam,
      rank: z.enum(["revenue", "profit", "low_profit", "declining"]).describe("Cách xếp hạng"),
    }),
    run: async (
      access,
      input: { store: string; period: "day" | "week" | "month"; rank: string },
    ) => {
      const data = await getProducts(access, input);
      return {
        ...pick(data, ["as_of", "store", "label", "previous_label"]),
        rank: input.rank,
        products: top(data[input.rank], PRODUCT_FIELDS),
      };
    },
  },
  {
    name: "get_slow_products",
    description:
      "Thuốc còn tồn mà bán chậm (slow: có bán nhưng doanh thu 30 ngày thấp nhất) hoặc không bán được trong 30 ngày (not_sold, gồm cả chưa bán bao giờ). Số tồn, vốn đọng chỉ có khi người hỏi có quyền tồn kho.",
    input: z.object({
      store: storeParam,
      kind: z.enum(["slow", "not_sold"]).describe("Bán chậm hay không bán được"),
    }),
    run: async (access, input: { store: string; kind: "slow" | "not_sold" }) => {
      const data = await getProducts(access, { store: input.store, period: "month" });
      const stock = data.stock;
      return {
        ...pick(data, ["as_of", "store"]),
        kind: input.kind,
        basis: stock["basis"],
        total_not_sold: stock["not_sold_total"],
        products: top(stock[input.kind], [
          ...PRODUCT_FIELDS,
          "stock_quantity",
          "stock_value",
          "last_sale",
          "days_since_sale",
        ]),
      };
    },
  },
  {
    name: "get_inventory",
    description:
      "Tình trạng tồn kho theo thuốc ở từng cửa hàng: tồn bán được (lô còn hạn), bán trung bình/ngày 30 ngày qua (ads), số ngày đủ bán (days_of_cover), giá trị theo giá nhập, trạng thái. Lọc theo trạng thái hoặc all. Cần quyền xem tồn kho.",
    input: z.object({
      store: storeParam,
      status: z
        .enum(["all", "out_of_stock", "low", "dead", "high", "normal"])
        .describe("out_of_stock = hết hàng, low = sắp hết, dead = tồn chết, high = tồn cao"),
    }),
    run: async (access, input: { store: string; status: string }) => {
      const data = await getInventory(access, {
        store: input.store,
        status: input.status === "all" ? undefined : input.status,
      });
      if (data["available"] === false) return unavailable("tồn kho (chưa có tệp inventory)");
      const items = (data["items"] as unknown[]) ?? [];
      return {
        ...pick(data, [
          "as_of",
          "store",
          "stock_as_of",
          "total_stock_value",
          "summary",
          "thresholds",
        ]),
        items_total: items.length,
        items: top(items, STOCK_FIELDS, 15),
      };
    },
  },
  {
    name: "get_low_stock",
    description:
      "Thuốc hết hàng (vẫn có khách mua trong 30 ngày) và sắp hết (dưới 7 ngày bán hoặc dưới tồn tối thiểu). Ngày dự kiến hết theo dự báo: dùng get_forecast với target demand. Cần quyền xem tồn kho.",
    input: z.object({ store: storeParam }),
    run: async (access, input: { store: string }) => {
      const data = await getInventory(access, { store: input.store });
      if (data["available"] === false) return unavailable("tồn kho (chưa có tệp inventory)");
      const items = ((data["items"] as Json[]) ?? []).filter((item) =>
        ["out_of_stock", "low"].includes(String(item["status"])),
      );
      return {
        ...pick(data, ["as_of", "store", "stock_as_of"]),
        items_total: items.length,
        items: top(items, STOCK_FIELDS, 15),
      };
    },
  },
  {
    name: "get_expiring_products",
    description:
      "Lô thuốc sắp hết hạn. at_risk = lô dự kiến KHÔNG bán kịp trước hạn theo FEFO (kèm số lượng, tiền có thể mất); next_30_days = lô hết hạn trong 30 ngày; next_90_days = trong 90 ngày. Cần quyền xem tồn kho.",
    input: z.object({
      store: storeParam,
      scope: z.enum(["at_risk", "next_30_days", "next_90_days"]).describe("Phạm vi lô"),
    }),
    run: async (access, input: { store: string; scope: string }) => {
      const data = await getExpiry(access, { store: input.store });
      if (data["available"] === false) return unavailable("tồn kho (chưa có tệp inventory)");
      const levels: Record<string, string[]> = {
        next_30_days: ["critical", "warning"],
        next_90_days: ["critical", "warning", "monitor"],
      };
      const lots =
        input.scope === "at_risk"
          ? ((data["risk_lots"] as Json[]) ?? [])
          : ((data["lots"] as Json[]) ?? []).filter((lot) =>
              levels[input.scope]!.includes(String(lot["level"])),
            );
      return {
        ...pick(data, ["as_of", "store", "levels", "at_risk", "rate_source"]),
        scope: input.scope,
        lots_total: lots.length,
        lots: top(lots, LOT_FIELDS, 15),
      };
    },
  },
  {
    name: "get_expired_products",
    description:
      "Lô ĐÃ hết hạn nhưng vẫn còn trong kho (theo GPP phải tách khỏi khu bán), kèm số lượng và giá trị. Cần quyền xem tồn kho.",
    input: z.object({ store: storeParam }),
    run: async (access, input: { store: string }) => {
      const data = await getExpiry(access, { store: input.store, level: "expired" });
      if (data["available"] === false) return unavailable("tồn kho (chưa có tệp inventory)");
      const lots = (data["lots"] as Json[]) ?? [];
      return {
        ...pick(data, ["as_of", "store"]),
        lots_total: lots.length,
        lots: top(lots, LOT_FIELDS, 15),
      };
    },
  },
  {
    name: "get_anomalies",
    description:
      "Bất thường đã phát hiện (luật + Z-score, so cùng thứ các tuần trước, chỉ tính bán lẻ): doanh thu tụt/tăng vọt, thuốc bán tụt/tăng vọt, tồn tăng bất thường. Mỗi mục là một đợt, có ngày, mức lệch, câu mô tả. Dùng khi hỏi 'vì sao doanh thu giảm', 'có gì bất thường'.",
    input: z.object({
      store: storeParam,
      days: z
        .number()
        .int()
        .min(1)
        .max(60)
        .describe("Xét các đợt kết thúc trong ngần này ngày gần nhất (1–60)"),
    }),
    run: async (access, input: { store: string; days: number }) => {
      const data = await getAnomalies(access, input);
      return {
        ...pick(data, ["as_of", "store", "since"]),
        events: top(
          data.events,
          [
            "kind",
            "direction",
            "store_code",
            "medicine_name",
            "start",
            "end",
            "actual",
            "expected",
            "change_pct",
            "message",
            "methods",
          ],
          15,
        ),
      };
    },
  },
  {
    name: "get_forecast",
    description:
      "Dự báo do hệ thống tính (không phải bạn tính): revenue = doanh thu từng ngày tới kèm khoảng tin cậy ~80% và sai số backtest (wape); demand = nhu cầu 7/30 ngày tới của từng thuốc và ngày dự kiến hết hàng (ngày hết hàng cần quyền tồn kho).",
    input: z.object({
      store: storeParam,
      target: z.enum(["revenue", "demand"]).describe("Dự báo doanh thu hay nhu cầu thuốc"),
    }),
    run: async (access, input: { store: string; target: "revenue" | "demand" }) => {
      const data = await getForecast(access, input);
      const base = pick(data, ["as_of", "store", "data_through"]);
      if (input.target === "revenue") {
        const revenue = (data["revenue"] ?? {}) as Json;
        if (revenue["status"] !== "ok") return { ...base, ...revenue };
        return {
          ...base,
          ...pick(revenue, [
            "model_label",
            "wape",
            "accuracy_measured",
            "change_vs_last_7_pct",
            "wholesale_per_day",
          ]),
          note: "wape là sai số khi thử dự báo lại 4 tuần qua (phần bán lẻ); change_vs_last_7_pct so bán lẻ 7 ngày tới với 7 ngày qua.",
          next_7_days_total: ((revenue["points"] as Json[]) ?? [])
            .slice(0, 7)
            .reduce((sum, point) => sum + Number(point["value"]), 0),
          points: top(revenue["points"], ["date", "value", "low", "high"], 14),
        };
      }
      const demand = [...((data["demand"] as Json[]) ?? [])].sort(
        (left, right) => Number(right["next_7_days"]) - Number(left["next_7_days"]),
      );
      const stockout = ((data["stockout"] as Json[]) ?? []).filter(
        (row) => row["days_until_stockout"] !== null,
      );
      return {
        ...base,
        demand_total: demand.length,
        demand: top(demand, [
          "store_code",
          "medicine_code",
          "medicine_name",
          "next_7_days",
          "next_7_low",
          "next_7_high",
          "next_30_days",
          "change_vs_last_7_pct",
          "wape_total",
        ]),
        stockout_within_30_days: top(stockout, [
          "store_code",
          "medicine_name",
          "stock_quantity",
          "stockout_date",
          "days_until_stockout",
        ]),
      };
    },
  },
  {
    name: "get_data_quality",
    description:
      "Chất lượng dữ liệu của lần đọc tệp gần nhất: số dòng hợp lệ, số dòng bị loại theo loại lỗi. Dùng để nói rõ khi số liệu có thể thiếu. Chỉ người xem được toàn chuỗi.",
    input: z.object({}),
    run: async (access) => {
      const data = await getDataQuality(access, { limit: 1 });
      return pick(data, ["as_of", "checked_at", "summary", "total"]);
    },
  },
  {
    name: "get_reorder_suggestions",
    description:
      "Gợi ý đặt hàng theo dự báo (Phase 5): mỗi thuốc ở mỗi cửa hàng cần thêm bao nhiêu để đủ bán thời gian chờ hàng + 7 ngày, đã cộng tồn an toàn theo nhóm ABC–XYZ và trừ lô sắp hết hạn; chuyển từ cửa hàng đang thừa trước, phần còn thiếu mới mua. Kèm lý do, nhà cung cấp, tiền mua theo giá nhập, các chuyến chuyển hàng. action: all = mọi dòng, order = chỉ dòng phải mua, transfer = chỉ dòng có chuyển. Cần quyền xem tồn kho.",
    input: z.object({
      store: storeParam,
      action: z.enum(["all", "order", "transfer"]).describe("Lọc dòng"),
    }),
    run: async (access, input: { store: string; action: "all" | "order" | "transfer" }) => {
      const data = await getReorder(access, {
        store: input.store,
        ...(input.action === "all" ? {} : { action: input.action }),
      });
      if (data["available"] === false) return unavailable("gợi ý đặt hàng (chưa có tệp inventory)");
      return {
        ...pick(data, [
          "as_of",
          "store",
          "cover_days",
          "lines",
          "order_lines",
          "order_value",
          "transfer_lines",
          "transfer_value",
          "by_supplier",
        ]),
        items: top(
          data.items,
          [
            "store_code",
            "medicine_code",
            "medicine_name",
            "unit",
            "cell",
            "reason",
            "usable_quantity",
            "target_quantity",
            "transfer_quantity",
            "order_quantity",
            "order_value",
            "supplier",
            "days_until_stockout",
          ],
          15,
        ),
        transfers: top(
          data.transfers,
          ["from_store", "to_store", "medicine_name", "quantity", "unit", "value"],
          15,
        ),
      };
    },
  },
  {
    name: "get_abc_analysis",
    description:
      "Phân loại ABC–XYZ 90 ngày: A = nhóm thuốc làm ra ~80% doanh thu, B ~15%, C ~5%; X = nhu cầu tuần ổn định (CV ≤ 0,5), Y = dao động, Z = thất thường. Trả tóm tắt từng nhóm, ma trận 9 ô (số thuốc, mức phục vụ dùng cho tồn an toàn) và danh sách thuốc (lọc theo nhóm nếu cần).",
    input: z.object({
      store: storeParam,
      group: z.enum(["all", "A", "B", "C"]).describe("Nhóm ABC cần liệt kê thuốc"),
    }),
    run: async (access, input: { store: string; group: "all" | "A" | "B" | "C" }) => {
      const data = await getClassification(access, {
        store: input.store,
        ...(input.group === "all" ? {} : { abc: input.group }),
      });
      return {
        ...pick(data, [
          "as_of",
          "store",
          "window",
          "total_revenue",
          "summary",
          "matrix",
          "unclassified_xyz",
        ]),
        items: top(
          data["items"],
          [
            "medicine_code",
            "medicine_name",
            "revenue",
            "share_pct",
            "cumulative_pct",
            "cell",
            "cv",
            "service_level",
          ],
          15,
        ),
      };
    },
  },
  {
    name: "get_customer_debt",
    description: "Công nợ khách hàng. Hệ thống phân tích hiện CHƯA có nguồn dữ liệu này.",
    input: z.object({}),
    run: async () => unavailable("công nợ khách hàng"),
  },
  {
    name: "get_supplier_data",
    description:
      "Công nợ nhà cung cấp, lịch sử phiếu nhập. Hệ thống phân tích hiện CHƯA có nguồn dữ liệu này (nhà cung cấp thường đặt của từng thuốc: dùng get_reorder_suggestions).",
    input: z.object({}),
    run: async () => unavailable("nhà cung cấp và phiếu nhập"),
  },
];

const BY_NAME = new Map(AGENT_TOOLS.map((tool) => [tool.name, tool]));

/** Các từ khóa JSON Schema mà chế độ `strict` không nhận: bỏ khỏi bản gửi Claude, Zod vẫn kiểm ở server. */
const UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
]);

function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => !UNSUPPORTED_KEYWORDS.has(key))
      .map(([key, value]) => [key, strictSchema(value)]),
  );
}

/** Định nghĩa tool gửi Claude. Thứ tự cố định để phần tool luôn trùng nhau giữa các câu hỏi (prompt caching). */
export function toolDefinitions(): Anthropic.Tool[] {
  return AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: strictSchema(z.toJSONSchema(tool.input)) as Anthropic.Tool.InputSchema,
    strict: true,
  }));
}

export type ToolOutcome = {
  name: string;
  input: unknown;
  ok: boolean;
  /** Kết quả (ok) hoặc lỗi dạng { error }: đưa nguyên cho Claude làm tool_result. */
  content: Json;
  durationMs: number;
};

/**
 * Chạy một tool theo yêu cầu của Claude. Không bao giờ ném lỗi ra vòng lặp: tên
 * lạ, tham số sai, thiếu quyền, dịch vụ phân tích chưa chạy đều trả về
 * `{ ok: false, content: { error } }` để Claude đọc và giải thích cho người dùng.
 */
export async function runTool(
  access: BiAccess,
  name: string,
  rawInput: unknown,
): Promise<ToolOutcome> {
  const started = Date.now();
  const finish = (ok: boolean, content: Json): ToolOutcome => ({
    name,
    input: rawInput,
    ok,
    content,
    durationMs: Date.now() - started,
  });
  const tool = BY_NAME.get(name);
  if (!tool) return finish(false, { error: `Không có tool ${name}` });
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return finish(false, {
      error: "Tham số không hợp lệ",
      details: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(gốc)"}: ${issue.message}`,
      ),
    });
  }
  try {
    return finish(true, await tool.run(access, parsed.data as never));
  } catch (error) {
    if (error instanceof AppError) {
      // Thiếu quyền (403), chưa có số liệu (503), dịch vụ chưa chạy (502): nói đúng lý do.
      return finish(false, { error: error.message, code: error.code });
    }
    throw error;
  }
}
