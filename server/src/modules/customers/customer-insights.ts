import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import type { PageQuery } from "../../lib/pagination.js";

/**
 * Nhóm khách tính từ dữ liệu bán hàng thật, không phải hạng thành viên
 * (hệ thống chưa có chương trình tích điểm). Quy tắc cố định, hiển thị rõ
 * trên giao diện để người dùng hiểu vì sao khách thuộc nhóm nào.
 */
export const SEGMENT_RULES = {
  loyalMinOrders: 5,
  loyalWindowDays: 180,
  newWithinDays: 30,
  dormantAfterDays: 90,
} as const;

export type Segment = "LOYAL" | "NEW" | "DORMANT" | "REGULAR";
export type SegmentFilter = "LOYAL" | "NEW" | "DORMANT";

/**
 * Thống kê mua hàng theo khách, toàn chuỗi: chỉ hóa đơn COMPLETED, trừ số
 * tiền đã hoàn khi khách trả hàng. Dùng làm CTE chung cho danh sách, chi
 * tiết và thống kê đầu trang.
 */
const STATS_CTE = Prisma.sql`
  inv AS (
    SELECT customer_id,
           SUM(total_amount) AS gross,
           COUNT(*)::int AS order_count,
           MAX(sold_at) AS last_purchase_at,
           COUNT(*) FILTER (WHERE sold_at >= now() - make_interval(days => ${SEGMENT_RULES.loyalWindowDays}))::int AS recent_orders
    FROM invoices
    WHERE status = 'COMPLETED' AND customer_id IS NOT NULL
    GROUP BY customer_id
  ),
  ref AS (
    SELECT i.customer_id, SUM(r.refund_amount) AS refunded
    FROM returns r JOIN invoices i ON i.id = r.invoice_id
    WHERE i.customer_id IS NOT NULL
    GROUP BY i.customer_id
  ),
  stats AS (
    SELECT c.id,
           COALESCE(inv.gross, 0) - COALESCE(ref.refunded, 0) AS total_spent,
           COALESCE(inv.order_count, 0) AS order_count,
           inv.last_purchase_at,
           COALESCE(inv.recent_orders, 0) AS recent_orders,
           CASE
             WHEN COALESCE(inv.recent_orders, 0) >= ${SEGMENT_RULES.loyalMinOrders} THEN 'LOYAL'
             WHEN c.created_at >= now() - make_interval(days => ${SEGMENT_RULES.newWithinDays}) THEN 'NEW'
             WHEN inv.last_purchase_at < now() - make_interval(days => ${SEGMENT_RULES.dormantAfterDays}) THEN 'DORMANT'
             ELSE 'REGULAR'
           END AS segment
    FROM customers c
    LEFT JOIN inv ON inv.customer_id = c.id
    LEFT JOIN ref ON ref.customer_id = c.id
    WHERE c.is_anonymized = false
  )`;

/** Điều kiện lọc nhóm: "thân thiết/mới/lâu chưa quay lại" là các tập có thể giao nhau. */
function segmentCondition(segment: SegmentFilter | undefined): Prisma.Sql {
  switch (segment) {
    case "LOYAL":
      return Prisma.sql`s.recent_orders >= ${SEGMENT_RULES.loyalMinOrders}`;
    case "NEW":
      return Prisma.sql`c.created_at >= now() - make_interval(days => ${SEGMENT_RULES.newWithinDays})`;
    case "DORMANT":
      return Prisma.sql`s.last_purchase_at < now() - make_interval(days => ${SEGMENT_RULES.dormantAfterDays})`;
    default:
      return Prisma.sql`TRUE`;
  }
}

function searchCondition(q: string | undefined): Prisma.Sql {
  if (!q) return Prisma.sql`TRUE`;
  return Prisma.sql`(
    f_unaccent(lower(c.full_name)) LIKE '%' || f_unaccent(lower(${q})) || '%'
    OR c.phone LIKE '%' || ${q} || '%'
    OR lower(c.code) LIKE '%' || lower(${q}) || '%'
  )`;
}

