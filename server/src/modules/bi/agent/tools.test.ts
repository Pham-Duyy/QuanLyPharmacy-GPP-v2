import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startAnalyticsStub, type AnalyticsStub } from "../../../test/analytics-stub-server.js";
import type { BiAccess } from "../bi.service.js";
import { AGENT_TOOLS, runTool, toolDefinitions } from "./tools.js";

/**
 * Lớp tool của AI Agent (bước 4.1): không gọi Claude, không cần CSDL. Quyền dựng
 * thẳng bằng đối tượng BiAccess; analytics-service là máy chủ giả.
 */

const CHAIN: BiAccess = {
  allStores: true,
  stores: [
    { code: "NT01", name: "Nhà thuốc 1" },
    { code: "NT02", name: "Nhà thuốc 2" },
  ],
  inventoryAll: true,
  inventoryStores: ["NT01", "NT02"],
};
/** Chỉ xem báo cáo NT01, không có quyền tồn kho. */
const NT01_SALES_ONLY: BiAccess = {
  allStores: false,
  stores: [{ code: "NT01", name: "Nhà thuốc 1" }],
  inventoryAll: false,
  inventoryStores: [],
};

const PERIOD = {
  label: "Tuần này",
  previous_label: "Tuần trước",
  current: { revenue: 22_000, orders: 2 },
  previous_same_span: { revenue: 6_000, orders: 1 },
  previous_full: { revenue: 9_000 },
  growth: { revenue: 266.7 },
  current_window: { start: "2026-10-26T00:00:00", end: "2026-10-29T12:00:00" },
};

const ITEMS = [
  {
    store_code: "NT01",
    medicine_code: "GD001",
    medicine_name: "Paracetamol",
    status: "out_of_stock",
    stock_quantity: 0,
    ads: 20,
  },
  {
    store_code: "NT01",
    medicine_code: "TM001",
    medicine_name: "Amlodipin",
    status: "low",
    stock_quantity: 50,
    ads: 10,
    days_of_cover: 5,
  },
  {
    store_code: "NT02",
    medicine_code: "VT004",
    medicine_name: "Omega-3",
    status: "high",
    stock_quantity: 9_000,
    ads: 40,
  },
];
const LOTS = [
  {
    store_code: "NT01",
    medicine_name: "Metronidazol",
    batch_code: "L0",
    level: "expired",
    days_left: -5,
    quantity: 73,
  },
  {
    store_code: "NT02",
    medicine_name: "Siro Prospan",
    batch_code: "L1",
    level: "critical",
    days_left: 5,
    quantity: 92,
  },
  {
    store_code: "NT01",
    medicine_name: "Acetylcystein",
    batch_code: "L2",
    level: "warning",
    days_left: 20,
    quantity: 1_700,
  },
  {
    store_code: "NT01",
    medicine_name: "Vitamin C",
    batch_code: "L3",
    level: "monitor",
    days_left: 60,
    quantity: 300,
  },
];

let stub: AnalyticsStub;

