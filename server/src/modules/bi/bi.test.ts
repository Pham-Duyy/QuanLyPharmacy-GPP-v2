import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  useTestRole,
  type Fixture,
} from "../../test/helpers.js";
import { startAnalyticsStub, type AnalyticsStub } from "../../test/analytics-stub-server.js";

const SUMMARY = {
  version: 7,
  as_of: "2026-10-29T12:00:00+07:00",
  store: "ALL",
  stores: ["NT01", "NT02", "NT03"],
  periods: { day: { current: { revenue: 12_000 } } },
  data_quality: { sales: { rows_rejected: 12 } },
  overview: { total_stock_value: 806_000_000, low_stock: 2 },
};

const ALERTS = {
  version: 7,
  alerts: [
    { code: "expired_in_stock", severity: "critical", section: "expiry" },
    { code: "low", severity: "medium", section: "inventory" },
    { code: "revenue_drop", severity: "medium", section: "kpi" },
  ],
};

const productRow = () => ({ medicine_code: "TB010", stock_quantity: 3, stock_value: 1_950_000 });

const HEALTH = {
  status: "ok",
  snapshot: { version: 7, age_seconds: 4 },
  last_run: { id: 3, status: "failed", error_message: "C:\\data\\inbox\\sales.xlsx bị khóa" },
  monitor: { folder: "C:\\data\\inbox", events: 5, runs: 3, last_latency_ms: 4300 },
};

let stub: AnalyticsStub;
let fixture: Fixture;
let adminToken: string;

beforeAll(async () => {
  stub = await startAnalyticsStub({
    version: { version: 7, as_of: SUMMARY.as_of, created_at: SUMMARY.as_of },
    health: HEALTH,
    summary: SUMMARY,
    revenue: { version: 7, period: "week" },
    profit: { version: 7, period: "month" },
    "sales-trend": { version: 7, points: [] },
    breakdown: { version: 7, rows: [{ label: "Giảm đau", revenue: 18_000 }] },
    "data-quality": { version: 7, total: 12, issues: [] },
    inventory: { version: 7, available: true, items: [] },
    expiry: { version: 7, available: true, lots: [] },
    alerts: ALERTS,
    anomalies: {
      version: 7,
      events: [
        { kind: "revenue_drop_day", store_code: "NT01" },
        { kind: "stock_jump", store_code: "NT01" },
      ],
    },
    forecast: {
      version: 7,
      target: "demand",
      demand: [{ medicine_code: "GD001" }],
      stockout: [{ medicine_code: "GD001" }],
    },
  });
  process.env["ANALYTICS_SERVICE_URL"] = stub.baseUrl;
});

afterAll(async () => {
  delete process.env["ANALYTICS_SERVICE_URL"];
  await stub.close();
});

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
  stub.requests.length = 0;
});

/** Dược sĩ "duocsi" chỉ được xem báo cáo cửa hàng NT01. */
async function storeViewerToken(): Promise<string> {
  await useTestRole(fixture.pharmacistId, "auditor", fixture.storeId);
  return (await login("duocsi")).token;
}

const get = (path: string, token: string) =>
  api().get(`/api/v1/bi/${path}`).set(authHeaders(token));

