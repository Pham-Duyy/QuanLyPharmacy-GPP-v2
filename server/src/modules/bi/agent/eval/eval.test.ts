import type {
  BetaContentBlock,
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAnalyticsStub, type AnalyticsStub } from "../../../../test/analytics-stub-server.js";
import type { AgentClient, AgentResult } from "../agent.js";
import { EVAL_CASES } from "./cases.js";
import { grade, mentionsName, mentionsValue } from "./grade.js";
import { estimateCost, renderReport, runEval, summarize } from "./run.js";

/** Bộ đánh giá (bước 4.6): chấm điểm và chạy với Claude giả, không tốn tiền. */

describe("chấm điểm", () => {
  it("nhận số theo cách viết, làm tròn đúng mức, bỏ dấu, tỷ lệ", () => {
    expect(mentionsValue("Doanh thu 18.523.500 đ", 18_523_500)).toBe(true);
    expect(mentionsValue("khoảng 18,5 triệu đ", 18_523_500)).toBe(true);
    expect(mentionsValue("khoảng 19 triệu đ", 18_523_500)).toBe(true);
    expect(mentionsValue("khoảng 18,6 triệu đ", 18_523_500)).toBe(false);
    expect(mentionsValue("giảm 13,7%", -13.7)).toBe(true);
    expect(mentionsValue("sai số 10,8%", 0.1081)).toBe(true);
    expect(mentionsValue("cần 2.040 viên", 2039.75)).toBe(true);
    expect(mentionsValue("ngày 30/10/2026", 30)).toBe(false);
  });

  it("nhận tên thuốc nguyên văn hoặc bỏ hàm lượng, không phân biệt dấu", () => {
    expect(mentionsName("Bán chạy nhất là Losartan.", "Losartan 50mg")).toBe(true);
    expect(mentionsName("dau ca omega-3 dan dau", "Dầu cá Omega-3 1000mg")).toBe(true);
    expect(mentionsName("Siro ho Prospan dẫn đầu", "Siro ho Prospan 100ml")).toBe(true);
    expect(mentionsName("Vitamin C dẫn đầu", "Losartan 50mg")).toBe(false);
  });

  it("đúng trạng thái, tool, số, tên; bắt số có nguồn nhưng sai mục và số bịa", () => {
    const result = {
      status: "answered",
      answer: "CH01 dẫn đầu với 263,4 triệu đ.",
      toolCalls: [{ round: 1, name: "get_breakdown", input: {}, ok: true, durationMs: 3 }],
    } as unknown as AgentResult;
    const checks = grade(
      result,
      { tools: ["get_breakdown"] },
      {
        names: ["CH02"],
        values: [{ label: "doanh thu dẫn đầu", value: 270_999_500 }],
      },
    );
    expect(checks.map((check) => [check.name, check.pass])).toEqual([
      ["trạng thái", true],
      ["gọi get_breakdown", true],
      ["có số doanh thu dẫn đầu", false],
      ["nhắc CH02", false],
    ]);

    const invented = grade(
      { ...result, answer: "Công nợ khoảng 12 triệu đ.", toolCalls: [] } as AgentResult,
      { noMoney: true, noTools: true, mentions: [/chua co/] },
    );
    expect(invented.filter((check) => !check.pass).map((check) => check.name)).toEqual([
      "nói chua co",
      "không bịa số",
    ]);
  });

  it("bộ câu hỏi: 33 câu, mã không trùng, câu hỏi tiếp trỏ đúng câu gốc", () => {
    expect(EVAL_CASES).toHaveLength(33);
    const ids = EVAL_CASES.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of EVAL_CASES.filter((entry) => entry.followUp)) {
      expect(ids.indexOf(item.followUp!)).toBeLessThan(ids.indexOf(item.id));
    }
  });

  it("ước tính chi phí", () => {
    const estimate = estimateCost(33);
    expect(estimate.totalUsd).toBeGreaterThan(1);
    expect(estimate.totalUsd).toBeLessThan(3);
    expect(estimate.worstUsd).toBeGreaterThan(estimate.totalUsd);
  });
});

// --- Chạy cả vòng với Claude giả ------------------------------------------------------------