beforeAll(async () => {
  stub = await startAnalyticsStub({
    summary: {
      version: 9,
      as_of: "2026-10-29T12:00:00",
      store: "ALL",
      stores: ["NT01", "NT02"],
      periods: { day: PERIOD, week: PERIOD, month: PERIOD },
      data_quality: { sales: { rows_rejected: 3 } },
      overview: { total_stock_value: 806_000_000 },
    },
    revenue: { version: 9, as_of: "2026-10-29T12:00:00", store: "ALL", period: "week", ...PERIOD },
    products: {
      version: 9,
      as_of: "2026-10-29T12:00:00",
      store: "NT01",
      label: "Tháng này",
      previous_label: "Tháng trước",
      revenue: Array.from({ length: 12 }, (_, index) => ({
        medicine_code: `M${index}`,
        medicine_name: `Thuốc ${index}`,
        revenue: 1_000 - index,
        orders: 5,
        secret_field: "không gửi",
      })),
      profit: [],
      low_profit: [],
      declining: [],
      stock: {
        basis: "inventory",
        not_sold_total: 1,
        slow: [
          {
            medicine_code: "TB010",
            medicine_name: "Máy xông",
            revenue: 0,
            stock_quantity: 3,
            stock_value: 1_950_000,
          },
        ],
        not_sold: [
          {
            medicine_code: "TB010",
            medicine_name: "Máy xông",
            stock_quantity: 3,
            stock_value: 1_950_000,
          },
        ],
      },
    },
    inventory: {
      version: 9,
      as_of: "2026-10-29T12:00:00",
      store: "ALL",
      available: true,
      stock_as_of: "2026-10-29T08:00:00",
      total_stock_value: 806_000_000,
      summary: { low: { count: 1 } },
      items: ITEMS,
    },
    expiry: {
      version: 9,
      as_of: "2026-10-29T12:00:00",
      store: "ALL",
      available: true,
      levels: {},
      at_risk: { lots: 1, value: 4_400_000 },
      rate_source: "forecast",
      lots: LOTS,
      risk_lots: [LOTS[1]],
    },
    anomalies: {
      version: 9,
      as_of: "2026-10-29T12:00:00",
      store: "ALL",
      since: "2026-10-15",
      events: [
        {
          kind: "revenue_drop_day",
          direction: "down",
          store_code: "NT01",
          start: "2026-10-20",
          end: "2026-10-20",
          change_pct: -79,
          message: "NT01 mất điện",
          short: "bỏ",
        },
      ],
    },
    forecast: {
      version: 9,
      as_of: "2026-10-29T12:00:00",
      store: "ALL",
      target: "revenue",
      data_through: "2026-10-28",
      revenue: {
        status: "ok",
        model_label: "Holt-Winters",
        wape: 0.09,
        accuracy_measured: true,
        change_vs_last_7_pct: 1.5,
        errors: [1, 2, 3],
        points: Array.from({ length: 30 }, (_, index) => ({
          date: `2026-11-${String(index + 1).padStart(2, "0")}`,
          value: 100,
          low: 80,
          high: 120,
        })),
      },
    },
  });
  process.env["ANALYTICS_SERVICE_URL"] = stub.baseUrl;
});

afterAll(async () => {
  delete process.env["ANALYTICS_SERVICE_URL"];
  await stub.close();
});

beforeEach(() => {
  stub.requests.length = 0;
});

describe("định nghĩa tool gửi Claude", () => {
  it("đủ tool của master prompt §21, tên không trùng, thứ tự cố định", () => {
    const names = toolDefinitions().map((tool) => tool.name);
    expect(names).toEqual([
      "get_business_summary",
      "get_revenue",
      "get_profit",
      "get_sales_trend",
      "get_breakdown",
      "get_top_products",
      "get_slow_products",
      "get_inventory",
      "get_low_stock",
      "get_expiring_products",
      "get_expired_products",
      "get_anomalies",
      "get_forecast",
      "get_data_quality",
      "get_customer_debt",
      "get_supplier_data",
    ]);
    expect(new Set(names).size).toBe(names.length);
    // Không tool nào ghi hay chạy truy vấn tùy ý.
    expect(names.some((name) => /sql|query|update|delete|create|set_/i.test(name))).toBe(false);
  });

  it("schema chặt: strict, không thừa trường, mọi tham số bắt buộc, không từ khóa strict không nhận", () => {
    for (const tool of toolDefinitions()) {
      const schema = tool.input_schema as Record<string, unknown>;
      expect(tool.strict, tool.name).toBe(true);
      expect(schema["additionalProperties"], tool.name).toBe(false);
      expect(Object.keys((schema["properties"] as object) ?? {}).sort(), tool.name).toEqual(
        [...((schema["required"] as string[]) ?? [])].sort(),
      );
      expect(JSON.stringify(schema), tool.name).not.toMatch(
        /"\$schema"|"pattern"|"maxLength"|"minimum"|"maximum"/,
      );
      expect(tool.description!.length, tool.name).toBeGreaterThan(30);
    }
  });

  it("định nghĩa giống hệt nhau giữa các lần gọi (để prompt caching trúng)", () => {
    expect(JSON.stringify(toolDefinitions())).toBe(JSON.stringify(toolDefinitions()));
  });
});

