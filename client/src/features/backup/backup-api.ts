import { http } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";
import { downloadFile } from "../excel/excel-api.js";

/** Sao lưu trong phần mềm (Phase 7, D30). Cần settings.manage toàn chuỗi. */

export type BackupKind = "auto" | "manual" | "before-restore";

export type BackupItem = {
  name: string;
  kind: BackupKind;
  createdAt: string;
  sizeBytes: number;
  tables: number;
};

export type BackupStatus = {
  dir: string;
  auto: boolean;
  time: string;
  keep: number;
  running: boolean;
  lastRun: {
    kind: BackupKind;
    startedAt: string;
    finishedAt: string | null;
    ok: boolean | null;
    name: string | null;
    error: string | null;
  } | null;
  items: BackupItem[];
};

export const KIND_LABEL: Record<BackupKind, string> = {
  auto: "Tự động",
  manual: "Thủ công",
  "before-restore": "Trước phục hồi",
};

export const backupApi = {
  status: async () => (await http.get<Envelope<BackupStatus>>("/backups")).data.data,
  create: async () =>
    (await http.post<Envelope<{ name: string; rows: number; files: number }>>("/backups")).data
      .data,
  download: (name: string) =>
    downloadFile(`/backups/${encodeURIComponent(name)}/download`, {}, name),
};

export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Bản sao lưu gần nhất cũ hơn 2 ngày thì cảnh báo. */
export function isStale(items: BackupItem[], now = Date.now()): boolean {
  const latest = items[0];
  return !latest || now - new Date(latest.createdAt).getTime() > 2 * 86_400_000;
}