const REVENUE = {
  version: 1,
  as_of: "2026-10-30T14:00:00",
  store: "ALL",
  label: "Hôm nay",
  current: { revenue: 18_523_500, orders: 146 },
};

let stub: AnalyticsStub;
beforeAll(async () => {
  stub = await startAnalyticsStub({ revenue: REVENUE });
  process.env["ANALYTICS_SERVICE_URL"] = stub.baseUrl;
});
afterAll(async () => {
  delete process.env["ANALYTICS_SERVICE_URL"];
  await stub.close();
});

/** Claude giả: hỏi số thì gọi get_revenue rồi đọc số ra; câu "xóa" thì từ chối. */
function scriptedClaude(answerFor: (revenue: number) => string): AgentClient {
  let id = 0;
  return {
    async create(params: MessageCreateParamsNonStreaming) {
      const last = params.messages.at(-1)!;
      const base = {
        id: `msg_${++id}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        stop_sequence: null,
        usage: {
          input_tokens: 500,
          output_tokens: 100,
          cache_read_input_tokens: 4_000,
          cache_creation_input_tokens: 0,
        },
      };
      const text = (value: string) =>
        ({
          ...base,
          stop_reason: "end_turn",
          content: [{ type: "text", text: value, citations: null }],
        }) as BetaMessage;
      if (typeof last.content === "string") {
        if (last.content.includes("Xóa"))
          return text("Tôi là trợ lý chỉ đọc, không thể xóa dữ liệu.");
        return {
          ...base,
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: `toolu_${id}`,
              name: "get_revenue",
              input: { store: "ALL", period: "day" },
            } as BetaContentBlock,
          ],
        } as BetaMessage;
      }
      const result = (
        last.content as Array<{ type: string; content?: string; is_error?: boolean }>
      ).find((block) => block.type === "tool_result");
      if (result?.is_error) return text("Bạn không có quyền xem số liệu toàn chuỗi.");
      return text(answerFor(JSON.parse(result?.content ?? "{}").current.revenue));
    },
  };
}

const pick = (...ids: string[]) => EVAL_CASES.filter((item) => ids.includes(item.id));

describe("chạy bộ đánh giá", () => {
  it("trả lời đúng: đạt cả câu số, câu phân quyền, câu từ chối; câu hỏi tiếp dùng lịch sử", async () => {
    const { results, stoppedForBudget } = await runEval({
      cases: pick("kpi-revenue-today", "permission-chain", "safety-write", "followup-week"),
      stores: ["CH01", "CH02", "CH03"],
      client: scriptedClaude(
        (revenue) => `Doanh thu hôm nay ${(revenue / 1e6).toFixed(1).replace(".", ",")} triệu đ.`,
      ),
      budgetUsd: 3,
    });
    expect(stoppedForBudget).toBe(false);
    expect(results.map((result) => [result.id, result.pass])).toEqual([
      ["kpi-revenue-today", true],
      ["permission-chain", true],
      ["safety-write", true],
      // Stub trả cùng một số cho "tuần": đúng giá trị nên đạt; quan trọng là có chạy với lịch sử.
      ["followup-week", true],
    ]);
    const report = renderReport(results, {
      model: "claude-opus-5-5",
      startedAt: new Date(),
      stoppedForBudget,
    });
    expect(report).toContain("Câu đạt: **4/4 (100%)**");
    expect(report).toContain("### safety-write ✓");
  });

  it("số sai mục bị tính, ngân sách chạm thì dừng", async () => {
    const wrong = await runEval({
      cases: pick("kpi-revenue-today"),
      stores: ["CH01", "CH02", "CH03"],
      // 146 là số đơn: có trong kết quả tool nên qua đối chiếu, nhưng không phải doanh thu.
      client: scriptedClaude(() => "Hôm nay có 146 đơn."),
      budgetUsd: 3,
    });
    expect(wrong.results[0]).toMatchObject({ pass: false, status: "answered" });
    expect(summarize(wrong.results).misattributed).toBe(1);

    const limited = await runEval({
      cases: pick("kpi-revenue-today", "safety-write"),
      stores: ["CH01"],
      client: scriptedClaude(() => "x"),
      budgetUsd: 0.000_001,
    });
    expect(limited.stoppedForBudget).toBe(true);
    expect(limited.results).toHaveLength(1);
  });
});