describe("chạy tool", () => {
  it("chuyển tiếp đúng tham số và cắt gọn kết quả", async () => {
    const outcome = await runTool(CHAIN, "get_revenue", { store: "ALL", period: "week" });
    expect(outcome.ok).toBe(true);
    expect(stub.requests).toEqual(["/api/analytics/revenue?store=ALL&period=week"]);
    expect(outcome.content).toEqual({
      as_of: "2026-10-29T12:00:00",
      store: "ALL",
      period: "week",
      label: "Tuần này",
      previous_label: "Tuần trước",
      current: { revenue: 22_000, orders: 2 },
      previous_same_span: { revenue: 6_000, orders: 1 },
      growth: { revenue: 266.7 },
    });
  });

  it("chỉ giữ top 10 dòng và trường cần thiết", async () => {
    const outcome = await runTool(CHAIN, "get_top_products", {
      store: "NT01",
      period: "month",
      rank: "revenue",
    });
    const products = outcome.content["products"] as Array<Record<string, unknown>>;
    expect(products).toHaveLength(10);
    expect(products[0]).toEqual({
      medicine_code: "M0",
      medicine_name: "Thuốc 0",
      revenue: 1_000,
      orders: 5,
    });
  });

  it("mã cửa hàng chữ thường vẫn nhận, và áp đúng quyền của Gateway", async () => {
    expect(
      (await runTool(NT01_SALES_ONLY, "get_revenue", { store: "nt01", period: "day" })).ok,
    ).toBe(true);
    expect(stub.requests.at(-1)).toBe("/api/analytics/revenue?store=NT01&period=day");

    const chain = await runTool(NT01_SALES_ONLY, "get_revenue", { store: "ALL", period: "day" });
    expect(chain).toMatchObject({ ok: false, content: { code: "FORBIDDEN" } });
    expect(String(chain.content["error"])).toContain("toàn chuỗi");

    const inventory = await runTool(NT01_SALES_ONLY, "get_inventory", {
      store: "NT01",
      status: "all",
    });
    expect(String(inventory.content["error"])).toContain("report.inventory");
    expect((await runTool(NT01_SALES_ONLY, "get_breakdown", { by: "category" })).ok).toBe(false);
  });

  it("không có quyền tồn kho: bán chậm vẫn xem được nhưng không có số tồn, vốn đọng", async () => {
    const outcome = await runTool(NT01_SALES_ONLY, "get_slow_products", {
      store: "NT01",
      kind: "not_sold",
    });
    expect(outcome.content["products"]).toEqual([
      { medicine_code: "TB010", medicine_name: "Máy xông" },
    ]);
    const full = await runTool(CHAIN, "get_slow_products", { store: "NT01", kind: "not_sold" });
    expect((full.content["products"] as Array<Record<string, unknown>>)[0]!["stock_value"]).toBe(
      1_950_000,
    );
  });

  it("tham số sai, tool lạ: trả lỗi để Claude đọc, không gọi analytics-service", async () => {
    const wrong = await runTool(CHAIN, "get_revenue", { store: "ALL", period: "year" });
    expect(wrong.ok).toBe(false);
    expect(wrong.content["error"]).toBe("Tham số không hợp lệ");
    const injection = await runTool(CHAIN, "get_revenue", {
      store: "ALL'; DROP TABLE",
      period: "day",
    });
    expect(injection.ok).toBe(false);
    expect((await runTool(CHAIN, "run_sql", { sql: "select 1" })).content).toEqual({
      error: "Không có tool run_sql",
    });
    expect((await runTool(CHAIN, "get_anomalies", { store: "ALL", days: 365 })).ok).toBe(false);
    expect(stub.requests).toEqual([]);
  });

  it("sắp hết hàng, sắp hết hạn: lọc đúng", async () => {
    const low = await runTool(CHAIN, "get_low_stock", { store: "ALL" });
    expect(
      (low.content["items"] as Array<Record<string, unknown>>).map((item) => item["medicine_code"]),
    ).toEqual(["GD001", "TM001"]);

    const soon = await runTool(CHAIN, "get_expiring_products", {
      store: "ALL",
      scope: "next_30_days",
    });
    expect(
      (soon.content["lots"] as Array<Record<string, unknown>>).map((lot) => lot["batch_code"]),
    ).toEqual(["L1", "L2"]);
    const risk = await runTool(CHAIN, "get_expiring_products", { store: "ALL", scope: "at_risk" });
    expect(risk.content["lots_total"]).toBe(1);

    const expired = await runTool(CHAIN, "get_expired_products", { store: "ALL" });
    expect(stub.requests.at(-1)).toBe("/api/analytics/expiry?store=ALL&level=expired");
    expect(expired.ok).toBe(true);
  });

  it("dự báo doanh thu: tổng 7 ngày do server cộng, bỏ sai số từng ngày, giữ 14 điểm", async () => {
    const outcome = await runTool(CHAIN, "get_forecast", { store: "ALL", target: "revenue" });
    expect(outcome.content).toMatchObject({
      model_label: "Holt-Winters",
      wape: 0.09,
      next_7_days_total: 700,
      data_through: "2026-10-28",
    });
    expect(outcome.content["points"]).toHaveLength(14);
    expect(JSON.stringify(outcome.content)).not.toContain("errors");
  });

  it("bất thường: giữ câu mô tả, bỏ trường chỉ dùng cho giao diện", async () => {
    const outcome = await runTool(CHAIN, "get_anomalies", { store: "ALL", days: 14 });
    expect(stub.requests.at(-1)).toBe("/api/analytics/anomalies?store=ALL&days=14");
    expect((outcome.content["events"] as Array<Record<string, unknown>>)[0]).toEqual({
      kind: "revenue_drop_day",
      direction: "down",
      store_code: "NT01",
      start: "2026-10-20",
      end: "2026-10-20",
      change_pct: -79,
      message: "NT01 mất điện",
    });
  });

  it("dữ liệu chưa có: nói rõ, không có số", async () => {
    const debt = await runTool(CHAIN, "get_customer_debt", {});
    expect(debt).toMatchObject({ ok: true, content: { available: false } });
    expect(String(debt.content["message"])).toContain("đừng ước đoán");
  });

  it("dịch vụ phân tích chưa chạy: lỗi rõ ràng, không làm hỏng vòng lặp", async () => {
    process.env["ANALYTICS_SERVICE_URL"] = "http://127.0.0.1:1";
    try {
      const outcome = await runTool(CHAIN, "get_revenue", { store: "ALL", period: "day" });
      expect(outcome).toMatchObject({ ok: false, content: { code: "ANALYTICS_UNAVAILABLE" } });
    } finally {
      process.env["ANALYTICS_SERVICE_URL"] = stub.baseUrl;
    }
  });

  it("mọi tool có thể chạy với tham số hợp lệ tối thiểu", async () => {
    const samples: Record<string, unknown> = {
      get_business_summary: { store: "ALL" },
      get_profit: { store: "ALL", period: "month" },
      get_sales_trend: { store: "ALL", grain: "day" },
      get_breakdown: { by: "store" },
      get_inventory: { store: "ALL", status: "all" },
      get_data_quality: {},
      get_supplier_data: {},
    };
    stub.respond("profit", 200, { as_of: "x", ...PERIOD });
    stub.respond("sales-trend", 200, { as_of: "x", points: [] });
    stub.respond("breakdown", 200, { as_of: "x", rows: [] });
    stub.respond("data-quality", 200, { as_of: "x", summary: {}, total: 0 });
    for (const [name, input] of Object.entries(samples)) {
      expect((await runTool(CHAIN, name, input)).ok, name).toBe(true);
    }
    expect(AGENT_TOOLS).toHaveLength(16);
  });
});
