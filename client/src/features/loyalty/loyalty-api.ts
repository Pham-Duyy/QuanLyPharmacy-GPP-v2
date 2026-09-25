import { useQuery } from "@tanstack/react-query";
import { http } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";

export type LoyaltySettings = {
  enabled: boolean;
  /** Số tiền khách chi để được 1 điểm. */
  earnAmountPerPoint: number;
  /** Mỗi điểm đổi được bao nhiêu đồng. */
  pointValue: number;
  minRedeemPoints: number;
  maxRedeemPercent: number;
  /** 0 là điểm không hết hạn. */
  expiryMonths: number;
  earnOnDrugs: boolean;
};

export type EffectiveLoyaltySettings = {
  settings: LoyaltySettings;
  isDefault: boolean;
  updatedAt: string | null;
};

export type LoyaltyBalance = {
  available: number;
  expiringSoon: number;
  nextExpiryAt: string | null;
  expired: number;
  totalEarned: number;
  totalRedeemed: number;
};

export type LoyaltyTransaction = {
  id: string;
  type: "EARN" | "REDEEM" | "REVERSE" | "ADJUST";
  typeLabel: string;
  points: number;
  amount: number | null;
  expiresAt: string | null;
  note: string | null;
  createdAt: string;
  invoice: { id: string; code: string; status: string } | null;
  store: { id: string; code: string; name: string } | null;
  createdByName: string | null;
};

export type CustomerLoyalty = {
  customer: { id: string; code: string; fullName: string | null };
  balance: LoyaltyBalance;
  transactions: LoyaltyTransaction[];
};

export const LOYALTY_SETTINGS_KEY = ["loyalty-settings"];

export function useLoyaltySettings(enabled = true) {
  return useQuery({
    queryKey: LOYALTY_SETTINGS_KEY,
    enabled,
    queryFn: async () =>
      (await http.get<Envelope<EffectiveLoyaltySettings>>("/loyalty/settings")).data.data,
  });
}

export function useCustomerLoyalty(customerId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["customer-loyalty", customerId],
    enabled: Boolean(customerId) && enabled,
    queryFn: async () =>
      (await http.get<Envelope<CustomerLoyalty>>(`/customers/${customerId}/loyalty`)).data.data,
  });
}

/** Số điểm nhiều nhất được đổi trên một hóa đơn, theo trần phần trăm của chương trình. */
export function maxRedeemablePoints(
  settings: LoyaltySettings,
  eligibleSubtotal: number,
  available: number,
): number {
  const cap = Math.floor((eligibleSubtotal * settings.maxRedeemPercent) / 100 / settings.pointValue);
  return Math.max(0, Math.min(cap, available));
}
