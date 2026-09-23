import { http } from "../../../api/http.js";
import type { Envelope } from "../../../api/types.js";

export type CountStatus = "COUNTING" | "CLOSED" | "CANCELLED";

export type CountHeader = {
  id: string;
  code: string;
  status: CountStatus;
  scopeType: "ALL" | "CATEGORY" | "SHELF";
  scopeLabel: string | null;
  note: string | null;
  startedAt: string;
  closedAt: string | null;
  createdByName: string;
  closedByName: string | null;
  adjustment: { id: string; code: string; status: string } | null;
};

export type CountListItem = CountHeader & {
  totalLines: number;
  countedLines: number;
  differenceLines: number;
};

export type CountLine = {
  id: string;
  lineNo: number;
  batchId: string;
  productId: string;
  productCode: string;
  productName: string;
  batchNumber: string;
  expiryDate: string;
  shelfLocation: string | null;
  baseUnitName: string;
  units: Array<{ id: string; name: string; conversionToBase: number }>;
  systemBaseQuantityAtOpen: number;
  systemBaseQuantityNow: number;
  systemBaseQuantityAtCount: number | null;
  countedUnitId: string | null;
  countedQuantity: number | null;
  countedBaseQuantity: number | null;
  countedAt: string | null;
  countedByName: string | null;
  differenceBaseQuantity: number | null;
  differenceValue: number | null;
  note: string | null;
};

export type CountSummary = {
  totalLines: number;
  countedLines: number;
  pendingLines: number;
  differenceLines: number;
  surplusLines: number;
  shortageLines: number;
  surplusBaseQuantity: number;
  shortageBaseQuantity: number;
  differenceValue: number | null;
};

export type CountDetail = { count: CountHeader; lines: CountLine[]; summary: CountSummary };

export type CountEntry = { lineId: string; unitId?: string; quantity?: number; clear?: boolean };

export const listCounts = async (status?: string): Promise<{ items: CountListItem[]; open: { id: string; code: string } | null }> =>
  (await http.get<Envelope<{ items: CountListItem[]; open: { id: string; code: string } | null }>>("/stock-counts", { params: { status } })).data.data;

export const getCount = async (id: string): Promise<CountDetail> => (await http.get<Envelope<CountDetail>>(`/stock-counts/${id}`)).data.data;

export const openCount = async (body: { scopeType: string; scopeValue?: string | null; note?: string | null }): Promise<CountDetail> =>
  (await http.post<Envelope<CountDetail>>("/stock-counts", body)).data.data;

export const saveCounts = async (id: string, entries: CountEntry[]): Promise<CountDetail & { saved: number; cleared: number }> =>
  (await http.patch<Envelope<CountDetail & { saved: number; cleared: number }>>(`/stock-counts/${id}/counts`, { entries })).data.data;

export const addCountLine = async (id: string, batchId: string): Promise<CountDetail & { lineId: string }> =>
  (await http.post<Envelope<CountDetail & { lineId: string }>>(`/stock-counts/${id}/lines`, { batchId })).data.data;

export const closeCount = async (id: string, note?: string | null): Promise<CountDetail & { adjustmentId: string | null; differenceLines: number }> =>
  (await http.post<Envelope<CountDetail & { adjustmentId: string | null; differenceLines: number }>>(`/stock-counts/${id}/close`, { note })).data.data;

export const cancelCount = async (id: string, reason?: string | null): Promise<CountDetail> =>
  (await http.post<Envelope<CountDetail>>(`/stock-counts/${id}/cancel`, { reason })).data.data;
