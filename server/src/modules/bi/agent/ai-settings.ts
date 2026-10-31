import { z } from "zod";
import { prisma } from "../../../db/prisma.js";

/**
 * Cấu hình trợ lý AI chung toàn chuỗi (Phase 6, bước 6.2, quyết định D26): bật/tắt, số câu mỗi
 * người mỗi giờ, ngân sách USD mỗi tháng. Lưu ở bảng `settings` (khóa `ai.agent`, không gắn cửa
 * hàng); sửa có hiệu lực ngay, không cần khởi động lại.
 *
 * Chi tiêu tháng = tổng `cost_usd` của `ai_agent_logs` từ 00:00 ngày 1 (giờ Việt Nam), mọi người
 * dùng. Đạt ngân sách thì câu tiếp theo bị từ chối trước khi gọi Claude; câu đang chạy dở vẫn
 * được trả lời nên chi tiêu có thể vượt nhẹ (một câu thường dưới 0,2 USD).
 */

export const AI_SETTINGS_KEY = "ai.agent";

export const aiSettingsSchema = z.object({
  enabled: z.boolean(),
  questionsPerHour: z
    .number()
    .int("Số câu mỗi giờ phải là số nguyên")
    .min(1, "Tối thiểu 1 câu mỗi giờ")
    .max(200, "Tối đa 200 câu mỗi giờ"),
  monthlyBudgetUsd: z
    .number()
    .min(0, "Ngân sách không âm")
    .max(1_000, "Ngân sách tối đa 1.000 USD mỗi tháng"),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

export const AI_DEFAULTS: AiSettings = {
  enabled: true,
  questionsPerHour: 30,
  monthlyBudgetUsd: 10,
};

export type EffectiveAiSettings = {
  settings: AiSettings;
  isDefault: boolean;
  updatedAt: Date | null;
};

/** Bản lưu sai định dạng (sửa tay trong CSDL) thì dùng mặc định, không làm hỏng trợ lý. */
export async function getAiSettings(): Promise<EffectiveAiSettings> {
  const row = await prisma.setting.findFirst({ where: { key: AI_SETTINGS_KEY, storeId: null } });
  if (!row || typeof row.value !== "object" || row.value === null) {
    return { settings: AI_DEFAULTS, isDefault: true, updatedAt: null };
  }
  const parsed = aiSettingsSchema.safeParse({ ...AI_DEFAULTS, ...row.value });
  if (!parsed.success) return { settings: AI_DEFAULTS, isDefault: true, updatedAt: null };
  return { settings: parsed.data, isDefault: false, updatedAt: row.updatedAt };
}

export async function saveAiSettings(
  actorId: string,
  settings: AiSettings,
  requestId: string | null,
): Promise<EffectiveAiSettings> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.setting.findFirst({ where: { key: AI_SETTINGS_KEY, storeId: null } });
    const saved = existing
      ? await tx.setting.update({
          where: { id: existing.id },
          data: { value: settings, updatedBy: actorId },
        })
      : await tx.setting.create({
          data: { key: AI_SETTINGS_KEY, storeId: null, value: settings, updatedBy: actorId },
        });
    await tx.auditLog.create({
      data: {
        actorId,
        action: "SETTING_UPDATE",
        resourceType: "setting",
        resourceId: saved.id,
        requestId,
        before: existing ? { key: AI_SETTINGS_KEY, ...(existing.value as object) } : undefined,
        after: { key: AI_SETTINGS_KEY, ...settings },
      },
    });
  });
  return getAiSettings();
}

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

/** 00:00 ngày 1 của tháng hiện tại và tháng sau theo giờ Việt Nam (UTC+7, không đổi giờ). */
export function vnMonthRange(now: Date): { start: Date; next: Date } {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const year = vn.getUTCFullYear();
  const month = vn.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1) - VN_OFFSET_MS),
    next: new Date(Date.UTC(year, month + 1, 1) - VN_OFFSET_MS),
  };
}

export type AiBudget = {
  monthlyUsd: number;
  spentUsd: number;
  remainingUsd: number;
  questions: number;
  /** Ngày ngân sách tính lại (00:00 ngày 1 tháng sau, giờ Việt Nam). */
  resetsAt: Date;
  exceeded: boolean;
};

/** Chi tiêu AI của cả chuỗi trong tháng hiện tại (giờ Việt Nam). */
export async function aiBudget(settings: AiSettings, now: Date): Promise<AiBudget> {
  const { start, next } = vnMonthRange(now);
  const sum = await prisma.aiAgentLog.aggregate({
    where: { occurredAt: { gte: start, lt: next } },
    _sum: { costUsd: true },
    _count: true,
  });
  const spentUsd = Math.round(Number(sum._sum.costUsd ?? 0) * 10_000) / 10_000;
  return {
    monthlyUsd: settings.monthlyBudgetUsd,
    spentUsd,
    remainingUsd: Math.max(Math.round((settings.monthlyBudgetUsd - spentUsd) * 10_000) / 10_000, 0),
    questions: sum._count,
    resetsAt: next,
    exceeded: spentUsd >= settings.monthlyBudgetUsd,
  };
}
