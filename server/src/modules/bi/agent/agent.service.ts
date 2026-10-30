import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { prisma } from "../../../db/prisma.js";
import { AppError } from "../../../lib/app-error.js";
import type { AuthContext } from "../../auth/auth.context.js";
import { biAccess, resolveStore } from "../bi.service.js";
import {
  AGENT_LIMITS,
  BLOCKED_ANSWER,
  askAgent,
  claudeClient,
  type AgentResult,
  type AgentStatus,
} from "./agent.js";

/**
 * Hỏi đáp với AI Agent qua `POST /api/v1/bi/ask` (Phase 4, bước 4.4).
 *
 * - Giới hạn: 30 câu mỗi người mỗi giờ (đếm trên nhật ký, kể cả câu lỗi), một câu
 *   đang chạy mỗi người. Chỉ gọi Claude khi người dùng gửi câu hỏi.
 * - Hội thoại lưu phía server, chỉ thêm, tối đa 10 câu, hết hạn 24 giờ sau khi tạo.
 *   Chỉ người tạo mới đọc, hỏi tiếp được.
 * - Mỗi câu hỏi ghi một dòng `ai_agent_logs`: câu hỏi, trạng thái, câu trả lời, tool
 *   đã gọi (tên, tham số, lỗi; không lưu số liệu trả về), đối chiếu số, token, chi phí.
 */

export const AGENT_POLICY = {
  questionsPerHour: 30,
  conversationTurns: 10,
  conversationTtlMs: 24 * 60 * 60 * 1000,
} as const;

const HOUR_MS = 60 * 60 * 1000;

/** Lời hiện cho người dùng khi không có câu trả lời của Claude. */
const NOTICES: Record<Exclude<AgentStatus, "answered">, string> = {
  blocked: BLOCKED_ANSWER,
  round_limit: "Câu hỏi cần quá nhiều bước tra cứu. Hãy hỏi cụ thể hơn hoặc tách thành nhiều câu.",
  timeout: "Trợ lý trả lời quá 60 giây. Hãy thử lại hoặc hỏi ngắn gọn hơn.",
  refused: "Trợ lý không trả lời câu hỏi này.",
  truncated: "Câu trả lời quá dài. Hãy hỏi cụ thể hơn.",
  unavailable: "Không kết nối được dịch vụ AI. Hãy thử lại sau ít phút.",
};

/** Một người chỉ chạy một câu một lúc: tránh hai câu cùng nối vào một hội thoại. */
const inFlight = new Set<string>();

async function questionsLastHour(userId: string, now: Date) {
  const since = new Date(now.getTime() - HOUR_MS);
  const rows = await prisma.aiAgentLog.findMany({
    where: { userId, occurredAt: { gte: since } },
    select: { occurredAt: true },
    orderBy: { occurredAt: "asc" },
  });
  return { count: rows.length, oldest: rows[0]?.occurredAt ?? null };
}

export async function agentStatus(auth: AuthContext) {
  const used = await questionsLastHour(auth.userId, new Date());
  return {
    enabled: claudeClient() !== null,
    limits: {
      questionsPerHour: AGENT_POLICY.questionsPerHour,
      remainingThisHour: Math.max(AGENT_POLICY.questionsPerHour - used.count, 0),
      conversationTurns: AGENT_POLICY.conversationTurns,
      questionChars: AGENT_LIMITS.questionChars,
      timeoutSeconds: AGENT_LIMITS.timeoutMs / 1000,
    },
  };
}

const timeFormat = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

async function loadConversation(userId: string, id: string, now: Date) {
  const conversation = await prisma.aiAgentConversation.findUnique({ where: { id } });
  if (!conversation || conversation.userId !== userId) {
    throw new AppError(404, "NOT_FOUND", "Không tìm thấy hội thoại");
  }
  if (conversation.expiresAt <= now) {
    throw new AppError(
      409,
      "CONVERSATION_EXPIRED",
      "Hội thoại đã quá 24 giờ, hãy bắt đầu hội thoại mới",
    );
  }
  if (conversation.turns >= AGENT_POLICY.conversationTurns) {
    throw new AppError(
      409,
      "CONVERSATION_FULL",
      `Hội thoại đã đủ ${AGENT_POLICY.conversationTurns} câu hỏi, hãy bắt đầu hội thoại mới`,
    );
  }
  return conversation;
}

type LogInput = {
  userId: string;
  conversationId: string | null;
  question: string;
  status: AgentStatus | "error";
  result?: AgentResult;
  error?: string;
};

