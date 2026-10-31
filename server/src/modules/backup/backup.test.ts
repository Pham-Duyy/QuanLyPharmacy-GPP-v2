import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGunzip, gzipSync } from "node:zlib";
import { createReadStream } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../db/pool.js";
import { prisma } from "../../db/prisma.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  type Fixture,
} from "../../test/helpers.js";
import { readHeader, writeBackup } from "./backup-file.js";
import { RestoreError, restoreBackup } from "./backup-restore.js";

/** Sao lưu và phục hồi trong phần mềm (Phase 7, D30). */

let f: Fixture;
let work: string;
let backupDir: string;
let storageDir: string;

beforeEach(async () => {
  await truncateAll();
  f = await seedFixture();
  work = await mkdtemp(path.join(tmpdir(), "gpp-backup-"));
  backupDir = path.join(work, "backups");
  storageDir = path.join(work, "storage");
  await mkdir(backupDir, { recursive: true });
  await mkdir(path.join(storageDir, "products", "p1"), { recursive: true });
  await writeFile(path.join(storageDir, "products", "p1", "anh.jpg"), Buffer.from([1, 2, 3, 255]));
  process.env["BACKUP_DIR"] = backupDir;
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env["BACKUP_DIR"];
  await prisma.$disconnect();
});

async function backup(kind: "manual" | "auto" = "manual") {
  const client = await pool.connect();
  try {
    return await writeBackup({ client, dir: backupDir, storageDir, kind, createdBy: f.adminId });
  } finally {
    client.release();
  }
}

async function restore(file: string) {
  const client = await pool.connect();
  try {
    return await restoreBackup({ client, file, storageDir });
  } finally {
    client.release();
  }
}

async function gunzipText(file: string): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(file).pipe(createGunzip()))
    chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

describe("Sao lưu rồi phục hồi", () => {
  it("dữ liệu, số thứ tự và tệp ảnh trở về đúng lúc sao lưu", async () => {
    await prisma.supplier.create({ data: { name: "Công ty A", taxCode: "0100108536" } });
    await prisma.customer.create({ data: { fullName: "Chị Lan", phone: "0901234567" } });
    const before = await prisma.customer.findFirstOrThrow();

    const result = await backup();
    expect(result.name).toMatch(/^sao-luu-\d{8}-\d{6}-thu-cong\.ndjson\.gz$/);
    expect(result.files).toBe(1);
    const header = await readHeader(path.join(backupDir, result.name));
    expect(header?.tables).toContain("customers");
    expect(header?.tables).not.toContain("_prisma_migrations");

    // Sau khi sao lưu: sửa, xóa, thêm, đổi tệp ảnh.
    await prisma.supplier.updateMany({ data: { name: "ĐÃ SỬA" } });
    await prisma.customer.create({ data: { fullName: "Khách mới" } });
    await prisma.store.update({ where: { id: f.otherStoreId }, data: { name: "Đổi tên" } });
    await writeFile(path.join(storageDir, "products", "p1", "anh.jpg"), Buffer.from("khac"));

    const restored = await restore(path.join(backupDir, result.name));
    expect(restored.rows).toBe(result.rows);

    expect((await prisma.supplier.findFirstOrThrow()).name).toBe("Công ty A");
    expect(await prisma.customer.count()).toBe(1);
    const customer = await prisma.customer.findFirstOrThrow();
    expect(customer.code).toBe(before.code);
    expect(customer.createdAt.toISOString()).toBe(before.createdAt.toISOString());
    expect((await prisma.store.findUniqueOrThrow({ where: { id: f.otherStoreId } })).name).not.toBe(
      "Đổi tên",
    );
    // Số thứ tự mã khách quay về: khách tạo sau phục hồi không trùng mã cũ.
    const next = await prisma.customer.create({ data: { fullName: "Sau phục hồi" } });
    expect(next.code).not.toBe(before.code);
    expect(await readFile(path.join(storageDir, "products", "p1", "anh.jpg"))).toEqual(
      Buffer.from([1, 2, 3, 255]),
    );
  });

  it("khóa ngoại được tạo lại đủ sau khi phục hồi", async () => {
    const count = async () =>
      Number(
        (
          await pool.query<{ n: string }>(
            "SELECT count(*) AS n FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace",
          )
        ).rows[0]?.n,
      );
    const before = await count();
    const result = await backup();
    await restore(path.join(backupDir, result.name));
    expect(await count()).toBe(before);
  });

  it("đăng xuất mọi phiên sau khi phục hồi", async () => {
    const { token } = await login("admin");
    const result = await backup();
    await restore(path.join(backupDir, result.name));
    expect(await prisma.refreshSession.count({ where: { revokedAt: null } })).toBe(0);
    expect(token).toBeTruthy();
  });
});

