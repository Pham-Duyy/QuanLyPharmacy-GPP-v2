import { http } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";

/** API hóa đơn điện tử máy tính tiền (contract §26), theo cửa hàng đang chọn. */

export type EInvoiceConfig = {
  storeId: string;
  enabled: boolean;
  provider: "MISA";
  environment: "SANDBOX" | "PRODUCTION";
  baseUrl: string;
  appId: string | null;
  taxCode: string | null;
  username: string | null;
  hasPassword: boolean;
  invSeries: string | null;
  enabledFrom: string | null;
  updatedAt: string;
};

export type EInvoiceStatus =
  "PENDING" | "SENDING" | "PUBLISHED" | "COMPLETED" | "FAILED" | "REJECTED" | "CANCELLED";

export type EInvoiceItem = {
  id: string;
  invoiceId: string;
  invoiceCode: string;
  invoiceStatus: string;
  soldAt: string;
  totalAmount: number;
  status: EInvoiceStatus;
  attempts: number;
  invSeries: string | null;
  invNo: string | null;
  transactionId: string | null;
  taxAuthorityCode: string | null;
  lastError: string | null;
  reviewReason: string | null;
  publishedAt: string | null;
  settledAt: string | null;
};

export type EInvoiceList = {
  items: EInvoiceItem[];
  summary: {
    total: number;
    byStatus: Partial<Record<EInvoiceStatus, number>>;
    needsReview: number;
  };
};

const BASE = "/einvoices";

export async function fetchConfig(): Promise<EInvoiceConfig> {
  return (await http.get<Envelope<EInvoiceConfig>>(`${BASE}/config`)).data.data;
}

export async function saveConfig(
  patch: Partial<
    Omit<
      EInvoiceConfig,
      "hasPassword" | "baseUrl" | "storeId" | "updatedAt" | "enabledFrom" | "provider"
    >
  > & {
    password?: string | null;
  },
): Promise<EInvoiceConfig> {
  return (await http.patch<Envelope<EInvoiceConfig>>(`${BASE}/config`, patch)).data.data;
}

export async function testConnection(): Promise<{ ok: boolean; baseUrl: string }> {
  return (
    await http.post<Envelope<{ ok: boolean; baseUrl: string }>>(`${BASE}/test-connection`, {})
  ).data.data;
}

export async function fetchEInvoices(filter: {
  status?: string;
  needsReview?: boolean;
}): Promise<EInvoiceList> {
  return (
    await http.get<Envelope<EInvoiceList>>(BASE, {
      params: {
        status: filter.status,
        needsReview: filter.needsReview ? "true" : undefined,
        limit: 200,
      },
    })
  ).data.data;
}

export async function runNow() {
  return (await http.post<Envelope<unknown>>(`${BASE}/run`, {})).data.data;
}

export async function retry(id: string): Promise<void> {
  await http.post(`${BASE}/${id}/retry`, {});
}
