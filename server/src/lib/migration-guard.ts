import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Kiểm tra thư mục migration trước khi áp. Trả về danh sách vấn đề; rỗng là
 * an toàn. Tách khỏi script để kiểm thử được mà không cần CSDL.
 *
 * `applied`: tên migration đã áp → mã băm Prisma đã lưu lúc áp.
 */
export function checkMigrationFiles(dir: string, applied: ReadonlyMap<string, string>): string[] {
  const names = readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
  const problems: string[] = [];

  for (const name of names) {
    const bytes = readFileSync(join(dir, name, "migration.sql"));
    if (bytes.includes(0x0d)) {
      problems.push(`${name}: có ký tự xuống dòng CRLF. Đổi file về LF trước khi áp.`);
    }
    const stored = applied.get(name);
    if (stored !== undefined) {
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== stored) {
        problems.push(
          `${name}: đã áp nhưng nội dung file khác lúc áp (lưu ${stored.slice(0, 12)}…, file ${actual.slice(0, 12)}…). ` +
            "Khôi phục file như lúc áp và đưa thay đổi vào một migration mới.",
        );
      }
    }
  }

  return problems;
}

export function countMigrations(dir: string): number {
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory()).length;
}
