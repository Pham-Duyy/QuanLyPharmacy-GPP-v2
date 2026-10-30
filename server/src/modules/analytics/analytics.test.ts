import ExcelJS from "exceljs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  type Fixture,
} from "../../test/helpers.js";
import { readWorkbook } from "./excel.js";
import { executePlan } from "./execute.js";
import { buildCharts, buildFacts } from "./insights.js";
import { unverifiedPercents } from "./llm.js";
import { detectNumberStyle, parseCsv, parseNumber, parseTemporal } from "./parse.js";
import { planWithRules, validatePlan, valueFormatFor } from "./planner.js";
import { profileDataset, toSummary } from "./summarize.js";
import type { AnalysisPlan } from "./types.js";

const QUESTION =
  "Phân tích xu hướng doanh thu 12 tháng gần nhất và cho biết chi nhánh nào giảm mạnh nhất.";

/** 13 tháng, ba chi nhánh: A tăng đều, B giảm mạnh, C đi ngang. */
function revenueCsv(): string {
  const lines = ["thang;chi_nhanh;doanh_thu"];
  for (let month = 0; month < 13; month += 1) {
    const key = new Date(Date.UTC(2025, month, 1)).toISOString().slice(0, 7);
    lines.push(`${key};Chi nhánh A;${(100 + month * 10).toLocaleString("vi-VN")}.000.000`);
    lines.push(`${key};Chi nhánh B;${(200 - month * 8).toLocaleString("vi-VN")}.000.000`);
    lines.push(`${key};Chi nhánh C;150.000.000`);
  }
  return lines.join("\r\n");
}

function analyse(csv: string, question: string) {
  const typed = profileDataset(parseCsv(csv, "doanh_thu.csv"));
  const checked = validatePlan(planWithRules(toSummary(typed), question), typed);
  return { typed, ...executePlan(checked.plan, typed) };
}

describe("đọc dữ liệu", () => {
  it("đọc CSV có BOM, dấu chấm phẩy, ô ngoặc kép và tiêu đề trùng", () => {
    const dataset = parseCsv('﻿ten;ten;ghi_chu\r\n"Nguyễn ""A""";1;"có; dấu"\r\n\r\nB;2;', "x.csv");
    expect(dataset.columns).toEqual(["ten", "ten_2", "ghi_chu"]);
    expect(dataset.rows).toEqual([
      ['Nguyễn "A"', "1", "có; dấu"],
      ["B", "2", null],
    ]);
  });

  it("nhận cách viết số kiểu Việt Nam và quốc tế", () => {
    expect(detectNumberStyle(["1.234.567", "2.000"])).toBe("vn");
    expect(parseNumber("1.234.567,5 đ", "vn")).toBe(1234567.5);
    expect(detectNumberStyle(["1,234,567.5"])).toBe("intl");
    expect(parseNumber("1,234,567.5", "intl")).toBe(1234567.5);
    expect(detectNumberStyle(["1.500", "2.250"])).toBe("vn");
    expect(parseNumber("12,5", "plain")).toBe(12.5);
    expect(parseNumber("(300)", "plain")).toBe(-300);
    expect(parseNumber("abc", "plain")).toBeNull();
  });

  it("nhận các cách ghi thời gian hay gặp", () => {
    const iso = (raw: string) => parseTemporal(raw)?.at.toISOString().slice(0, 16);
    expect(iso("2025-03-01")).toBe("2025-03-01T00:00");
    expect(iso("01/03/2025 08:30")).toBe("2025-03-01T08:30");
    expect(iso("03/2025")).toBe("2025-03-01T00:00");
    expect(iso("Tháng 3/2025")).toBe("2025-03-01T00:00");
    expect(iso("Q2/2025")).toBe("2025-04-01T00:00");
    expect(parseTemporal("31/02/2025")).toBeNull();
    expect(parseTemporal("12345")).toBeNull();
  });

  it("tóm tắt kiểu từng cột, cột mã số không bị coi là số đo", () => {
    const csv = "ma_cn,thang,doanh_thu,ten\n1,2025-01,100,An\n2,2025-02,200,Bình\n";
    const summary = toSummary(profileDataset(parseCsv(csv, "x.csv")));
    expect(summary.columns.map((column) => [column.name, column.kind])).toEqual([
      ["ma_cn", "categorical"],
      ["thang", "temporal"],
      ["doanh_thu", "numeric"],
      ["ten", "categorical"],
    ]);
    expect(summary.columns[1]!.temporalPrecision).toBe("month");
  });
});

