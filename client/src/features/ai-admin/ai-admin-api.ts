import { http } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";
import type { AiBudget } from "../bi/bi-api.js";

/**
 * Quản trị Phân tích & AI (Phase 6, bước 6.5, D27): cấu hình trợ lý AI (`/bi/ai/settings`,
 * cần settings.manage toàn chuỗi) và nhật ký AI (`/bi/ai/logs`, cần audit.read toàn chuỗi).
 */

export type AiSettings = { enabled: boolean; questionsPerHour: number; monthlyBudgetUsd: number };

export type AiSettingsView = {
  settings: AiSettings;
  isDefault: boolean;
  updatedAt: string | null;
  budget: AiBudget;
};

export type AiLogStatus =
  | "answered"
  | "blocked"
  | "round_limit"
  | "timeout"
  | "refused"
  | "truncated"
  | "unavailable"
  | "error";

export type AiLogItem = {
  id: string;
  occurredAt: string;
  user: { id: string; fullName: string };
  conversationId: string | null;
  question: string;
  status: AiLogStatus;
  answer: string | null;
  tools: Array<{ name: string; ok: boolean }>;
  rounds: number;
  model: string | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number | null;
  durationMs: number;
  error: string | null;
};

export type AiLogPage = {
  month: string;
  items: AiLogItem[];
  pagination: { page: number; limit: number; total: number };
  summary: {
    questions: number;
    costUsd: number;
    byStatus: Partial<Record<AiLogStatus, number>>;
    byUser: Array<{ userId: string; fullName: string; questions: number; costUsd: number }>;
  };
};

export const aiAdminApi = {
  settings: async () => (await http.get<Envelope<AiSettingsView>>("/bi/ai/settings")).data.data,
  saveSettings: async (settings: AiSettings) =>
    (await http.put<Envelope<AiSettingsView>>("/bi/ai/settings", settings)).data.data,
  logs: async (params: {
    month?: string;
    userId?: string;
    status?: AiLogStatus;
    page: number;
    limit: number;
  }) => (await http.get<Envelope<AiLogPage>>("/bi/ai/logs", { params })).data.data,
};

export const LOG_STATUS: Record<AiLogStatus, { label: string; color: string }> = {
  answered: { label: "Đã trả lời", color: "green" },
  blocked: { label: "Bị chặn số", color: "orange" },
  round_limit: { label: "Quá nhiều bước", color: "gold" },
  timeout: { label: "Quá thời gian", color: "gold" },
  truncated: { label: "Quá dài", color: "gold" },
  refused: { label: "Từ chối", color: "default" },
  unavailable: { label: "Không gọi được AI", color: "red" },
  error: { label: "Lỗi", color: "red" },
};

/** "$0,031" cho từng câu; tổng thì 2 chữ số. */
export function usd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "—";
  return `$${value.toFixed(digits).replace(".", ",")}`;
}
