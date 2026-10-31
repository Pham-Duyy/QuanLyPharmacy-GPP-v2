import { z } from "zod";
import { prisma } from "../../../db/prisma.js";
import { AppError } from "../../../lib/app-error.js";
import type { AuthContext } from "../../auth/auth.context.js";
import { vnMonthRange } from "./ai-settings.js";

/**
 * Nhật ký trợ lý AI cho chủ nhà thuốc (Phase 6, bước 6.3, D27): ai hỏi gì, kết quả, chi phí.
 * Câu hỏi có thể chứa thông tin nhạy cảm nên cần `audit.read` ở vai trò toàn chuỗi. Không trả
 * số liệu tool đã đọc (nhật ký không lưu), chỉ tên tool và lỗi nếu có.
 */

export const aiLogsQuery = z.object({
  /** Tháng theo giờ Việt Nam, dạng YYYY-MM; bỏ trống là tháng này. */
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Tháng dạng YYYY-MM")
    .optional(),
  userId: z.uuid("Mã người dùng không hợp lệ").optional(),
  status: z
    .enum([
      "answered",
      "blocked",
      "round_limit",
      "timeout",
      "refused",
      "truncated",
      "unavailable",
      "error",
    ])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AiLogsQuery = z.infer<typeof aiLogsQuery>;

function monthRange(month: string | undefined, now: Date) {
  if (!month) return { ...vnMonthRange(now), month: monthKey(now) };
  const [year, mon] = month.split("-").map(Number) as [number, number];
  // Giữa tháng (giờ VN) rồi lấy khoảng của tháng đó: tránh lệch múi giờ ở ngày 1.
  return { ...vnMonthRange(new Date(Date.UTC(year, mon - 1, 15))), month };
}

function monthKey(now: Date): string {
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return `${vn.getUTCFullYear()}-${String(vn.getUTCMonth() + 1).padStart(2, "0")}`;
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

export async function listAiLogs(auth: AuthContext, query: AiLogsQuery, now = new Date()) {
  if (!auth.chainPermissions.has("audit.read")) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Xem nhật ký trợ lý AI cần quyền audit.read ở vai trò toàn chuỗi",
    );
  }
  const { start, next, month } = monthRange(query.month, now);
  const inMonth = { occurredAt: { gte: start, lt: next } };
  const where = {
    ...inMonth,
    ...(query.userId ? { userId: query.userId } : {}),
    ...(query.status ? { status: query.status } : {}),
  };

  const [rows, total, byStatus, byUser] = await Promise.all([
    prisma.aiAgentLog.findMany({
      where,
      orderBy: { occurredAt: "desc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: { user: { select: { id: true, fullName: true } } },
    }),
    prisma.aiAgentLog.count({ where }),
    // Tổng của cả tháng (không theo bộ lọc người, trạng thái): để thấy bức tranh chung.
    prisma.aiAgentLog.groupBy({
      where: inMonth,
      by: ["status"],
      _count: true,
      _sum: { costUsd: true },
    }),
    prisma.aiAgentLog.groupBy({
      where: inMonth,
      by: ["userId"],
      _count: true,
      _sum: { costUsd: true },
      orderBy: { _sum: { costUsd: "desc" } },
    }),
  ]);
  const users = await prisma.user.findMany({
    where: { id: { in: byUser.map((row) => row.userId) } },
    select: { id: true, fullName: true },
  });
  const names = new Map(users.map((user) => [user.id, user.fullName]));

  return {
    month,
    items: rows.map((row) => ({
      id: row.id.toString(),
      occurredAt: row.occurredAt,
      user: row.user,
      conversationId: row.conversationId,
      question: row.question,
      status: row.status,
      answer: row.answer,
      tools: ((row.toolCalls ?? []) as Array<{ name: string; ok: boolean }>).map(
        ({ name, ok }) => ({ name, ok }),
      ),
      rounds: row.rounds,
      model: row.model,
      tokens: {
        input: row.inputTokens,
        output: row.outputTokens,
        cacheRead: row.cacheReadTokens,
        cacheWrite: row.cacheWriteTokens,
      },
      costUsd: row.costUsd === null ? null : Number(row.costUsd),
      durationMs: row.durationMs,
      error: row.error,
    })),
    pagination: { page: query.page, limit: query.limit, total },
    summary: {
      questions: byStatus.reduce((sum, row) => sum + row._count, 0),
      costUsd: round4(byStatus.reduce((sum, row) => sum + Number(row._sum.costUsd ?? 0), 0)),
      byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count])),
      byUser: byUser.map((row) => ({
        userId: row.userId,
        fullName: names.get(row.userId) ?? "—",
        questions: row._count,
        costUsd: round4(Number(row._sum.costUsd ?? 0)),
      })),
    },
  };
}