const SORT_SQL: Record<string, Prisma.Sql> = {
  createdAt: Prisma.sql`c.created_at`,
  fullName: Prisma.sql`c.full_name`,
  totalSpent: Prisma.sql`s.total_spent`,
  lastPurchaseAt: Prisma.sql`s.last_purchase_at`,
};

export type CustomerRow = {
  id: string;
  code: string;
  full_name: string | null;
  phone: string | null;
  birth_year: number | null;
  gender: string | null;
  created_at: Date;
  health_data_consent_at: Date | null;
  total_spent: Prisma.Decimal | bigint | number;
  order_count: number;
  last_purchase_at: Date | null;
  segment: Segment;
};

export async function listCustomers(
  page: PageQuery,
  filters: { q?: string; segment?: SegmentFilter },
): Promise<{ rows: CustomerRow[]; total: number }> {
  const where = Prisma.sql`${searchCondition(filters.q)} AND ${segmentCondition(filters.segment)}`;
  const order = SORT_SQL[page.sortBy] ?? SORT_SQL["createdAt"]!;
  const direction = page.order === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;

  const [rows, count] = await Promise.all([
    prisma.$queryRaw<CustomerRow[]>(Prisma.sql`
      WITH ${STATS_CTE}
      SELECT c.id::text, c.code, c.full_name, c.phone, c.birth_year, c.gender, c.created_at,
             c.health_data_consent_at, s.total_spent, s.order_count, s.last_purchase_at, s.segment
      FROM customers c JOIN stats s ON s.id = c.id
      WHERE ${where}
      ORDER BY ${order} ${direction} NULLS LAST, c.id
      LIMIT ${page.limit} OFFSET ${page.skip}
    `),
    prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
      WITH ${STATS_CTE}
      SELECT COUNT(*)::int AS total FROM customers c JOIN stats s ON s.id = c.id WHERE ${where}
    `),
  ]);
  return { rows, total: count[0]?.total ?? 0 };
}

export async function customerStats(customerId: string) {
  const rows = await prisma.$queryRaw<
    Array<Pick<CustomerRow, "total_spent" | "order_count" | "last_purchase_at" | "segment">>
  >(Prisma.sql`
    WITH ${STATS_CTE}
    SELECT s.total_spent, s.order_count, s.last_purchase_at, s.segment FROM stats s WHERE s.id = ${customerId}::uuid
  `);
  const row = rows[0];
  return {
    totalSpent: row ? Number(row.total_spent) : 0,
    orderCount: row?.order_count ?? 0,
    lastPurchaseAt: row?.last_purchase_at ?? null,
    segment: (row?.segment ?? "REGULAR") as Segment,
  };
}

/** Số liệu đầu trang Khách hàng. */
export async function customerSummary() {
  const rows = await prisma.$queryRaw<
    Array<{
      total: number;
      new_this_month: number;
      purchased_30d: number;
      loyal: number;
      recent: number;
      dormant: number;
    }>
  >(Prisma.sql`
    WITH ${STATS_CTE}
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE c.created_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh')
      )::int AS new_this_month,
      COUNT(*) FILTER (WHERE s.last_purchase_at >= now() - interval '30 days')::int AS purchased_30d,
      COUNT(*) FILTER (WHERE s.recent_orders >= ${SEGMENT_RULES.loyalMinOrders})::int AS loyal,
      COUNT(*) FILTER (WHERE c.created_at >= now() - make_interval(days => ${SEGMENT_RULES.newWithinDays}))::int AS recent,
      COUNT(*) FILTER (WHERE s.last_purchase_at < now() - make_interval(days => ${SEGMENT_RULES.dormantAfterDays}))::int AS dormant
    FROM customers c JOIN stats s ON s.id = c.id
  `);
  const row = rows[0]!;
  return {
    total: row.total,
    newThisMonth: row.new_this_month,
    purchasedLast30Days: row.purchased_30d,
    segments: { LOYAL: row.loyal, NEW: row.recent, DORMANT: row.dormant },
    rules: SEGMENT_RULES,
  };
}
