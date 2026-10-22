import { foldText } from "../../app/fold-text.js";

type ProductRef = { productId: string; code: string; name: string; unit: string };

export type PurchaseRow = ProductRef & {
  quantity: number;
  amount: number | null;
  receipts: number;
  suppliers: string[];
};

export type SupplierReturnRow = ProductRef & {
  quantity: number;
  value: number | null;
  returns: number;
};

export type SalesRow = ProductRef & {
  quantity: number;
  revenue: number;
  grossProfit: number | null;
  invoices: number;
  share: number;
};

export type IdleRow = ProductRef & {
  stock: number;
  value: number | null;
  withoutCost: boolean;
  lastSoldDate: string | null;
  lastReceivedDate: string | null;
  idleSince: string;
  daysIdle: number;
  nearestExpiry: string | null;
};

export type MovementRow = ProductRef & {
  opening: number;
  received: number;
  otherIn: number;
  sold: number;
  otherOut: number;
  closing: number;
};

export type PeriodSummary = {
  month: string;
  partial: boolean;
  from: string;
  to: string;
  showCost: boolean;
  summary: {
    purchases: {
      receipts: number;
      products: number;
      goodsAmount: number | null;
      discountAmount: number | null;
      vatAmount: number | null;
      totalCost: number | null;
      supplierReturnValue: number | null;
    };
    sales: {
      netRevenue: number;
      invoiceCount: number;
      products: number;
      grossProfit: number | null;
      costExact: boolean;
    };
    idle: { products: number; value: number | null; withoutCost: number };
  };
  purchases: PurchaseRow[];
  supplierReturns: SupplierReturnRow[];
  sales: SalesRow[];
  idle: IdleRow[];
  movements: MovementRow[];
};

export type SalesMetric = "revenue" | "quantity";

/**
 * Xếp hạng bán theo doanh thu hoặc số lượng. Hạng luôn tính từ nhiều xuống ít
 * (hạng 1 là bán nhiều nhất); xem "ít nhất trước" chỉ đảo thứ tự hiển thị, nên
 * thuốc bán ít nhất vẫn mang hạng cuối, không bị đánh lại thành hạng 1.
 */
export function rankSales(
  rows: SalesRow[],
  metric: SalesMetric,
  order: "desc" | "asc",
): Array<SalesRow & { rank: number }> {
  const ranked = [...rows]
    .sort(
      (a, b) =>
        b[metric] - a[metric] ||
        (metric === "revenue" ? b.quantity - a.quantity : b.revenue - a.revenue) ||
        a.name.localeCompare(b.name, "vi"),
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));
  return order === "desc" ? ranked : ranked.reverse();
}

/** Tìm theo tên hoặc mã, không phân biệt dấu và hoa thường. */
export function matchesProduct(row: { code: string; name: string }, search: string): boolean {
  const query = foldText(search.trim());
  return !query || foldText(row.name).includes(query) || foldText(row.code).includes(query);
}

/** "Tồn lâu": trong số thuốc không bán được cả tháng, đã đứng yên ít nhất `days` ngày. */
export function longIdle(rows: IdleRow[], days: number): IdleRow[] {
  return rows.filter((row) => row.daysIdle >= days);
}
