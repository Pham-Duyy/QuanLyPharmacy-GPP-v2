import { prisma } from "../../db/prisma.js";
import {
  DOCUMENT_DEFAULTS,
  DOCUMENT_TYPES,
  documentPrintSettingsSchema,
  type DocumentPrintSettings,
} from "./document-print.schema.js";

export const DOCUMENT_PRINT_KEY = "documentPrintSettings";

export function defaultDocumentSettings(): DocumentPrintSettings {
  return Object.fromEntries(
    DOCUMENT_TYPES.map((type) => [
      type,
      {
        paperSize: DOCUMENT_DEFAULTS[type].paperSize,
        title: DOCUMENT_DEFAULTS[type].title,
        footer: DOCUMENT_DEFAULTS[type].footer,
        showSignatures: true,
        showAmountInWords: true,
        showNote: true,
      },
    ]),
  ) as DocumentPrintSettings;
}

export type EffectiveDocumentSettings = {
  settings: DocumentPrintSettings;
  isDefault: boolean;
  updatedAt: Date | null;
};

/**
 * Cài đặt in chứng từ của một cửa hàng. Bản lưu thiếu hoặc hỏng một loại
 * phiếu thì loại đó dùng mặc định, các loại khác vẫn giữ nguyên — để việc
 * in phiếu không bao giờ bị chặn vì cài đặt.
 */
export async function getDocumentSettings(storeId: string): Promise<EffectiveDocumentSettings> {
  const row = await prisma.setting.findFirst({ where: { key: DOCUMENT_PRINT_KEY, storeId } });
  const fallback = defaultDocumentSettings();
  if (!row || typeof row.value !== "object" || row.value === null) {
    return { settings: fallback, isDefault: true, updatedAt: null };
  }

  const saved = row.value as Partial<Record<string, object>>;
  const merged = Object.fromEntries(
    DOCUMENT_TYPES.map((type) => {
      const candidate = { ...fallback[type], ...(saved[type] ?? {}) };
      const parsed = documentPrintSettingsSchema.shape[type].safeParse(candidate);
      return [type, parsed.success ? parsed.data : fallback[type]];
    }),
  ) as DocumentPrintSettings;

  return { settings: merged, isDefault: false, updatedAt: row.updatedAt };
}

export async function saveDocumentSettings(
  storeId: string,
  actorId: string,
  settings: DocumentPrintSettings,
  requestId: string | null,
): Promise<EffectiveDocumentSettings> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.setting.findFirst({ where: { key: DOCUMENT_PRINT_KEY, storeId } });
    const saved = existing
      ? await tx.setting.update({
          where: { id: existing.id },
          data: { value: settings, updatedBy: actorId },
        })
      : await tx.setting.create({
          data: { key: DOCUMENT_PRINT_KEY, storeId, value: settings, updatedBy: actorId },
        });

    await tx.auditLog.create({
      data: {
        storeId,
        actorId,
        action: "SETTING_UPDATE",
        resourceType: "setting",
        resourceId: saved.id,
        requestId,
        after: { key: DOCUMENT_PRINT_KEY, ...settings },
      },
    });
  });

  return getDocumentSettings(storeId);
}
