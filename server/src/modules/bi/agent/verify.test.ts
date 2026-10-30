import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";
import { collectFacts, correctionTurn, verifyAnswer } from "./verify.js";

/** Đối chiếu số (bước 4.3): tất định, không cần Claude. */

const QUESTION: BetaMessageParam = {
  role: "user",
  content:
    "<boi_canh>\nThời điểm hỏi: 14:05, Thứ Sáu 30/10/2026 (giờ Việt Nam)\nPhạm vi mặc định: ALL\n</boi_canh>\n\nTop 5 thuốc bán chạy tháng này?",
};

function toolResults(...contents: unknown[]): BetaMessageParam {
  return {
    role: "user",
    content: contents.map((content, index) => ({
      type: "tool_result" as const,
      tool_use_id: `toolu_${index}`,
      content: JSON.stringify(content),
    })),
  };
}

const REVENUE = {
  as_of: "2026-10-29T12:00:00",
  store: "ALL",
  label: "Tháng này",
  current: { revenue: 22_874_000, orders: 31, margin_pct: 27.35 },
  previous_same_span: { revenue: 6_000_000 },
  growth: { revenue: 281.2 },
};
const FORECAST = {
  data_through: "2026-10-28",
  model_label: "Holt-Winters",
  wape: 0.091,
  next_7_days_total: 160_250_000,
};
const PRODUCTS = {
  products: [
    { medicine_name: "Omega-3 1000mg", revenue: 1_250_000 },
    { medicine_name: "Vitamin B12", revenue: 980_500 },
  ],
};
const ANOMALY = {
  events: [
    {
      store_code: "CH03",
      start: "2026-10-20",
      change_pct: -79.4,
      message: "CH03 giảm 79% so với 4 thứ Ba trước",
    },
  ],
};

const facts = collectFacts([QUESTION, toolResults(REVENUE, FORECAST, PRODUCTS, ANOMALY)]);
const check = (answer: string) => verifyAnswer(answer, facts).unverified;

describe("số khớp nguồn", () => {
  it.each([
    ["nguyên văn kiểu Việt Nam", "Doanh thu 22.874.000 đ."],
    ["kiểu Anh", "Doanh thu 22,874,000 đ."],
    [
      "làm tròn theo triệu, đúng số chữ số đã viết",
      "Doanh thu 22,9 triệu đ, dự báo 7 ngày 160,3 triệu đ.",
    ],
    ["làm tròn triệu không có số lẻ", "Khoảng 23 triệu đ."],
    ["nghìn, tỷ", "Omega-3 bán 1.250 nghìn đ; cả kỳ 0,02 tỷ đ."],
    ["phần trăm đổi dấu, làm tròn", "Tăng 281,2%, CH03 giảm 79% (biên 27,4%)."],
    ["tỷ lệ 0,091 viết thành phần trăm", "Sai số dự báo khoảng 9,1%."],
    [
      "ngày, giờ, tháng có trong dữ liệu hoặc câu hỏi",
      "Số liệu đến 12:00 ngày 29/10/2026; dự báo từ 28/10, tháng 10/2026. Hỏi lúc 14:05.",
    ],
    ["ngày ISO", "Ngày 2026-10-20 CH03 giảm mạnh."],
    [
      "tên có số, mã cửa hàng, số thứ tự, số đếm nhỏ",
      "1. Omega-3 1000mg và Vitamin B12 ở CH03\n2. Có 2 mặt hàng, gấp 3 lần.",
    ],
    ["số trong câu hỏi và kỳ cố định", "Top 5 thuốc; tồn đủ 30 ngày, hạn trong 90 ngày."],
    ["không có số", "Hệ thống chưa có dữ liệu công nợ khách hàng."],
  ])("%s", (_label, answer) => {
    expect(check(answer)).toEqual([]);
  });

  it("đếm số cụm đã kiểm", () => {
    expect(verifyAnswer("Doanh thu 22,9 triệu đ, tăng 281,2% đến 29/10/2026.", facts).checked).toBe(
      3,
    );
  });
});

describe("số không có nguồn", () => {
  it("số tự cộng hai kỳ", () => {
    // 22.874.000 + 6.000.000 = 28.874.000: phép tính của LLM, không có trong tool.
    expect(check("Hai kỳ cộng lại 28,9 triệu đ.")).toEqual(["28,9 triệu"]);
  });

  it("làm tròn quá tay: viết nhiều chữ số hơn mức khớp", () => {
    expect(check("Doanh thu 22,87 triệu đ.")).toEqual([]);
    expect(check("Doanh thu 22,88 triệu đ.")).toEqual(["22,88 triệu"]);
  });

  it("phần trăm tự tính, số bịa", () => {
    expect(check("Đơn hàng tăng 35%, trung bình 737.871 đ/đơn.")).toEqual(["35%", "737.871"]);
  });

  it("ngày, giờ, tháng không có trong dữ liệu", () => {
    expect(check("Hết hàng ngày 15/11/2026 lúc 09:30, tháng 12 sẽ tăng.")).toEqual([
      "15/11/2026",
      "tháng 12",
      "09:30",
    ]);
  });

  it("số trong lời nhắc sửa của server không trở thành nguồn", () => {
    const withCorrection = collectFacts([
      QUESTION,
      toolResults(REVENUE),
      { role: "assistant", content: "Doanh thu 99 triệu đ." },
      correctionTurn(["99 triệu"]),
    ]);
    expect(verifyAnswer("Doanh thu 99 triệu đ.", withCorrection).unverified).toEqual(["99 triệu"]);
  });

  it("kết quả tool báo lỗi không phải nguồn số", () => {
    const failed = collectFacts([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t",
            is_error: true,
            content: JSON.stringify({ error: "Giá 4.400.000" }),
          },
        ],
      },
    ]);
    expect(verifyAnswer("Giá 4.400.000 đ.", failed).unverified).toEqual(["4.400.000"]);
  });
});