describe("Tệp hỏng không làm mất dữ liệu đang có", () => {
  it("tệp bị cắt cụt: hủy toàn bộ, dữ liệu hiện tại giữ nguyên", async () => {
    await prisma.supplier.create({ data: { name: "Công ty A" } });
    const result = await backup();
    const text = await gunzipText(path.join(backupDir, result.name));
    const cut = path.join(backupDir, "cat-cut.ndjson.gz");
    await writeFile(cut, gzipSync(text.slice(0, text.lastIndexOf('#{"type":"end"'))));

    await prisma.supplier.create({ data: { name: "Công ty B" } });
    await expect(restore(cut)).rejects.toBeInstanceOf(RestoreError);
    expect(await prisma.supplier.count()).toBe(2);
  });

  it("tệp không phải bản sao lưu bị từ chối", async () => {
    const bad = path.join(backupDir, "la.ndjson.gz");
    await writeFile(bad, gzipSync("không phải sao lưu"));
    await expect(restore(bad)).rejects.toThrow("Không phải tệp sao lưu");
  });

  it("bản sao lưu ở phiên bản CSDL khác bị từ chối", async () => {
    const result = await backup();
    const text = await gunzipText(path.join(backupDir, result.name));
    const other = path.join(backupDir, "khac-phien-ban.ndjson.gz");
    await writeFile(
      other,
      gzipSync(text.replace('"migrations":[', '"migrations":["29990101000000_tuong_lai",')),
    );
    await expect(restore(other)).rejects.toThrow("phiên bản phần mềm mới hơn");
  });
});

describe("API trang Sao lưu", () => {
  it("quản lý toàn chuỗi sao lưu ngay, xem danh sách, tải về; có ghi nhật ký", async () => {
    const { token } = await login("admin");
    const created = await api().post("/api/v1/backups").set(authHeaders(token)).expect(201);
    const name = created.body.data.name as string;

    const list = await api().get("/api/v1/backups").set(authHeaders(token)).expect(200);
    expect(list.body.data.dir).toBe(path.resolve(backupDir));
    expect(list.body.data.items.map((item: { name: string }) => item.name)).toContain(name);

    const download = await api()
      .get(`/api/v1/backups/${name}/download`)
      .set(authHeaders(token))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((download.body as Buffer).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));

    const actions = await prisma.auditLog.findMany({
      where: { resourceType: "backup" },
      select: { action: true },
    });
    expect(actions.map((a) => a.action).sort()).toEqual(["BACKUP_CREATE", "BACKUP_DOWNLOAD"]);
  });

  it("tên tệp lạ (dò đường dẫn) trả 404", async () => {
    const { token } = await login("admin");
    await api().get("/api/v1/backups/..%2F..%2F.env/download").set(authHeaders(token)).expect(404);
    await api()
      .get("/api/v1/backups/khong-co.ndjson.gz/download")
      .set(authHeaders(token))
      .expect(404);
  });

  it("dược sĩ không dùng được", async () => {
    const { token } = await login("duocsi");
    await api().get("/api/v1/backups").set(authHeaders(token)).expect(403);
    await api().post("/api/v1/backups").set(authHeaders(token)).expect(403);
  });
});
