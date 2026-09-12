import { prisma } from "../db/prisma.js";

/**
 * Ba bất biến dữ liệu ở docs/erd.md §10. Mỗi truy vấn phải trả về 0 dòng.
 * Chạy sau mỗi đợt kiểm thử tích hợp, và đặt lịch chạy hằng đêm khi vận hành:
 *   npm run check:invariants
 */
type Invariant = {
  name: string;
  sql: string;
  meaning: string;
};

const INVARIANTS: Invariant[] = [
  {
    name: "Tồn của lô bằng tổng thẻ kho",
    meaning: "Có lô mà số tồn không khớp tổng các dòng biến động. Đây là lỗi dữ liệu nghiêm trọng.",
    sql: `
      SELECT b.id::text, b.batch_number, b.quantity_on_hand,
             COALESCE(SUM(m.base_quantity), 0)::int AS ledger_sum
      FROM batches b
      LEFT JOIN stock_movements m ON m.batch_id = b.id
      GROUP BY b.id, b.batch_number, b.quantity_on_hand
      HAVING b.quantity_on_hand <> COALESCE(SUM(m.base_quantity), 0)
      LIMIT 20`,
  },
  {
    name: "Phân bổ lô khớp số lượng dòng hóa đơn",
    meaning: "Có dòng hóa đơn mà tổng số lượng phân bổ theo lô không bằng số lượng đã bán.",
    sql: `
      SELECT l.id::text, l.product_name, l.base_quantity,
             SUM(a.base_quantity)::int AS allocated
      FROM invoice_lines l
      JOIN invoice_allocations a ON a.invoice_line_id = l.id
      GROUP BY l.id, l.product_name, l.base_quantity
      HAVING SUM(a.base_quantity) <> l.base_quantity
      LIMIT 20`,
  },
  {
    name: "Không còn lô hết hạn mà vẫn ở trạng thái bán được",
    meaning: "Không phải lỗi dữ liệu, mà là việc cần làm: nhà thuốc phải lập phiếu hủy cho các lô này.",
    sql: `
      SELECT id::text, batch_number, expiry_date::text, quantity_on_hand
      FROM batches
      WHERE status = 'AVAILABLE'
        AND quantity_on_hand > 0
        AND expiry_date <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
      LIMIT 20`,
  },
];

async function main(): Promise<void> {
  let failed = 0;

  for (const invariant of INVARIANTS) {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(invariant.sql);

    if (rows.length === 0) {
      console.log(`  OK   ${invariant.name}`);
      continue;
    }

    failed += 1;
    console.log(`  LỖI  ${invariant.name}: ${rows.length} dòng vi phạm`);
    console.log(`       ${invariant.meaning}`);
    console.table(rows);
  }

  if (failed > 0) {
    console.log(`\nCó ${failed} bất biến bị vi phạm.`);
    process.exitCode = 1;
    return;
  }

  console.log("\nToàn bộ bất biến dữ liệu đều đạt.");
}

main()
  .catch((error) => {
    console.error("Không chạy được kiểm tra bất biến:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