/**
 * Báo cáo Excel kiểu tự lập: tiêu đề gộp ô, dòng đơn vị tính, bảng ngang theo
 * tháng, dòng "Tổng cộng" bằng công thức; thêm một sheet chi tiết và một sheet ẩn.
 */
async function reportWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet("Doanh thu 2025");
  summary.mergeCells("A1:F1");
  summary.getCell("A1").value = "BÁO CÁO DOANH THU NĂM 2025";
  summary.getCell("A2").value = "Đơn vị tính: đồng";
  summary.addRow([]);
  summary.addRow(["Chi nhánh", "T1", "T2", "T3", "T4", "T5"]);
  summary.addRow(["A", 100, 110, 120, 130, 140]);
  summary.addRow(["B", 200, 180, 160, 140, { formula: "60*2", result: 120 }]);
  summary.addRow(["Tổng cộng", 300, 290, 280, 270, 260]);

  const detail = workbook.addWorksheet("Chi tiết");
  detail.addRow(["Ngày", "Nhóm hàng", "Thành tiền"]);
  detail.addRow([new Date(Date.UTC(2025, 0, 6)), "Vitamin", 50]);
  detail.addRow([
    new Date(Date.UTC(2025, 0, 7)),
    { richText: [{ text: "Kháng " }, { text: "sinh" }] },
    70,
  ]);

  const hidden = workbook.addWorksheet("Nội bộ");
  hidden.state = "hidden";
  hidden.addRow(["x", "y"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("đọc Excel", () => {
  it("bỏ tiêu đề báo cáo và dòng tổng, đổi bảng ngang theo tháng thành bảng dọc", async () => {
    const { dataset, source } = await readWorkbook(await reportWorkbook(), "bao_cao.xlsx");
    expect(source.sheet).toBe("Doanh thu 2025");
    expect(source.sheets.map((sheet) => sheet.name)).toEqual(["Doanh thu 2025", "Chi tiết"]);
    expect(source.notes).toHaveLength(3);
    expect(dataset.columns).toEqual(["Chi nhánh", "thoi_gian", "doanh_thu"]);
    expect(dataset.rows).toHaveLength(10);
    expect(dataset.rows.at(-1)).toEqual(["B", "2025-05", 120]);

    const typed = profileDataset(dataset);
    const { plan } = validatePlan(planWithRules(toSummary(typed), QUESTION), typed);
    const { result } = executePlan(plan, typed);
    expect(result.overall.total).toBe(1400);
    expect(result.groups.find((group) => group.group === "B")!.changePercent).toBe(-40);
  });

  it("đọc sheet được chọn: ngày, chữ định dạng, công thức", async () => {
    const { dataset } = await readWorkbook(await reportWorkbook(), "bao_cao.xlsx", "Chi tiết");
    expect(dataset.columns).toEqual(["Ngày", "Nhóm hàng", "Thành tiền"]);
    expect(dataset.rows).toEqual([
      ["2025-01-06", "Vitamin", 50],
      ["2025-01-07", "Kháng sinh", 70],
    ]);
  });

  it("từ chối sheet ẩn, sheet không có và tệp không phải .xlsx", async () => {
    const buffer = await reportWorkbook();
    await expect(readWorkbook(buffer, "x.xlsx", "Nội bộ")).rejects.toThrow("Không có sheet");
    await expect(readWorkbook(Buffer.from("abc"), "x.xls")).rejects.toThrow(".xlsx");
  });
});

/** Giống tệp "Tổng kết tháng" phần mềm xuất: bảng chỉ tiêu và bảng xếp hạng. */
async function periodSummaryWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const overview = workbook.addWorksheet("Tổng quan");
  overview.addRow(["Chỉ tiêu", "Giá trị"]);
  overview.addRow(["Số phiếu nhập", 19]);
  overview.addRow(["Tổng tiền nhập (phải trả NCC)", 47_863_559]);
  overview.addRow(["Doanh thu thuần", 78_367_900]);
  overview.addRow(["Lãi gộp", 22_299_376]);
  const ranking = workbook.addWorksheet("Xếp hạng bán");
  ranking.addRow([
    "Hạng",
    "Mã sản phẩm",
    "Tên sản phẩm",
    "Số lượng bán",
    "Doanh thu thuần",
    "Lãi gộp",
    "Tỷ trọng (%)",
  ]);
  const items: Array<[string, number, number]> = [
    ["Dầu cá Omega-3", 4_160_000, 747_500],
    ["Amoxicillin + Acid clavulanic 1g", 3_920_000, 1_372_000],
    ["Siro ho Prospan", 2_660_000, 798_000],
    ["Paracetamol 500mg", 2_480_940, 783_660],
  ];
  items.forEach(([name, revenue, profit], index) =>
    ranking.addRow([index + 1, `TH${index}`, name, 100 - index, revenue, profit, 5 - index]),
  );
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("bảng tổng kết không theo thời gian", () => {
  it("bảng chỉ tiêu: giữ dòng 'Tổng tiền nhập', không cộng các chỉ tiêu khác đơn vị", async () => {
    const { dataset, source } = await readWorkbook(
      await periodSummaryWorkbook(),
      "x.xlsx",
      "Tổng quan",
    );
    expect(source.notes).toEqual([]);
    expect(dataset.rows).toHaveLength(4);
    const typed = profileDataset(dataset);
    const { plan } = validatePlan(planWithRules(toSummary(typed), "Tổng quan tháng này"), typed);
    const { result } = executePlan(plan, typed);
    expect(result.metricTable).toBe(true);
    expect(result.groups.map((group) => group.group)).toEqual([
      "Số phiếu nhập",
      "Tổng tiền nhập (phải trả NCC)",
      "Doanh thu thuần",
      "Lãi gộp",
    ]);
    expect(result.groups.every((group) => group.share === null)).toBe(true);
    expect(buildCharts(plan, result, "currency")).toEqual([]);
    expect(buildFacts(plan, result, "currency").map((fact) => fact.text)).toEqual([
      "Số phiếu nhập: 19.",
      "Tổng tiền nhập (phải trả NCC): 47,9 triệu đ.",
      "Doanh thu thuần: 78,4 triệu đ.",
      "Lãi gộp: 22,3 triệu đ.",
    ]);
  });

  it("bảng xếp hạng: đúng cột được hỏi, nhóm theo tên sản phẩm, không lấy cột Hạng", async () => {
    const { dataset } = await readWorkbook(await periodSummaryWorkbook(), "x.xlsx", "Xếp hạng bán");
    const typed = profileDataset(dataset);
    const summary = toSummary(typed);
    expect(summary.columns[0]).toMatchObject({ name: "Hạng", kind: "categorical" });

    const plan = planWithRules(summary, "Mặt hàng nào có lãi gộp cao nhất?");
    expect(plan.measure.column).toBe("Lãi gộp");
    expect(plan.groupBy?.column).toBe("Tên sản phẩm");
    const { result, plan: checked } = executePlan(validatePlan(plan, typed).plan, typed);
    expect(result.groups[0]!.group).toBe("Amoxicillin + Acid clavulanic 1g");
    expect(valueFormatFor(checked)).toBe("currency");

    // Không nhắc cột nào: ưu tiên đại lượng tiền, bỏ qua cột Hạng và cột phần trăm.
    expect(planWithRules(summary, "Xếp hạng các mặt hàng").measure.column).toBe("Doanh thu thuần");
    // "Bán chạy" khớp cột "Số lượng bán": hiểu theo số lượng là hợp lý.
    expect(planWithRules(summary, "Mặt hàng nào bán chạy?").measure.column).toBe("Số lượng bán");
  });
});

describe("lập kế hoạch bằng luật", () => {
  it("hiểu câu hỏi mẫu: 12 tháng theo tháng, nhóm theo chi nhánh", () => {
    const { plan } = analyse(revenueCsv(), QUESTION);
    expect(plan.measure).toMatchObject({
      column: "doanh_thu",
      aggregate: "sum",
      label: "Doanh thu",
    });
    expect(plan.time).toEqual({ column: "thang", grain: "month", lastPeriods: 12 });
    expect(plan.groupBy?.column).toBe("chi_nhanh");
    expect(plan.focus).toBe("change");
  });

  it("lọc theo giá trị được nhắc tên trong câu hỏi", () => {
    const { plan } = analyse(revenueCsv(), "Doanh thu theo quý của chi nhánh B");
    expect(plan.filters).toEqual([
      { column: "chi_nhanh", operator: "in", values: ["Chi nhánh B"] },
    ]);
    expect(plan.time?.grain).toBe("quarter");
  });

  it("sửa kế hoạch sai cột thay vì chạy mù", () => {
    const typed = profileDataset(parseCsv(revenueCsv(), "x.csv"));
    const bad: AnalysisPlan = {
      intent: "x",
      measure: { column: "chi_nhanh", aggregate: "sum", label: "" },
      time: { column: "doanh_thu", grain: "minute", lastPeriods: 3 },
      groupBy: { column: "thang", topN: 50 },
      filters: [{ column: "khong_co", operator: "eq", values: ["1"] }],
      focus: "trend",
    };
    const { plan, warnings } = validatePlan(bad, typed);
    expect(plan.measure).toEqual({ column: null, aggregate: "count", label: "Số dòng" });
    expect(plan.time).toBeNull();
    expect(plan.groupBy).toBeNull();
    expect(plan.filters).toEqual([]);
    expect(warnings).toHaveLength(4);
  });

  it("không cho chia nhỏ hơn độ chi tiết của dữ liệu", () => {
    const typed = profileDataset(parseCsv(revenueCsv(), "x.csv"));
    const plan = planWithRules(toSummary(typed), "");
    const { plan: checked } = validatePlan(
      { ...plan, time: { column: "thang", grain: "day", lastPeriods: null } },
      typed,
    );
    expect(checked.time?.grain).toBe("month");
  });
});

describe("tính toán và nhận xét", () => {
  it("lấy đúng 12 kỳ gần nhất và tìm ra chi nhánh giảm mạnh nhất", () => {
    const { result, plan } = analyse(revenueCsv(), QUESTION);
    expect(result.periods).toHaveLength(12);
    expect(result.periods[0]).toBe("2025-02");
    expect(result.periods.at(-1)).toBe("2026-01");

    const byName = new Map(result.groups.map((group) => [group.group, group]));
    // B: 192 triệu (tháng 2/2025) → 104 triệu (tháng 1/2026).
    expect(byName.get("Chi nhánh B")).toMatchObject({
      first: 192e6,
      last: 104e6,
      changePercent: -45.8,
    });
    expect(byName.get("Chi nhánh A")).toMatchObject({
      first: 110e6,
      last: 220e6,
      changePercent: 100,
    });
    expect(byName.get("Chi nhánh C")!.changePercent).toBe(0);
    expect(result.overall.total).toBe(result.groups.reduce((sum, group) => sum + group.total, 0));

    const facts = buildFacts(plan, result, "currency");
    const decline = facts.find((fact) => fact.kind === "decline")!;
    expect(decline.text).toContain("Chi nhánh B");
    expect(decline.text).toContain("−45,8%");
    expect(buildCharts(plan, result, "currency").map((chart) => chart.kind)).toEqual([
      "line",
      "line",
      "bar",
      "change",
    ]);
  });

  it("kỳ đang diễn ra vẫn vẽ nhưng không tính vào mức tăng/giảm", () => {
    const typed = profileDataset(parseCsv(revenueCsv(), "x.csv"));
    const { plan } = validatePlan(planWithRules(toSummary(typed), QUESTION), typed);
    const { result, warnings } = executePlan(plan, typed, {
      now: new Date(Date.UTC(2026, 0, 15, 10)),
    });
    expect(result.periods.at(-1)).toBe("2026-01");
    expect(result.groups.find((group) => group.group === "Chi nhánh B")!.last).toBe(112e6);
    expect(warnings.some((warning) => warning.includes("01/2026"))).toBe(true);
  });

  it("gộp các nhóm ngoài topN vào Khác mà tổng không đổi", () => {
    const lines = ["cua_hang,doanh_thu"];
    for (let store = 1; store <= 12; store += 1) lines.push(`CH${store},${store * 10}`);
    const typed = profileDataset(parseCsv(lines.join("\n"), "x.csv"));
    const plan: AnalysisPlan = {
      intent: "So sánh cửa hàng",
      measure: { column: "doanh_thu", aggregate: "sum", label: "Doanh thu" },
      time: null,
      groupBy: { column: "cua_hang", topN: 3 },
      filters: [],
      focus: "compare",
    };
    const { result } = executePlan(plan, typed);
    expect(result.groups.map((group) => group.group)).toEqual(["CH12", "CH11", "CH10", "Khác"]);
    expect(result.groups.at(-1)!.total).toBe(450);
    expect(result.otherGroupCount).toBe(9);
    expect(result.groups.reduce((sum, group) => sum + group.total, 0)).toBe(780);
  });

  it("bắt phần trăm AI tự bịa không có trong bảng tính", () => {
    const { result, plan } = analyse(revenueCsv(), QUESTION);
    const facts = buildFacts(plan, result, "currency");
    const honest = {
      headline: "Chi nhánh B giảm 45,8%.",
      findings: ["A tăng +100%"],
      recommendations: [],
    };
    expect(unverifiedPercents(honest, facts, result)).toEqual([]);
    const invented = { headline: "Chi nhánh B giảm 37%.", findings: [], recommendations: [] };
    expect(unverifiedPercents(invented, facts, result)).toEqual(["37%"]);
  });
});

describe("API trợ lý phân tích", () => {
  let fixture: Fixture;
  let adminToken: string;

  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture();
    adminToken = (await login("admin")).token;
  });

  afterAll(async () => {
    await truncateAll();
  });

  it("phân tích tệp CSV tải lên, không có khóa AI thì dùng luật", async () => {
    const response = await api()
      .post("/api/v1/analytics/csv")
      .set(authHeaders(adminToken))
      .field("question", QUESTION)
      .attach("file", Buffer.from(revenueCsv(), "utf8"), "doanh_thu.csv");

    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.planSource).toBe("rules");
    expect(data.narrativeSource).toBe("rules");
    expect(data.valueFormat).toBe("currency");
    expect(data.narrative.headline).toContain("Chi nhánh B");
    expect(data.charts).toHaveLength(4);
    expect(data.summary.rowCount).toBe(39);
  });

  it("chạy lại theo kế hoạch gửi kèm, không lập kế hoạch lại", async () => {
    const plan: AnalysisPlan = {
      intent: "Doanh thu chi nhánh A",
      measure: { column: "doanh_thu", aggregate: "sum", label: "Doanh thu" },
      time: { column: "thang", grain: "quarter", lastPeriods: null },
      groupBy: null,
      filters: [{ column: "chi_nhanh", operator: "eq", values: ["chi nhánh a"] }],
      focus: "trend",
    };
    const response = await api()
      .post("/api/v1/analytics/csv")
      .set(authHeaders(adminToken))
      .field("plan", JSON.stringify(plan))
      .field("narrate", "false")
      .attach("file", Buffer.from(revenueCsv(), "utf8"), "doanh_thu.csv");

    expect(response.status).toBe(200);
    expect(response.body.data.planSource).toBe("provided");
    expect(response.body.data.result.rowsUsed).toBe(13);
    expect(response.body.data.result.periods).toEqual([
      "2025-Q1",
      "2025-Q2",
      "2025-Q3",
      "2025-Q4",
      "2026-Q1",
    ]);
  });

  it("từ chối tệp không phải bảng dữ liệu và kế hoạch hỏng", async () => {
    const empty = await api()
      .post("/api/v1/analytics/csv")
      .set(authHeaders(adminToken))
      .attach("file", Buffer.from("chi_mot_dong\n"), "x.csv");
    expect(empty.status).toBe(422);

    const badPlan = await api()
      .post("/api/v1/analytics/csv")
      .set(authHeaders(adminToken))
      .field("plan", "{khong phai json")
      .attach("file", Buffer.from(revenueCsv()), "x.csv");
    expect(badPlan.status).toBe(422);
  });

  it("người không có quyền báo cáo không dùng được", async () => {
    const { token } = await login("duocsi");
    const response = await api()
      .post("/api/v1/analytics/chain")
      .set(authHeaders(token, fixture.storeId))
      .send({ question: QUESTION });
    expect(response.status).toBe(403);
  });

  it("dữ liệu chuỗi gộp hóa đơn hoàn tất của mọi cửa hàng được xem", async () => {
    const sold = (storeId: string, totalAmount: number, daysAgo: number, status = "COMPLETED") => {
      const soldAt = new Date(Date.now() - daysAgo * 86_400_000);
      return prisma.invoice.create({
        data: {
          storeId,
          code: `HD-${storeId.slice(0, 4)}-${totalAmount}-${daysAgo}-${status}`,
          sellerId: fixture.adminId,
          soldAt,
          businessDate: new Date(soldAt.toISOString().slice(0, 10)),
          status,
          subtotal: totalAmount,
          totalAmount,
        },
      });
    };
    await sold(fixture.storeId, 300_000, 40);
    await sold(fixture.storeId, 500_000, 2);
    await sold(fixture.otherStoreId, 200_000, 2);
    await sold(fixture.otherStoreId, 900_000, 2, "VOIDED");
    // Ngoài cửa sổ 13 tháng.
    await sold(fixture.otherStoreId, 700_000, 500);

    const response = await api()
      .post("/api/v1/analytics/chain")
      .set(authHeaders(adminToken, fixture.storeId))
      .send({ question: "So sánh doanh thu các cửa hàng theo tháng", window: "day" });

    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.summary.columns.map((column: { name: string }) => column.name)).toEqual([
      "thoi_diem",
      "cua_hang",
      "doanh_thu",
      "so_hoa_don",
    ]);
    expect(data.plan.groupBy.column).toBe("cua_hang");
    expect(data.result.overall.total).toBe(1_000_000);
    expect(data.result.groups).toHaveLength(2);
  });

  it("phân tích thẳng tệp Excel, chọn được sheet", async () => {
    const buffer = await reportWorkbook();
    const first = await api()
      .post("/api/v1/analytics/file")
      .set(authHeaders(adminToken))
      .field("question", QUESTION)
      .attach("file", buffer, "bao_cao.xlsx");
    expect(first.status).toBe(200);
    expect(first.body.data.source.kind).toBe("xlsx");
    expect(first.body.data.source.sheet).toBe("Doanh thu 2025");
    expect(first.body.data.narrative.headline).toContain('"B"');

    const detail = await api()
      .post("/api/v1/analytics/file")
      .set(authHeaders(adminToken))
      .field("sheet", "Chi tiết")
      .attach("file", buffer, "bao_cao.xlsx");
    expect(detail.status).toBe(200);
    expect(detail.body.data.result.overall.total).toBe(120);
  });

  it("báo cấu hình AI cho giao diện", async () => {
    const response = await api().get("/api/v1/analytics/config").set(authHeaders(adminToken));
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      aiEnabled: false,
      model: null,
      windows: ["day", "hour", "minute"],
    });
  });
});
