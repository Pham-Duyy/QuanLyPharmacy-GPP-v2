import type {
  BetaContentBlock,
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../../db/prisma.js";
import { startAnalyticsStub, type AnalyticsStub } from "../../../test/analytics-stub-server.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  useTestRole,
  type Fixture,
} from "../../../test/helpers.js";
import { BLOCKED_ANSWER, overrideAgentClient, type AgentClient } from "./agent.js";

/**
 * `POST /api/v1/bi/ask` (bước 4.4): nhật ký, giới hạn tần suất, hội thoại. Claude giả,
 * không gọi API thật.
 */

type Step = { stop_reason: BetaMessage["stop_reason"]; content: BetaContentBlock[] };

const text = (value: string) =>
  ({ type: "text", text: value, citations: null }) as BetaContentBlock;
const reply = (value: string): Step => ({ stop_reason: "end_turn", content: [text(value)] });
let toolId = 0;
const revenueCall = (): Step => ({
  stop_reason: "tool_use",
  content: [
    {
      type: "tool_use",
      id: `toolu_${++toolId}`,
      name: "get_revenue",
      input: { store: "ALL", period: "day" },
    } as BetaContentBlock,
  ],
});

function fakeClaude(steps: Step[]) {
  const calls: MessageCreateParamsNonStreaming[] = [];
  const client: AgentClient = {
    async create(params) {
      calls.push(structuredClone(params));
      const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
      return {
        id: `msg_${calls.length}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        stop_sequence: null,
        usage: {
          input_tokens: 1_000,
          output_tokens: 200,
          cache_read_input_tokens: 4_000,
          cache_creation_input_tokens: 0,
        },
        ...step,
      } as BetaMessage;
    },
  };
  overrideAgentClient(client);
  return calls;
}

let stub: AnalyticsStub;
let fixture: Fixture;
let adminToken: string;

beforeAll(async () => {
  stub = await startAnalyticsStub({
    revenue: {
      version: 1,
      as_of: "2026-10-30T14:00:00",
      store: "ALL",
      period: "day",
      current: { revenue: 22_900_000, orders: 31 },
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
});

afterEach(() => overrideAgentClient(undefined));

const ask = (token: string, body: object) =>
  api().post("/api/v1/bi/ask").set(authHeaders(token)).send(body);

describe("POST /api/v1/bi/ask", () => {
  it("trả lời, lưu hội thoại và nhật ký (không lưu số liệu tool trả về)", async () => {
    fakeClaude([revenueCall(), reply("Hôm nay 22,9 triệu đ.")]);
    const response = await ask(adminToken, { question: " Doanh thu hôm nay? " });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "answered",
      answer: "Hôm nay 22,9 triệu đ.",
      notice: null,
      verification: { unverified: [], retried: false },
      toolCalls: [{ name: "get_revenue", input: { store: "ALL", period: "day" }, ok: true }],
      rounds: 2,
      model: "claude-opus-5-5",
      conversation: { turns: 1, maxTurns: 10 },
      remainingThisHour: 29,
    });
    // 2 vòng × (1.000×4 + 200×20 + 4.000×0,2) = 17.600 phần triệu USD.
    expect(response.body.data.costUsd).toBeCloseTo(0.0176, 6);

    const log = await prisma.aiAgentLog.findFirstOrThrow();
    expect(log).toMatchObject({
      userId: fixture.adminId,
      conversationId: response.body.data.conversationId,
      question: "Doanh thu hôm nay?",
      status: "answered",
      answer: "Hôm nay 22,9 triệu đ.",
      rounds: 2,
      inputTokens: 2_000,
      outputTokens: 400,
      cacheReadTokens: 8_000,
      error: null,
    });
    expect(Number(log.costUsd)).toBeCloseTo(0.0176, 6);
    expect(JSON.stringify(log.toolCalls)).not.toContain("22900000");

    const conversation = await prisma.aiAgentConversation.findFirstOrThrow();
    expect(conversation.turns).toBe(1);
    expect(conversation.messages).toHaveLength(4);
    expect(conversation.expiresAt.getTime() - conversation.createdAt.getTime()).toBeCloseTo(
      24 * 3600 * 1000,
      -4,
    );
  });

  it("hỏi tiếp: gửi lại lịch sử đã lưu, chỉ thêm vào cuối", async () => {
    fakeClaude([revenueCall(), reply("Hôm nay 22,9 triệu đ.")]);
    const first = await ask(adminToken, { question: "Doanh thu hôm nay?" });
    const conversationId = first.body.data.conversationId as string;
    const saved = (
      await prisma.aiAgentConversation.findUniqueOrThrow({ where: { id: conversationId } })
    ).messages as unknown[];

    const calls = fakeClaude([reply("Vẫn là 22,9 triệu đ.")]);
    const second = await ask(adminToken, { question: "Còn bây giờ?", conversationId });
    expect(second.status).toBe(200);
    expect(second.body.data.conversation.turns).toBe(2);
    expect(calls[0]!.messages.slice(0, saved.length)).toEqual(saved);
    expect(calls[0]!.messages).toHaveLength(saved.length + 1);
  });

  it("hội thoại của người khác, hết hạn, đã đủ 10 câu: không hỏi tiếp được", async () => {
    fakeClaude([reply("Xin chào.")]);
    const first = await ask(adminToken, { question: "Chào" });
    const conversationId = first.body.data.conversationId as string;

    await useTestRole(fixture.pharmacistId, "auditor", fixture.storeId);
    const other = (await login("duocsi")).token;
    expect((await ask(other, { question: "x", conversationId })).status).toBe(404);

    await prisma.aiAgentConversation.update({ where: { id: conversationId }, data: { turns: 10 } });
    const full = await ask(adminToken, { question: "x", conversationId });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("CONVERSATION_FULL");

    await prisma.aiAgentConversation.update({
      where: { id: conversationId },
      data: { turns: 1, expiresAt: new Date(Date.now() - 1_000) },
    });
    const expired = await ask(adminToken, { question: "x", conversationId });
    expect(expired.body.error.code).toBe("CONVERSATION_EXPIRED");

    // Câu hỏi mới dọn hội thoại hết hạn; nhật ký giữ lại.
    await ask(adminToken, { question: "Chào lại" });
    expect(await prisma.aiAgentConversation.count({ where: { id: conversationId } })).toBe(0);
    expect(await prisma.aiAgentLog.count()).toBe(2);
  });

  it("cửa hàng đang xem làm phạm vi mặc định, kiểm theo quyền", async () => {
    const calls = fakeClaude([reply("ok")]);
    expect((await ask(adminToken, { question: "Doanh thu?", store: "nt02" })).status).toBe(200);
    expect(calls[0]!.messages[0]!.content).toContain("Phạm vi mặc định: NT02");

    await useTestRole(fixture.pharmacistId, "auditor", fixture.storeId);
    const viewer = (await login("duocsi")).token;
    expect((await ask(viewer, { question: "x", store: "NT02" })).status).toBe(403);
    expect((await ask(viewer, { question: "x", store: "ALL" })).status).toBe(403);
    expect((await ask(viewer, { question: "x", store: "NT01" })).status).toBe(200);
  });

  it("giới hạn 30 câu mỗi giờ, đếm cả câu lỗi", async () => {
    const calls = fakeClaude([reply("ok")]);
    await prisma.aiAgentLog.createMany({
      data: Array.from({ length: 30 }, (_, index) => ({
        userId: fixture.adminId,
        question: `q${index}`,
        status: index % 2 ? "answered" : "error",
        occurredAt: new Date(Date.now() - (59 - index) * 60_000),
      })),
    });
    const limited = await ask(adminToken, { question: "Thêm một câu" });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(limited.body.error.message).toContain("thử lại sau");
    expect(calls).toHaveLength(0);

    const status = await api().get("/api/v1/bi/ask/status").set(authHeaders(adminToken));
    expect(status.body.data).toMatchObject({
      enabled: true,
      limits: { questionsPerHour: 30, remainingThisHour: 0, conversationTurns: 10 },
    });

    // Câu cũ hơn 1 giờ không tính.
    await prisma.aiAgentLog.updateMany({
      data: { occurredAt: new Date(Date.now() - 2 * 3600_000) },
    });
    expect((await ask(adminToken, { question: "Thêm một câu" })).status).toBe(200);
  });

  it("bị chặn vì số không kiểm chứng được: hiện câu cố định, không lưu lượt vào hội thoại", async () => {
    fakeClaude([revenueCall(), reply("Hôm nay 25 triệu đ."), reply("Khoảng 25 triệu đ.")]);
    const response = await ask(adminToken, { question: "Doanh thu?" });
    expect(response.body.data).toMatchObject({
      status: "blocked",
      answer: null,
      notice: BLOCKED_ANSWER,
      verification: { unverified: ["25 triệu"], retried: true },
    });
    const conversation = await prisma.aiAgentConversation.findFirstOrThrow();
    expect(conversation.messages).toEqual([]);
    const log = await prisma.aiAgentLog.findFirstOrThrow();
    expect(log).toMatchObject({ status: "blocked", error: "Số không kiểm chứng được: 25 triệu" });
    expect(log.answer).toBeNull();
  });

  it("lỗi ngoài dự kiến: 500, vẫn ghi nhật ký", async () => {
    overrideAgentClient({ create: () => Promise.reject(new Error("hỏng mạng nội bộ")) });
    const response = await ask(adminToken, { question: "Doanh thu?" });
    expect(response.status).toBe(500);
    expect(await prisma.aiAgentLog.findFirstOrThrow()).toMatchObject({
      status: "error",
      error: "hỏng mạng nội bộ",
    });
  });

  it("chưa cấu hình khóa, tham số sai, không có quyền báo cáo", async () => {
    overrideAgentClient(null);
    const disabled = await ask(adminToken, { question: "x" });
    expect(disabled.status).toBe(503);
    expect(disabled.body.error.code).toBe("AI_DISABLED");
    const status = await api().get("/api/v1/bi/ask/status").set(authHeaders(adminToken));
    expect(status.body.data.enabled).toBe(false);

    fakeClaude([reply("x")]);
    expect((await ask(adminToken, { question: "   " })).status).toBe(422);
    expect((await ask(adminToken, { question: "a".repeat(1_001) })).status).toBe(422);
    expect((await ask(adminToken, { question: "x", conversationId: "abc" })).status).toBe(422);
    expect((await api().post("/api/v1/bi/ask").send({ question: "x" })).status).toBe(401);

    const sales = (await login("banhang")).token;
    expect((await ask(sales, { question: "x" })).status).toBe(403);
    expect(await prisma.aiAgentLog.count()).toBe(0);
  });
});

describe("lý do không gọi được Claude", () => {
  it("giải thích lỗi thường gặp, không lộ khóa", async () => {
    const { explainAgentError } = await import("./agent.service.js");
    expect(explainAgentError("Claude API lỗi 401: invalid x-api-key")).toContain(
      "API key không hợp lệ",
    );
    expect(explainAgentError("Claude API lỗi 400: Your credit balance is too low")).toContain(
      "chưa đủ tiền",
    );
    expect(explainAgentError("Claude API lỗi 529: Overloaded")).toContain("quá tải");
    expect(explainAgentError("Claude API lỗi 418: lạ")).toBe("lạ");
    expect(explainAgentError(undefined)).toBeNull();
  });
});
