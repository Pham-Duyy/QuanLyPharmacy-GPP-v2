import { fileURLToPath } from "node:url";
import { prisma } from "../db/prisma.js";
import { checkMigrationFiles, countMigrations } from "../lib/migration-guard.js";

/**
 * Kiểm tra trước khi áp migration, chạy tự động trong `npm run db:migrate`.
 *
 * Prisma lưu mã băm (checksum) của từng file migration lúc áp. Hai sự cố đã
 * gặp (xem docs/migration-checksum-log.md):
 *   - File được ghi với xuống dòng CRLF rồi áp ngay, trong khi git lưu LF:
 *     checkout lại là mã băm lệch. `.gitattributes` không chặn được vì nó chỉ
 *     tác động lúc commit/checkout, còn file bị áp trước đó.
 *   - File migration đã áp bị sửa (dù chỉ một dòng chú thích).
 * Lệch mã băm làm `prisma migrate dev` đề nghị reset CSDL, tức xóa dữ liệu.
 *
 * Nên chặn ngay tại đây, trước khi áp:
 *   1. Không file migration.sql nào được chứa ký tự CR.
 *   2. Migration đã áp thì nội dung file phải trùng mã băm đã lưu. Muốn thay
 *      đổi thì tạo migration mới, không sửa file cũ; không sửa checksum trong
 *      CSDL để cho qua.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../prisma/migrations", import.meta.url));

async function appliedChecksums(): Promise<Map<string, string>> {
  const exists = await prisma.$queryRaw<Array<{ ok: boolean }>>`
    SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS ok`;
  // CSDL mới tinh chưa có bảng này: chưa có gì để đối chiếu.
  if (!exists[0]?.ok) return new Map();
  const rows = await prisma.$queryRaw<Array<{ migration_name: string; checksum: string }>>`
    SELECT migration_name, checksum FROM _prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  return new Map(rows.map((row) => [row.migration_name, row.checksum]));
}

async function main(): Promise<void> {
  const problems = checkMigrationFiles(MIGRATIONS_DIR, await appliedChecksums());

  if (problems.length > 0) {
    console.error("Dừng: migration không an toàn để áp.\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "\nXem docs/migration-checksum-log.md. Không sửa checksum trong CSDL để cho qua.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Đã kiểm ${countMigrations(MIGRATIONS_DIR)} migration: không có CRLF, migration đã áp khớp mã băm.`,
  );
}

main()
  .catch((error) => {
    console.error("Không kiểm tra được migration:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
