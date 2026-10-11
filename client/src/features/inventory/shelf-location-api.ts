import { useQuery } from "@tanstack/react-query";
import { http } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";

/** Gợi ý vị trí: các vị trí cửa hàng đang dùng và vị trí gần nhất của từng thuốc. */
export type ShelfHints = { locations: string[]; byProduct: Record<string, string> };

export function useShelfHints(productIds: string[], enabled = true) {
  const ids = [...new Set(productIds)].sort();
  return useQuery({
    queryKey: ["shelf-hints", ids.join(",")],
    enabled,
    staleTime: 60_000,
    queryFn: async () =>
      (
        await http.get<Envelope<ShelfHints>>("/inventory/batches/locations", {
          params: { productIds: ids.join(",") || undefined },
        })
      ).data.data,
  });
}