function logData(input: LogInput) {
  const result = input.result;
  return {
    userId: input.userId,
    conversationId: input.conversationId,
    question: input.question,
    status: input.status,
    answer: result?.answer ?? null,
    toolCalls: (result?.toolCalls ?? []) as object[],
    verification: result?.verification ?? undefined,
    rounds: result?.rounds ?? 0,
    model: result?.model ?? null,
    inputTokens: result?.usage.inputTokens ?? 0,
    outputTokens: result?.usage.outputTokens ?? 0,
    cacheReadTokens: result?.usage.cacheReadTokens ?? 0,
    cacheWriteTokens: result?.usage.cacheWriteTokens ?? 0,
    costUsd: result?.costUsd ?? null,
    durationMs: result?.durationMs ?? 0,
    error: input.error ?? result?.error ?? null,
  };
}

export async function askQuestion(
  auth: AuthContext,
  body: { question: string; conversationId?: string | undefined; store?: string | undefined },
) {
  const now = new Date();
  if (!claudeClient()) {
    throw new AppError(503, "AI_DISABLED", "Chưa cấu hình ANTHROPIC_API_KEY cho trợ lý AI");
  }
  if (inFlight.has(auth.userId)) {
    throw new AppError(409, "AGENT_BUSY", "Trợ lý đang trả lời câu trước của bạn, hãy đợi xong");
  }
  const used = await questionsLastHour(auth.userId, now);
  if (used.count >= AGENT_POLICY.questionsPerHour) {
    const retryAt = new Date((used.oldest ?? now).getTime() + HOUR_MS);
    throw new AppError(
      429,
      "RATE_LIMITED",
      `Bạn đã hỏi ${AGENT_POLICY.questionsPerHour} câu trong 1 giờ qua, hãy thử lại sau ${timeFormat.format(retryAt)}`,
    );
  }
  const existing = body.conversationId
    ? await loadConversation(auth.userId, body.conversationId, now)
    : null;

  inFlight.add(auth.userId);
  try {
    // Dọn hội thoại hết hạn (nhật ký giữ lại, conversation_id thành null).
    await prisma.aiAgentConversation.deleteMany({ where: { expiresAt: { lt: now } } });
    const access = await biAccess(auth);
    const scope = body.store ? resolveStore(access, body.store) : undefined;
    let result: AgentResult;
    try {
      result = await askAgent({
        access,
        question: body.question,
        history: (existing?.messages ?? []) as unknown as BetaMessageParam[],
        now,
        ...(scope ? { scope } : {}),
      });
    } catch (error) {
      if (error instanceof AppError && error.status < 500) throw error;
      // Lỗi ngoài dự kiến vẫn ghi nhật ký (và vẫn tính vào giới hạn) trước khi báo lỗi.
      await prisma.aiAgentLog.create({
        data: logData({
          userId: auth.userId,
          conversationId: existing?.id ?? null,
          question: body.question.trim(),
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        }),
      });
      throw error;
    }

    const { conversation, log } = await prisma.$transaction(async (tx) => {
      let saved;
      if (existing) {
        // Chỉ ghi nếu không ai nối thêm vào hội thoại trong lúc chờ Claude.
        const updated = await tx.aiAgentConversation.updateMany({
          where: { id: existing.id, turns: existing.turns },
          data: { messages: result.messages as object[], turns: existing.turns + 1 },
        });
        if (updated.count === 0) {
          throw new AppError(409, "CONFLICT", "Hội thoại vừa thay đổi, hãy tải lại");
        }
        saved = await tx.aiAgentConversation.findUniqueOrThrow({
          where: { id: existing.id },
          select: { id: true, turns: true, expiresAt: true },
        });
      } else {
        saved = await tx.aiAgentConversation.create({
          data: {
            userId: auth.userId,
            messages: result.messages as object[],
            turns: 1,
            expiresAt: new Date(now.getTime() + AGENT_POLICY.conversationTtlMs),
          },
          select: { id: true, turns: true, expiresAt: true },
        });
      }
      const entry = await tx.aiAgentLog.create({
        data: logData({
          userId: auth.userId,
          conversationId: saved.id,
          question: body.question.trim(),
          status: result.status,
          result,
        }),
        select: { id: true },
      });
      return { conversation: saved, log: entry };
    });

    return {
      logId: log.id.toString(),
      conversationId: conversation.id,
      status: result.status,
      answer: result.status === "answered" ? result.answer : null,
      notice: result.status === "answered" ? null : NOTICES[result.status],
      verification: result.verification,
      toolCalls: result.toolCalls.map(({ name, input, ok, durationMs, error }) => ({
        name,
        input,
        ok,
        durationMs,
        ...(error ? { error } : {}),
      })),
      rounds: result.rounds,
      model: result.model,
      durationMs: result.durationMs,
      usage: result.usage,
      costUsd: result.costUsd,
      conversation: {
        turns: conversation.turns,
        maxTurns: AGENT_POLICY.conversationTurns,
        expiresAt: conversation.expiresAt,
      },
      remainingThisHour: Math.max(AGENT_POLICY.questionsPerHour - used.count - 1, 0),
    };
  } finally {
    inFlight.delete(auth.userId);
  }
}
