import { randomBytes } from "node:crypto";
import { prisma } from "../db/prisma.js";

/**
 * Tạo (hoặc đặt lại mật khẩu) tài khoản CHỈ ĐỌC analytics_reader cho analytics-service
 * (Phase 5, bước 5.5; quyết định D22). Không cần cài psql: dùng DATABASE_URL trong server/.env.
 *
 *   npm run db:analytics-reader                 tự tạo mật khẩu ngẫu nhiên
 *   npm run db:analytics-reader -- mat-khau     dùng mật khẩu này
 *
 * Tài khoản chỉ đọc được 4 view trong schema analytics_src (migration
 * 20261031150000_analytics_source_views), phiên mặc định read-only. Cùng nội dung với
 * prisma/sql/analytics-reader.sql cho ai quen dùng psql.
 */

const ROLE = "analytics_reader";

async function main(): Promise<void> {
  const password = process.argv[2] ?? randomBytes(18).toString("base64url");
  if (password.length < 12) throw new Error("Mật khẩu tối thiểu 12 ký tự");

  const views = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) FROM information_schema.views WHERE table_schema = 'analytics_src'`;
  if (Number(views[0]?.count ?? 0) < 4) {
    throw new Error("Chưa có schema analytics_src: chạy npm run db:migrate trước");
  }

  const exists = await prisma.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`;
  // format(%L) để PostgreSQL tự đặt mật khẩu vào câu lệnh an toàn (lệnh ROLE không nhận tham số $1).
  const verb = exists.length ? "ALTER" : "CREATE";
  const [statement] = await prisma.$queryRaw<Array<{ sql: string }>>`
    SELECT format('%s ROLE analytics_reader LOGIN PASSWORD %L', ${verb}::text, ${password}::text) AS sql`;
  await prisma.$executeRawUnsafe(statement!.sql);
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA analytics_src TO ${ROLE}`);
  await prisma.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA analytics_src TO ${ROLE}`);
  await prisma.$executeRawUnsafe(`ALTER ROLE ${ROLE} SET default_transaction_read_only = on`);
  await prisma.$executeRawUnsafe(`ALTER ROLE ${ROLE} SET statement_timeout = '60s'`);

  const url = new URL(process.env["DATABASE_URL"] ?? "");
  url.username = ROLE;
  url.password = password;
  url.search = "";
  console.log(`${exists.length ? "Đã đặt lại mật khẩu" : "Đã tạo"} tài khoản chỉ đọc ${ROLE}.`);
  console.log("\nChuỗi kết nối cho analytics-service (giữ bí mật, không đưa lên git):\n");
  console.log(`  ${url.toString()}\n`);
  console.log("PowerShell, trong thư mục analytics-service:");
  console.log('  $env:ANALYTICS_SOURCE = "postgres"');
  console.log(`  $env:ANALYTICS_PG_DSN = "${url.toString()}"`);
  console.log("  .venv\\Scripts\\python main.py serve");
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      /permission denied|must have CREATEROLE|insufficient privilege/i.test(message)
        ? `Tài khoản trong DATABASE_URL không được tạo tài khoản mới (${message}).\n` +
            "Chạy lại với DATABASE_URL của tài khoản postgres (quản trị), hoặc cấp quyền: ALTER ROLE <tài khoản> CREATEROLE;"
        : message,
    );
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
