import { useQuery } from "@tanstack/react-query";
import { http } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";

/** Ca thu ngân, chốt két (contract §14.5). */

export type ShiftTotals = {
  openingCash: number;
  cashSales: number;
  cashVoided: number;
  cashRefunds: number;
  cashIn: number;
  cashOut: number;
  expectedCash: number;
  invoiceCount: number;
  salesByMethod: { CASH: number; BANK_TRANSFER: number; CARD: number };
  voidedCount: number;
  refundCount: number;
};

export type CashMovement = {
  id: string;
  direction: "IN" | "OUT";
  amount: number;
  reason: string;
  createdAt: string;
  createdByName: string;
};

export type CashShift = {
  id: string;
  code: string;
  status: "OPEN" | "CLOSED";
  openedAt: string;
  openedBy: { id: string; fullName: string };
  closedAt: string | null;
  closedBy: { id: string; fullName: string } | null;
  countedCash: number | null;
  difference: number | null;
  closeNote: string | null;
  totals: ShiftTotals;
  movements: CashMovement[];
};

export type CashShiftListItem = {
  id: string;
  code: string;
  status: "OPEN" | "CLOSED";
  openedAt: string;
  openedByName: string;
  openingCash: number;
  closedAt: string | null;
  closedByName: string | null;
  expectedCash: number | null;
  countedCash: number | null;
  difference: number | null;
};

export type CurrentShift = {
  shift: CashShift | null;
  /** Chưa mở ca: tiền mặt đã bán từ lúc chốt ca trước. */
  outsideShift: { since: string; invoiceCount: number; cash: number } | null;
  /** Chưa mở ca: số tiền đếm được lúc chốt ca trước. */
  lastCountedCash: number | null;
};

export const cashShiftKeys = {
  current: ["cash-shift-current"] as const,
  list: ["cash-shifts"] as const,
  detail: (id: string) => ["cash-shift", id] as const,
};

/** Ca đang mở ở cửa hàng hiện tại; tải lại mỗi phút để số dự kiến theo kịp quầy bán. */
export function useCurrentShift(enabled: boolean) {
  return useQuery({
    queryKey: cashShiftKeys.current,
    enabled,
    refetchInterval: 60_000,
    queryFn: async () => (await http.get<Envelope<CurrentShift>>("/cash-shifts/current")).data.data,
  });
}

export const cashShiftPrintUrl = (id: string) => `/cash-shifts/${id}/print`;