describe("cổng Bảng điều hành /api/v1/bi", () => {
  it("người có quyền ở mọi cửa hàng xem được toàn chuỗi", async () => {
    const access = await get("access", adminToken);
    expect(access.status).toBe(200);
    expect(access.body.data).toEqual({
      allStores: true,
      stores: [
        { code: "NT01", name: "Nhà thuốc kiểm thử 1" },
        { code: "NT02", name: "Nhà thuốc kiểm thử 2" },
      ],
      inventoryAll: true,
      inventoryStores: ["NT01", "NT02"],
    });

    const summary = await get("summary", adminToken);
    expect(summary.status).toBe(200);
    expect(summary.body.data).toEqual(SUMMARY);
    expect(stub.requests).toEqual(["/api/analytics/summary?store=ALL"]);
  });

  it("người chỉ xem một cửa hàng: mặc định cửa hàng đó, không thấy cửa hàng khác", async () => {
    const token = await storeViewerToken();
    const access = await get("access", token);
    expect(access.body.data).toEqual({
      allStores: false,
      stores: [{ code: "NT01", name: "Nhà thuốc kiểm thử 1" }],
      inventoryAll: false,
      inventoryStores: ["NT01"],
    });

    const summary = await get("summary", token);
    expect(summary.status).toBe(200);
    expect(stub.requests).toEqual(["/api/analytics/summary?store=NT01"]);
    expect(summary.body.data.stores).toEqual(["NT01"]);
    expect(summary.body.data.data_quality).toBeNull();

    for (const path of [
      "summary?store=ALL",
      "summary?store=NT02",
      "revenue?store=nt02",
      "breakdown",
      "data-quality",
    ]) {
      expect((await get(path, token)).status, path).toBe(403);
    }
    // Chữ thường vẫn nhận ra mã của mình.
    expect((await get("revenue?store=nt01&period=week", token)).status).toBe(200);
    expect(stub.requests.at(-1)).toBe("/api/analytics/revenue?store=NT01&period=week");
  });

  it("chỉ tình trạng cần cho giao diện, không lộ đường dẫn máy chủ", async () => {
    const admin = await get("health", adminToken);
    expect(admin.body.data.monitor).toEqual({ events: 5, runs: 3, last_latency_ms: 4300 });
    expect(admin.body.data.last_run.error_message).toContain("bị khóa");

    const viewer = await get("health", await storeViewerToken());
    expect(viewer.body.data.last_run).toEqual({ id: 3, status: "failed" });
  });

  it("chuyển tiếp tham số đã kiểm tra, chặn tham số lạ", async () => {
    expect((await get("sales-trend?grain=week&start=2026-10-01", adminToken)).status).toBe(200);
    expect(stub.requests).toEqual([
      "/api/analytics/sales-trend?grain=week&start=2026-10-01&store=ALL",
    ]);
    expect((await get("breakdown?by=top_medicines", adminToken)).body.data.rows).toHaveLength(1);

    for (const path of [
      "sales-trend?grain=year",
      "sales-trend?start=hom-nay",
      "revenue?period=year",
      "breakdown?by=supplier",
      "summary?store=NT01%27%3B--",
      "data-quality?limit=100000",
    ]) {
      expect((await get(path, adminToken)).status, path).toBe(422);
    }
    expect(stub.requests).toHaveLength(2);
  });

  it("dịch lỗi của dịch vụ phân tích sang khung lỗi chuẩn", async () => {
    stub.respond("summary", 503, {
      detail: "Chưa có dữ liệu: pipeline chưa chạy thành công lần nào",
    });
    const noData = await get("summary", adminToken);
    expect(noData.status).toBe(503);
    expect(noData.body.error.code).toBe("ANALYTICS_NO_DATA");
    expect(noData.body.error.message).toContain("Chưa có dữ liệu");

    stub.respond("summary", 404, { detail: "Không có cửa hàng NT09. Có: ALL, NT01, NT02, NT03" });
    const unknown = await get("summary?store=NT09", adminToken);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.message).not.toContain("NT02");
    stub.respond("summary", 200, SUMMARY);
  });

  it("dịch vụ phân tích chưa chạy: báo 502 kèm cách bật", async () => {
    process.env["ANALYTICS_SERVICE_URL"] = "http://127.0.0.1:1";
    try {
      const response = await get("version", adminToken);
      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe("ANALYTICS_UNAVAILABLE");
      expect(response.body.error.message).toContain("python main.py serve");
    } finally {
      process.env["ANALYTICS_SERVICE_URL"] = stub.baseUrl;
    }
  });

  it("không đăng nhập hoặc không có quyền báo cáo thì không vào được", async () => {
    expect((await api().get("/api/v1/bi/summary")).status).toBe(401);
    const { token } = await login("banhang");
    expect((await get("summary", token)).status).toBe(403);
    expect(stub.requests).toEqual([]);
  });

  it("tồn kho, hạn dùng: cần report.inventory ở đúng phạm vi", async () => {
    expect((await get("inventory?status=low", adminToken)).status).toBe(200);
    expect(stub.requests.at(-1)).toBe("/api/analytics/inventory?store=ALL&status=low");
    expect((await get("expiry?level=expired", adminToken)).status).toBe(200);
    expect((await get("expiry?level=normal", adminToken)).status).toBe(422);

    const viewer = await storeViewerToken();
    expect((await get("inventory", viewer)).status).toBe(200);
    expect(stub.requests.at(-1)).toBe("/api/analytics/inventory?store=NT01");
    expect((await get("inventory?store=ALL", viewer)).status).toBe(403);
    expect((await get("expiry?store=NT02", viewer)).status).toBe(403);
  });

  it("không có report.inventory: lọc phần tồn kho khỏi cảnh báo, sản phẩm, tổng quan", async () => {
    stub.respond("products", 200, {
      version: 7,
      stock: { slow: [productRow()], not_sold: [productRow()] },
    });
    // Admin thấy đủ.
    expect((await get("alerts", adminToken)).body.data.alerts).toHaveLength(3);
    expect((await get("products", adminToken)).body.data.stock.slow[0].stock_value).toBe(1_950_000);

    await useTestRole(fixture.pharmacistId, "auditor", fixture.storeId, ["report.inventory"]);
    const token = (await login("duocsi")).token;
    expect((await get("access", token)).body.data.inventoryStores).toEqual([]);
    expect((await get("inventory", token)).status).toBe(403);

    const alerts = await get("alerts", token);
    expect(alerts.body.data.alerts.map((alert: { code: string }) => alert.code)).toEqual([
      "revenue_drop",
    ]);
    const products = await get("products?period=week", token);
    expect(products.body.data.stock.slow[0]).toEqual({ medicine_code: "TB010" });
    expect(products.body.data.stock.not_sold[0]).toEqual({ medicine_code: "TB010" });
    expect(stub.requests.at(-1)).toBe("/api/analytics/products?store=NT01&period=week");
    expect((await get("summary", token)).body.data.overview).toBeNull();
  });

  it("bất thường, dự báo: chuyển tiếp; bỏ phần tồn kho khi thiếu report.inventory", async () => {
    expect((await get("anomalies?days=7&direction=down", adminToken)).status).toBe(200);
    expect(stub.requests.at(-1)).toBe("/api/analytics/anomalies?days=7&direction=down&store=ALL");
    expect((await get("anomalies?days=100", adminToken)).status).toBe(422);
    const full = await get("forecast?target=demand", adminToken);
    expect(full.body.data.stockout).toHaveLength(1);
    expect((await get("forecast?target=weather", adminToken)).status).toBe(422);

    await useTestRole(fixture.pharmacistId, "auditor", fixture.storeId, ["report.inventory"]);
    const token = (await login("duocsi")).token;
    const events = (await get("anomalies", token)).body.data.events;
    expect(events.map((event: { kind: string }) => event.kind)).toEqual(["revenue_drop_day"]);
    const forecast = await get("forecast?target=demand", token);
    expect(forecast.body.data.demand).toHaveLength(1);
    expect(forecast.body.data.stockout).toEqual([]);
    expect(stub.requests.at(-1)).toBe("/api/analytics/forecast?store=NT01&target=demand");
  });
});

