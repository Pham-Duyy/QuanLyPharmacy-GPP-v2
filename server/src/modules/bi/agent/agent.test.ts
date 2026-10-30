import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAnalyticsStub, type AnalyticsStub } from "../../../test/analytics-stub-server.js";
import type { BiAccess } from "../bi.service.js";
import { AGENT_LIMITS, SYSTEM_PROMPT, askAgent, costUsd, type AgentClient } from "./agent.js";

/**
 * Vòng lặp Agent (bước 4.2) với Claude giả: kịch bản trả lời viết sẵn, không gọi
 * API thật, không tốn tiền. Tool chạy thật qua bi.service.ts tới analytics-service giả.
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
const NT01_SALES_ONLY: BiAccess = {
  allStores: false,
  stores: [{ code: "NT01", name: "Nhà thuốc 1" }],
  inventoryAll: false,
  inventoryStores: [],
};
const NOW = new Date("2026-10-30T07:05:00Z");

type Step = Partial<BetaMessage> & { content: BetaContentBlock[] };

let toolId = 0;
function toolUse(name: string, input: unknown): BetaContentBlock {
  toolId += 1;
  return { type: "tool_use", id: `toolu_${toolId}`, name, input } as BetaContentBlock;
}
function text(value: string): BetaContentBlock {
  return { type: "text", text: value, citations: null } as BetaContentBlock;
}
const callTools = (...blocks: BetaContentBlock[]): Step => ({
  stop_reason: "tool_use",
  content: blocks,
});
const reply = (value: string): Step => ({ stop_reason: "end_turn", content: [text(value)] });

/** Claude giả: trả lần lượt theo kịch bản, ghi lại tham số (chụp lại vì mảng messages còn được thêm). */
function fakeClaude(steps: Array<Step | ((params: MessageCreateParamsNonStreaming) => Step)>) {
  const calls: MessageCreateParamsNonStreaming[] = [];
  const client: AgentClient = {
    async create(params) {
      calls.push(structuredClone(params));
      const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
      const result = typeof step === "function" ? step(params) : step;
      return {
        id: `msg_${calls.length}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 1_000,
          cache_creation_input_tokens: 200,
        },
        ...result,
      } as BetaMessage;
    },
  };
  return { client, calls };
}

let stub: AnalyticsStub;

beforeAll(async () => {
  stub = await startAnalyticsStub({
    revenue: {
      version: 1,
      as_of: "2026-10-30T14:00:00",
      store: "ALL",
      period: "day",
      label: "Hôm nay",
      current: { revenue: 22_900_000, orders: 31 },
    },
  });
  process.env["ANALYTICS_SERVICE_URL"] = stub.baseUrl;
});

afterAll(async () => {
  delete process.env["ANALYTICS_SERVICE_URL"];
  await stub.close();
});

describe("vòng lặp tool use", () => {
  it("gọi tool, gửi kết quả, trả lời; lịch sử đúng thứ tự, tính token và chi phí", async () => {
    const fake = fakeClaude([
      callTools(
        toolUse("get_revenue", { store: "ALL", period: "day" }),
        toolUse("get_inventory", { store: "XX'; DROP", status: "all" }),
      ),
      reply("Doanh thu hôm nay 22,9 triệu đ."),
    ]);
    const result = await askAgent({
      access: CHAIN,
      question: "Doanh thu hôm nay?",
      now: NOW,
      client: fake.client,
    });

    expect(result).toMatchObject({
      status: "answered",
      answer: "Doanh thu hôm nay 22,9 triệu đ.",
      rounds: 2,
      model: "claude-opus-5-5",
      usage: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 2_000, cacheWriteTokens: 400 },
    });
    // 200×4 + 100×20 + 400×5 + 2.000×0,2 = 5.200 phần triệu USD.
    expect(result.costUsd).toBeCloseTo(0.0052, 6);
    expect(result.toolCalls.map(({ name, ok, round }) => ({ name, ok, round }))).toEqual([
      { name: "get_revenue", ok: true, round: 1 },
      { name: "get_inventory", ok: false, round: 1 },
    ]);
    expect(result.toolCalls[1]!.error).toBe("Tham số không hợp lệ");

    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    const toolResults = result.messages[2]!.content as unknown as Array<Record<string, unknown>>;
    expect(toolResults[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    expect(toolResults[0]!["is_error"]).toBeUndefined();
    expect(JSON.parse(toolResults[0]!["content"] as string)).toMatchObject({
      as_of: "2026-10-30T14:00:00",
      current: { revenue: 22_900_000 },
    });
    expect(toolResults[1]).toMatchObject({ tool_use_id: "toolu_2", is_error: true });
  });

  it("tham số gửi Claude: mô hình, effort, dự phòng, cache; không ép tool, không tắt thinking", async () => {
    const fake = fakeClaude([reply("Chào bạn.")]);
    await askAgent({ access: CHAIN, question: "Xin chào", now: NOW, client: fake.client });
    const params = fake.calls[0]!;
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16_000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    });
    expect(params.tools).toHaveLength(16);
    expect(params).not.toHaveProperty("tool_choice");
    expect(params).not.toHaveProperty("thinking");
  });

  it("system và tool giống hệt giữa người dùng, thời điểm; bối cảnh nằm trong tin nhắn", async () => {
    const first = fakeClaude([reply("a")]);
    const second = fakeClaude([reply("b")]);
    await askAgent({ access: CHAIN, question: "Q", now: NOW, client: first.client });
    await askAgent({
      access: NT01_SALES_ONLY,
      question: "Q",
      now: new Date("2026-11-02T01:00:00Z"),
      client: second.client,
    });
    const prefix = (params: MessageCreateParamsNonStreaming) =>
      JSON.stringify({ tools: params.tools, system: params.system });
    expect(prefix(first.calls[0]!)).toBe(prefix(second.calls[0]!));

    const chainTurn = first.calls[0]!.messages[0]!.content as string;
    expect(chainTurn).toContain("14:05");
    expect(chainTurn).toContain("Phạm vi mặc định: ALL");
    const storeTurn = second.calls[0]!.messages[0]!.content as string;
    expect(storeTurn).toContain("chỉ các cửa hàng NT01");
    expect(storeTurn).toContain("Được xem tồn kho, hạn dùng: không được xem");
    expect(storeTurn).toContain("Phạm vi mặc định: NT01");
    expect(storeTurn.endsWith("\n\nQ")).toBe(true);
  });

  it("câu hỏi tiếp theo: lịch sử cũ gửi lại nguyên vẹn, chỉ thêm vào cuối", async () => {
    const first = await askAgent({
      access: CHAIN,
      question: "Doanh thu hôm nay?",
      now: NOW,
      client: fakeClaude([
        callTools(toolUse("get_revenue", { store: "ALL", period: "day" })),
        reply("22,9 triệu đ"),
      ]).client,
    });
    const saved = structuredClone(first.messages);
    const fake = fakeClaude([reply("Tuần này ...")]);
    const second = await askAgent({
      access: CHAIN,
      question: "Còn tuần này?",
      history: first.messages,
      now: NOW,
      client: fake.client,
    });
    expect(fake.calls[0]!.messages.slice(0, saved.length)).toEqual(saved);
    expect(second.messages.slice(0, saved.length)).toEqual(saved);
    expect(second.messages).toHaveLength(saved.length + 2);
  });

  it("quyền của người hỏi áp vào tool: hỏi toàn chuỗi khi chỉ xem NT01 thì tool báo lỗi để Claude giải thích", async () => {
    const fake = fakeClaude([
      callTools(toolUse("get_revenue", { store: "ALL", period: "day" })),
      reply("Bạn không được xem số liệu toàn chuỗi."),
    ]);
    const result = await askAgent({
      access: NT01_SALES_ONLY,
      question: "Doanh thu cả chuỗi?",
      client: fake.client,
    });
    const toolResult = (
      fake.calls[1]!.messages[2]!.content as unknown as Array<Record<string, unknown>>
    )[0]!;
    expect(toolResult["is_error"]).toBe(true);
    expect(JSON.parse(toolResult["content"] as string)).toEqual({
      error: "Bạn không được xem số liệu toàn chuỗi",
      code: "FORBIDDEN",
    });
    expect(result.status).toBe("answered");
  });
});

describe("giới hạn", () => {
  it(`tối đa ${AGENT_LIMITS.rounds} vòng: nhắc ở vòng áp chót, vòng cuối không chạy tool`, async () => {
    const fake = fakeClaude([
      () => callTools(toolUse("get_revenue", { store: "ALL", period: "day" })),
    ]);
    const result = await askAgent({ access: CHAIN, question: "Lặp mãi", client: fake.client });
    expect(fake.calls).toHaveLength(AGENT_LIMITS.rounds);
    expect(result).toMatchObject({ status: "round_limit", answer: null, rounds: 6 });
    expect(result.toolCalls).toHaveLength(AGENT_LIMITS.rounds - 1);

    const hint = fake.calls[5]!.messages.at(-1)!.content as unknown as Array<
      Record<string, unknown>
    >;
    expect(hint.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("lượt cuối") });
    // Lịch sử vẫn hợp lệ: tool_use cuối có tool_result (báo không chạy).
    const last = result.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect((last.content as unknown as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "tool_result",
      is_error: true,
    });
  });

  it(`tối đa ${AGENT_LIMITS.toolCalls} lần gọi tool mỗi câu hỏi`, async () => {
    const many = Array.from({ length: 25 }, () => toolUse("get_data_quality", {}));
    stub.respond("data-quality", 200, { as_of: "x", summary: {}, total: 0 });
    const fake = fakeClaude([callTools(...many), reply("xong")]);
    const result = await askAgent({ access: CHAIN, question: "Nhiều tool", client: fake.client });
    expect(result.toolCalls).toHaveLength(20);
    const results = fake.calls[1]!.messages[2]!.content as unknown as Array<
      Record<string, unknown>
    >;
    expect(results).toHaveLength(25);
    expect(results.filter((block) => block["is_error"])).toHaveLength(5);
  });

  it("hết giờ: dừng, không có câu trả lời", async () => {
    const client: AgentClient = {
      create: (_params, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError())),
        ),
    };
    const result = await askAgent({ access: CHAIN, question: "Chậm", client, timeoutMs: 50 });
    expect(result).toMatchObject({ status: "timeout", answer: null, rounds: 1 });
    expect(result.messages).toHaveLength(1);
  });

  it("bị từ chối, bị cắt: không lưu lượt dở dang, không chạy tool", async () => {
    const refused = await askAgent({
      access: CHAIN,
      question: "x",
      client: fakeClaude([{ stop_reason: "refusal", content: [] }]).client,
    });
    expect(refused).toMatchObject({ status: "refused", answer: null });
    expect(refused.messages).toHaveLength(1);

    const truncated = await askAgent({
      access: CHAIN,
      question: "x",
      client: fakeClaude([
        { stop_reason: "max_tokens", content: [toolUse("get_revenue", { store: "A" })] },
      ]).client,
    });
    expect(truncated).toMatchObject({ status: "truncated", toolCalls: [] });
  });

  it("Claude API lỗi: trả trạng thái, không ném lỗi", async () => {
    const client: AgentClient = {
      create: () =>
        Promise.reject(
          new Anthropic.InternalServerError(529, { type: "error" }, "Overloaded", new Headers()),
        ),
    };
    const result = await askAgent({ access: CHAIN, question: "x", client });
    expect(result.status).toBe("unavailable");
    expect(result.error).toContain("529");
  });

  it("chưa có API key, câu hỏi trống hoặc quá dài: từ chối trước khi gọi Claude", async () => {
    await expect(askAgent({ access: CHAIN, question: "x", client: null })).rejects.toMatchObject({
      status: 503,
      code: "AI_DISABLED",
    });
    const fake = fakeClaude([reply("x")]);
    await expect(
      askAgent({ access: CHAIN, question: "   ", client: fake.client }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      askAgent({ access: CHAIN, question: "a".repeat(1_001), client: fake.client }),
    ).rejects.toMatchObject({ status: 422 });
    expect(fake.calls).toHaveLength(0);
  });

  it("chi phí: mô hình lạ thì không đoán giá", () => {
    const usage = { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costUsd("claude-opus-5-5", usage)).toBe(4);
    expect(costUsd("mo-hinh-khac", usage)).toBeNull();
  });
});

describe("đối chiếu số (D16)", () => {
  const revenueCall = () => callTools(toolUse("get_revenue", { store: "ALL", period: "day" }));

  it("số khớp: trả lời ngay, ghi kết quả đối chiếu", async () => {
    const fake = fakeClaude([
      revenueCall(),
      reply("Hôm nay 22,9 triệu đ, 31 đơn (số liệu lúc 14:00)."),
    ]);
    const result = await askAgent({
      access: CHAIN,
      question: "Doanh thu?",
      now: NOW,
      client: fake.client,
    });
    expect(result).toMatchObject({
      status: "answered",
      verification: { checked: 3, unverified: [], retried: false },
    });
    expect(fake.calls).toHaveLength(2);
  });

  it("số sai: yêu cầu sửa một lần, sửa đúng thì trả lời", async () => {
    const fake = fakeClaude([
      revenueCall(),
      reply("Hôm nay 25 triệu đ, tăng 12%."),
      reply("Hôm nay 22,9 triệu đ."),
    ]);
    const result = await askAgent({
      access: CHAIN,
      question: "Doanh thu?",
      now: NOW,
      client: fake.client,
    });
    expect(result).toMatchObject({
      status: "answered",
      answer: "Hôm nay 22,9 triệu đ.",
      verification: { unverified: [], retried: true },
    });
    const correction = fake.calls[2]!.messages.at(-1)!;
    expect(correction.role).toBe("user");
    expect(JSON.stringify(correction.content)).toContain("25 triệu; 12%");
    // Lịch sử giữ cả câu sai và lời nhắc (chỉ thêm), câu trả lời đúng ở cuối.
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("vẫn sai sau khi sửa: chặn, không trả câu trả lời, không lưu lượt này", async () => {
    const history: BetaMessageParam[] = [
      { role: "user", content: "Câu trước" },
      { role: "assistant", content: [text("Trả lời trước")] as never },
    ];
    const fake = fakeClaude([
      revenueCall(),
      reply("Hôm nay 25 triệu đ."),
      reply("Khoảng 25 triệu đ."),
    ]);
    const result = await askAgent({
      access: CHAIN,
      question: "Doanh thu?",
      history,
      now: NOW,
      client: fake.client,
    });
    expect(result).toMatchObject({
      status: "blocked",
      answer: null,
      verification: { unverified: ["25 triệu"], retried: true },
      error: "Số không kiểm chứng được: 25 triệu",
    });
    expect(result.messages).toEqual(history);
    expect(fake.calls).toHaveLength(3);
  });

  it("trả lời có số mà không gọi tool nào: phải sửa", async () => {
    const fake = fakeClaude([
      reply("Doanh thu hôm nay khoảng 30 triệu đ."),
      revenueCall(),
      reply("Hôm nay 22,9 triệu đ."),
    ]);
    const result = await askAgent({
      access: CHAIN,
      question: "Doanh thu?",
      now: NOW,
      client: fake.client,
    });
    expect(result).toMatchObject({ status: "answered", answer: "Hôm nay 22,9 triệu đ." });
    expect(result.toolCalls).toHaveLength(1);
  });
});
