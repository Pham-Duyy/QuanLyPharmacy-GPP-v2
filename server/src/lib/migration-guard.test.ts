import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkMigrationFiles } from "./migration-guard.js";

const SQL = "CREATE TABLE a (id int);\n-- chú thích\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

let dir: string;
function migration(name: string, content: string): void {
  mkdirSync(join(dir, name));
  writeFileSync(join(dir, name, "migration.sql"), content);
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("kiểm tra migration trước khi áp", () => {
  it("file LF, đã áp và trùng mã băm: không có vấn đề", () => {
    dir = mkdtempSync(join(tmpdir(), "mig-"));
    migration("001_a", SQL);
    migration("002_b", SQL);
    expect(checkMigrationFiles(dir, new Map([["001_a", sha(SQL)]]))).toEqual([]);
  });

  it("chặn file có xuống dòng CRLF, kể cả khi chưa áp", () => {
    dir = mkdtempSync(join(tmpdir(), "mig-"));
    migration("001_a", SQL.replace(/\n/g, "\r\n"));
    const problems = checkMigrationFiles(dir, new Map());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("CRLF");
  });

  it("chặn migration đã áp bị sửa, dù chỉ sửa chú thích", () => {
    dir = mkdtempSync(join(tmpdir(), "mig-"));
    migration("001_a", SQL.replace("chú thích", "chú thích đã sửa"));
    const problems = checkMigrationFiles(dir, new Map([["001_a", sha(SQL)]]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("migration mới");
  });

  it("migration chưa áp thì không đòi mã băm", () => {
    dir = mkdtempSync(join(tmpdir(), "mig-"));
    migration("001_a", SQL);
    migration("002_moi", "ALTER TABLE a ADD b int;\n");
    expect(checkMigrationFiles(dir, new Map([["001_a", sha(SQL)]]))).toEqual([]);
  });
});