describe("ABC–XYZ, gợi ý đặt hàng (Phase 5)", () => {
  const plan = () => ({
    version: 7,
    as_of: "2026-10-30T22:00:00",
    store: "NT01",
    available: true,
    lines: 1,
    order_lines: 1,
    order_value: 1_200_000,
    transfer_lines: 1,
    transfer_value: 300_000,
    items: [
      {
        store_code: "NT01",
        medicine_code: "GD001",
        medicine_name: "Paracetamol 500mg",
        unit: "Viên",
        reason: "out_of_stock",
        order_quantity: 1_000,
        order_packs: 10,
        pack_size: 100,
        unit_cost: 1_200,
        order_value: 1_200_000,
        supplier: "DKSH",
        cell: "AX",
        days_until_stockout: 0,
        transfers: [{ from_store: "NT02", quantity: 250 }],
        transfer_quantity: 250,
      },
    ],
    transfers: [
      {
        from_store: "NT02",
        to_store: "NT01",
        medicine_code: "GD001",
        medicine_name: "Paracetamol 500mg",
        unit: "Viên",
        quantity: 250,
        value: 300_000,
      },
    ],
  });

  beforeEach(() => {
    stub.respond("classification", 200, {
      version: 7,
      store: "ALL",
      summary: {},
      matrix: {},
      items: [],
    });
    stub.respond("reorder", 200, plan());
  });

  it("người xem toàn chuỗi: chuyển tiếp đủ tham số, thấy đủ mã cửa hàng", async () => {
    expect((await get("classification?abc=A&xyz=Z", adminToken)).status).toBe(200);
    expect(stub.requests.at(-1)).toBe("/api/analytics/classification?abc=A&xyz=Z&store=ALL");
    const body = (await get("reorder?store=nt01&action=order", adminToken)).body.data;
    expect(stub.requests.at(-1)).toBe("/api/analytics/reorder?store=NT01&action=order");
    expect(body.transfers[0].from_store).toBe("NT02");
    expect((await get("classification?abc=D", adminToken)).status).toBe(422);
  });

  it("chỉ xem NT01: không thấy cửa hàng nào đang thừa hàng; thiếu report.inventory thì không xem được gợi ý", async () => {
    const token = await storeViewerToken();
    const body = (await get("reorder", token)).body.data;
    expect(stub.requests.at(-1)).toBe("/api/analytics/reorder?store=NT01");
    expect(body.items[0].transfers).toEqual([{ from_store: "Cửa hàng khác", quantity: 250 }]);
    expect(body.transfers[0]).toMatchObject({ from_store: "Cửa hàng khác", to_store: "NT01" });
    expect((await get("reorder?store=ALL", token)).status).toBe(403);

    await useTestRole(fixture.pharmacistId, "auditor", fixture.storeId, ["report.inventory"]);
    const limited = (await login("duocsi")).token;
    expect((await get("reorder", limited)).status).toBe(403);
    // ABC–XYZ chỉ có doanh thu, nhu cầu: report.sales là đủ.
    expect((await get("classification", limited)).status).toBe(200);
  });

  it("xuất Excel: sheet Mua theo nhà cung cấp và sheet Chuyển hàng", async () => {
    const response = await api()
      .get("/api/v1/bi/reorder/export?store=NT01")
      .set(authHeaders(adminToken))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("spreadsheetml");
    expect(response.headers["content-disposition"]).toContain(
      "goi-y-dat-hang-NT01-2026-10-30.xlsx",
    );
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as never);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Mua", "Chuyển hàng"]);
    const buy = workbook.getWorksheet("Mua")!;
    expect(buy.getRow(2).getCell(1).value).toBe("DKSH");
    expect(buy.getRow(2).getCell(5).value).toBe(1_000);
    expect(buy.getRow(2).getCell(11).value).toBe("Hết hàng");
    expect(workbook.getWorksheet("Chuyển hàng")!.getRow(2).getCell(5).value).toBe(250);
  });
});
