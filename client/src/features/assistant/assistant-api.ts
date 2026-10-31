import { getAccessToken, http, refreshAccessToken, setAccessToken } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";
import {
  toolCallLabel,
  type AgentStatus,
  type AgentToolCall,
  type AgentVerification,
} from "../bi/bi-api.js";

/**
 * Trợ lý AI kiểu hội thoại (Phase 6, bước 6.4): lịch sử hội thoại, hỏi có tiến trình
 * (Server-Sent Events), biểu đồ dựng từ kết quả tool. Contract: §20.2 (`/bi/ask/*`).
 */

export type ChartFormat = "currency" | "number" | "percent";

/** Biểu đồ máy chủ dựng từ kết quả tool đã lọc quyền: số không do mô hình đưa ra. */
export type AnswerChart =
  | {
      kind: "line";
      title: string;
      labels: string[];
      series: Array<{ name: string; values: Array<number | null>; dashed?: boolean }>;
      band?: { low: Array<number | null>; high: Array<number | null> };
      valueFormat: ChartFormat;
    }
  | {
      kind: "bars";
      title: string;
      bars: Array<{ label: string; value: number; share: number | null }>;
      valueFormat: ChartFormat;
    };

/** Một lượt hỏi đáp, như máy chủ lưu trong nhật ký. */
export type AssistantTurn = {
  logId: string;
  occurredAt: string;
  question: string;
  status: AgentStatus | "error";
  answer: string | null;
  notice: string | null;
  detail: string | null;
  verification: AgentVerification | null;
  toolCalls: AgentToolCall[];
  charts: AnswerChart[];
  costUsd: number | null;
  durationMs: number;
};

export type ConversationInfo = {
  id: string;
  title: string;
  turns: number;
  maxTurns: number;
  updatedAt: string;
  expiresAt: string;
};

export type ConversationDetail = ConversationInfo & { messages: AssistantTurn[] };

export type AskResult = AssistantTurn & {
  conversationId: string;
  conversation: { title: string; turns: number; maxTurns: number; expiresAt: string };
  remainingThisHour: number;
};

export type AskProgress =
  | { type: "thinking"; round: number }
  | { type: "tool_start"; round: number; name: string; input: Record<string, unknown> }
  | { type: "tool_done"; round: number; name: string; ok: boolean; durationMs: number }
  | { type: "verifying"; round: number }
  | { type: "correcting"; round: number };

/** Lỗi trả về giữa luồng (từ chối, hết ngân sách, giới hạn…): giữ mã để giao diện xử lý. */
export class AskError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AskError";
    this.status = status;
    this.code = code;
  }
}

export const assistantApi = {
  conversations: async () =>
    (await http.get<Envelope<{ items: ConversationInfo[] }>>("/bi/ask/conversations")).data.data
      .items,
  conversation: async (id: string) =>
    (await http.get<Envelope<ConversationDetail>>(`/bi/ask/conversations/${id}`)).data.data,
  rename: async (id: string, title: string) =>
    (await http.patch<Envelope<ConversationInfo>>(`/bi/ask/conversations/${id}`, { title })).data
      .data,
  remove: async (id: string) => {
    await http.delete(`/bi/ask/conversations/${id}`);
  },
  /** Hỏi về một tệp Excel/CSV đính kèm (bước 6.6): máy chủ tự tính, trả về một lượt trả lời. */
  askFile: async (body: { file: File; question: string; conversationId?: string }) => {
    const form = new FormData();
    form.append("file", body.file);
    form.append("question", body.question);
    if (body.conversationId) form.append("conversationId", body.conversationId);
    return (await http.post<Envelope<AskResult>>("/bi/ask/file", form)).data.data;
  },
};

/** Tách luồng Server-Sent Events thành từng sự kiện `event` + `data`. */
export function parseEvents(buffer: string): {
  events: Array<{ event: string; data: unknown }>;
  rest: string;
} {
  const chunks = buffer.split("\n\n");
  const rest = chunks.pop() ?? "";
  const events = chunks.flatMap((chunk) => {
    let event = "message";
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return [];
    try {
      return [{ event, data: JSON.parse(data.join("\n")) as unknown }];
    } catch {
      return [];
    }
  });
  return { events, rest };
}

async function openStream(body: object, signal?: AbortSignal): Promise<Response> {
  const send = () =>
    fetch("/api/v1/bi/ask/stream", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {}),
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  let response = await send();
  // Token hết hạn: làm mới một lần rồi gửi lại, như các request axios.
  if (response.status === 401) {
    setAccessToken(await refreshAccessToken());
    response = await send();
  }
  return response;
}

/**
 * Hỏi trợ lý, nhận tiến trình qua `onProgress`. Trả kết quả cuối; lỗi nghiệp vụ ném `AskError`.
 */
export async function askStream(
  body: { question: string; conversationId?: string; store?: string },
  onProgress: (event: AskProgress) => void,
  signal?: AbortSignal,
): Promise<AskResult> {
  const response = await openStream(body, signal);
  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new AskError(
      response.status,
      payload?.error?.code ?? "HTTP_ERROR",
      payload?.error?.message ?? "Không gửi được câu hỏi",
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const { events, rest } = parseEvents(done ? `${buffer}\n\n` : buffer);
    buffer = rest;
    for (const { event, data } of events) {
      if (event === "progress") onProgress(data as AskProgress);
      else if (event === "result") return data as AskResult;
      else if (event === "error") {
        const error = data as { status: number; code: string; message: string };
        throw new AskError(error.status, error.code, error.message);
      }
    }
    if (done) break;
  }
  throw new AskError(502, "STREAM_CLOSED", "Mất kết nối trước khi nhận được câu trả lời");
}

/** Dòng tiến trình dễ đọc: "Đang tra: Doanh thu · toàn chuỗi · hôm nay". */
export function progressText(event: AskProgress): string {
  switch (event.type) {
    case "thinking":
      return event.round === 1 ? "Đang đọc câu hỏi" : "Đang tổng hợp câu trả lời";
    case "tool_start":
      return `Đang tra: ${toolCallLabel(event)}`;
    case "tool_done":
      return `${event.ok ? "Đã tra" : "Không tra được"}: ${toolCallLabel({ name: event.name, input: {} })}`;
    case "verifying":
      return "Đang đối chiếu số liệu";
    case "correcting":
      return "Có số chưa khớp, đang yêu cầu sửa";
  }
}

const DAY_MS = 86_400_000;

/** Nhóm lịch sử như Claude: Hôm nay, Hôm qua, 7 ngày qua, 30 ngày qua. */
export function groupConversations(
  items: ConversationInfo[],
  now = new Date(),
): Array<{ label: string; items: ConversationInfo[] }> {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const groups = [
    { label: "Hôm nay", from: startOfToday.getTime() },
    { label: "Hôm qua", from: startOfToday.getTime() - DAY_MS },
    { label: "7 ngày qua", from: startOfToday.getTime() - 7 * DAY_MS },
    { label: "30 ngày qua", from: Number.NEGATIVE_INFINITY },
  ];
  return groups
    .map((group, index) => ({
      label: group.label,
      items: items.filter((item) => {
        const at = new Date(item.updatedAt).getTime();
        const upper = index === 0 ? Number.POSITIVE_INFINITY : groups[index - 1]!.from;
        return at >= group.from && at < upper;
      }),
    }))
    .filter((group) => group.items.length > 0);
}
