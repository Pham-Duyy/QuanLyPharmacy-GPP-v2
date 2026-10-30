import { prisma } from "../../db/prisma.js";
import { fetchAnalytics } from "../bi/bi.client.js";

/**
 * Gợi ý theo dự báo của analytics-service (Phase 5, bước 5.5; quyết định D18) ghép vào trang
 * Đề xuất đặt hàng: so được cách tính đơn giản (tốc độ bán × số ngày) với cách tính có dự báo,
 * tồn an toàn theo ABC–XYZ, trừ lô sắp hết hạn, chuyển hàng giữa cửa hàng.
 *
 * Chỉ dùng khi analytics-service đọc thẳng CSDL này (ANALYTICS_SOURCE=postgres): khi đó mã cửa
 * hàng, mã thuốc là của phần mềm. Đọc từ tệp Excel thì mã có thể khác nghĩa: không ghép.
 * analytics-service tắt, chưa có số liệu: trả null, trang vẫn chạy như cũ.
 */

export type ForecastLine = {
  orderQuantity: number;
  transferQuantity: number;
  reason: string;
  cell: string;
  daysUntilStockout: number | null;
};

type Plan = {
  as_of: string;
  available: boolean;
  data_source?: string;
  cover_days?: number;
  items: Array<{
    medicine_code: string;
    order_quantity: number;
    transfer_quantity: number;
    reason: string;
    cell: string;
    days_until_stockout: number | null;
  }>;
};

export async function forecastByCode(
  storeId: string,
): Promise<{ asOf: string; coverDays: number | null; items: Map<string, ForecastLine> } | null> {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { code: true } });
  if (!store) return null;
  let plan: Plan;
  try {
    plan = await fetchAnalytics<Plan>("reorder", { store: store.code });
  } catch {
    return null;
  }
  if (!plan.available || plan.data_source !== "postgres") return null;
  return {
    asOf: plan.as_of,
    coverDays: plan.cover_days ?? null,
    items: new Map(
      plan.items.map((item) => [
        item.medicine_code,
        {
          orderQuantity: item.order_quantity,
          transferQuantity: item.transfer_quantity,
          reason: item.reason,
          cell: item.cell,
          daysUntilStockout: item.days_until_stockout,
        },
      ]),
    ),
  };
}
