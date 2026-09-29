import { http } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";

/** Kiểu dữ liệu của màn Liên thông CSDL Dược quốc gia. */

export type NdsConfig = {
  enabled: boolean;
  environment: "SANDBOX" | "PRODUCTION";
  baseUrl: string;
  username: string | null;
  hasPassword: boolean;
  practiceLicenseCode: string | null;
  startDate: string | null;
  lastMasterSyncAt: string | null;
  updatedAt: string;
};

export type NdsPackaging = { unit_id?: string; unit_name?: string; gtin?: string };

export type NationalDrug = {
  id: string;
  name: string;
  registrationNumber: string | null;
  activeIngredient: string | null;
  strength: string | null;
  prescriptionStatus: number | null;
  specialControlType: number | null;
  manufacturerName: string | null;
  manufacturerCountry: string | null;
  packagings: NdsPackaging[];
};

export type MappingRow = {
  productId: string;
  code: string;
  name: string;
  registrationNumber: string | null;
  baseUnitName: string | null;
  link: {
    drugId: string;
    unitId: string;
    gtin: string | null;
    matchedBy: "REGISTRATION_NUMBER" | "NAME" | "MANUAL";
    confirmedAt: string | null;
    usable: boolean;
    drugName: string | null;
    drugRegistrationNumber: string | null;
  } | null;
};

export type MappingSummary = {
  total: number;
  linked: number;
  usable: number;
  needsReview: number;
  unlinked: number;
};

export type SyncJob = {
  id: string;
  kind: "STOCK_IN" | "STOCK_OUT" | "STOCK_TAKING";
  sourceType: string;
  sourceId: string;
  referenceNumber: string;
  reason: string;
  documentDate: string;
  status: string;
  attempts: number;
  remoteTransactionId: string | null;
  lastError: string | null;
  messages: unknown;
  submittedAt: string | null;
  settledAt: string | null;
  nextAttemptAt: string;
  createdAt: string;
};

export type QueueSummary = {
  total: number;
  byStatus: Record<string, number>;
  oldestPendingAt: string | null;
};

const BASE = "/national-sync";

export async function fetchConfig(): Promise<NdsConfig> {
  return (await http.get<Envelope<NdsConfig>>(`${BASE}/config`)).data.data;
}

export async function saveConfig(patch: Partial<NdsConfig> & { password?: string | null }): Promise<NdsConfig> {
  return (await http.patch<Envelope<NdsConfig>>(`${BASE}/config`, patch)).data.data;
}

export async function testConnection(): Promise<{ ok: boolean; baseUrl: string }> {
  return (await http.post<Envelope<{ ok: boolean; baseUrl: string }>>(`${BASE}/test-connection`, {})).data.data;
}

export async function syncMaster(full: boolean): Promise<{ units: number; drugs: number }> {
  return (await http.post<Envelope<{ units: number; drugs: number }>>(`${BASE}/master-sync`, { full })).data.data;
}

export async function fetchMapping(params: { state?: string; search?: string }): Promise<{
  items: MappingRow[];
  summary: MappingSummary;
}> {
  return (
    await http.get<Envelope<{ items: MappingRow[]; summary: MappingSummary }>>(`${BASE}/mapping`, { params })
  ).data.data;
}

export async function autoMatch(): Promise<{
  scanned: number;
  matchedByRegistration: number;
  matchedByName: number;
  unmatched: number;
}> {
  return (await http.post<Envelope<any>>(`${BASE}/auto-match`, {})).data.data;
}

export async function searchDrugs(search: string): Promise<NationalDrug[]> {
  return (
    await http.get<Envelope<{ items: NationalDrug[] }>>(`${BASE}/drugs`, { params: { search, limit: 20 } })
  ).data.data.items;
}

export async function setMapping(
  productId: string,
  body: { drugId: string; unitId: string; gtin?: string | null },
): Promise<void> {
  await http.put(`${BASE}/mapping/${productId}`, body);
}

export async function confirmMapping(productId: string): Promise<void> {
  await http.post(`${BASE}/mapping/${productId}/confirm`, {});
}

export async function removeMapping(productId: string): Promise<void> {
  await http.delete(`${BASE}/mapping/${productId}`);
}

export async function fetchJobs(status?: string): Promise<{ items: SyncJob[]; summary: QueueSummary }> {
  return (
    await http.get<Envelope<{ items: SyncJob[]; summary: QueueSummary }>>(`${BASE}/jobs`, {
      params: { status, limit: 100 },
    })
  ).data.data;
}

export async function scanDocuments(): Promise<{ created: number }> {
  return (await http.post<Envelope<{ created: number }>>(`${BASE}/scan`, {})).data.data;
}

export async function drainNow(): Promise<{
  sent: { sent: number; blocked: number; failed: number; rejected: number };
  polled: { checked: number; completed: number; rejected: number };
}> {
  return (await http.post<Envelope<any>>(`${BASE}/drain`, {})).data.data;
}

export async function retryJob(jobId: string): Promise<void> {
  await http.post(`${BASE}/jobs/${jobId}/retry`, {});
}

export async function submitOpeningStock(): Promise<{
  referenceNumber: string;
  transactionId: string | null;
  items: number;
}> {
  return (await http.post<Envelope<any>>(`${BASE}/opening-stock-taking`, {})).data.data;
}

/** Nhãn tiếng Việt cho trạng thái hàng đợi. */
export const JOB_STATUS: Record<string, { label: string; color: string }> = {
  PENDING: { label: "Chờ gửi", color: "default" },
  SENDING: { label: "Đang gửi", color: "processing" },
  ACCEPTED: { label: "Đã tiếp nhận", color: "cyan" },
  PROCESSING: { label: "Đang xử lý", color: "processing" },
  COMPLETED: { label: "Xong", color: "success" },
  REJECTED: { label: "Bị từ chối", color: "error" },
  FAILED: { label: "Lỗi, sẽ thử lại", color: "warning" },
  BLOCKED: { label: "Thiếu mã thuốc", color: "warning" },
  NEEDS_REVIEW: { label: "Cần xem lại", color: "warning" },
};

export const JOB_KIND: Record<string, string> = {
  STOCK_IN: "Nhập hàng",
  STOCK_OUT: "Xuất hàng",
  STOCK_TAKING: "Kiểm hàng",
};

export const SOURCE_LABEL: Record<string, string> = {
  goods_receipt: "Phiếu nhập",
  invoice: "Hóa đơn bán",
  customer_return: "Khách trả hàng",
  supplier_return: "Trả nhà cung cấp",
  stock_count: "Kiểm kê",
  opening_balance: "Tồn đầu kỳ",
};
