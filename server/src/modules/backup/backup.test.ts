import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../../test/helpers.js";
import { backupRoot } from "./backup.runner.js";
import { BACKUP_SETTINGS_KEY, nextRunAt, runners } from "./backup.service.js";

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;

const h = (token = adminToken) => authHeaders(token, fixture.storeId);
const realRunners = { ...runners };

/** pg_dump giả: test không cần cài PostgreSQL client hay bật Docker. */
function fakeDump(content = "PGDMP giả lập"): void {
  runners.dumpDatabase = async (target: string) => {
    await writeFile(target, content);
  };
  runners.copyStorage = async (target: string) => {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "anh-thu-nghiem.jpg"), "abc");
    return { bytes: 3, files: 1 };
  };
}

beforeEach(async () => {
  await truncateAll();
  await rm(backupRoot(), { recursive: true, force: true });
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
  pharmacistToken = (await login("duocsi")).token;
  fakeDump();
});

afterEach(() => {
  Object.assign(runners, realRunners);
});

afterAll(async () => {
  await rm(backupRoot(), { recursive: true, force: true });
  await prisma.$disconnect();
});

const run = (token = adminToken) => api().post("/api/v1/backups").set(h(token));
const overview = async (token = adminToken) => (await api().get("/api/v1/backups").set(h(token)).expect(200)).body.data;

describe("Quyền sao lưu", () => {
  it("chỉ vai trò có quyền sao lưu mới xem, chạy và tải được", async () => {
    await api().get("/api/v1/backups").set(h(pharmacistToken)).expect(403);
    await run(pharmacistToken).expect(403);
    await api().put("/api/v1/backups/settings").set(h(pharmacistToken)).send({}).expect(403);
    await api().get("/api/v1/backups").expect(401);
    await api().get("/api/v1/backups").set(h()).expect(200);
  });
});

describe("Tình trạng bảo vệ dữ liệu", () => {
  it("chưa có bản nào thì cảnh báo và chỉ rõ lịch chạy kế tiếp", async () => {
    const { status, items } = await overview();
    expect(items).toEqual([]);
    expect(status.lastSuccessAt).toBeNull();
    expect(status.isStale).toBe(true);
    expect(status.settings).toMatchObject({ enabled: true, hour: 22, keepCount: 14 });
    expect(new Date(status.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(status.restoreCommands.join(" ")).toContain("pg_restore");
    expect(status.backupDir).toContain("gpp-test-backups");
  });

  it("lịch kế tiếp tính theo giờ Việt Nam, tắt lịch thì không có", () => {
    const settings = { enabled: true, hour: 22, minute: 0, keepCount: 14, includeStorage: true, staleAfterHours: 36 };
    // 10:00 giờ VN ngày 23/09 → mốc kế tiếp là 22:00 cùng ngày (15:00 UTC).
    const next = nextRunAt(settings, new Date("2026-09-23T03:00:00.000Z"))!;
    expect(next.toISOString()).toBe("2026-09-23T15:00:00.000Z");
    // 23:00 giờ VN → đã qua mốc, chuyển sang hôm sau.
    expect(nextRunAt(settings, new Date("2026-09-23T16:00:00.000Z"))!.toISOString()).toBe("2026-09-24T15:00:00.000Z");
    expect(nextRunAt({ ...settings, enabled: false })).toBeNull();
  });
});

describe("Chạy sao lưu", () => {
  it("sao lưu ngay: ghi tệp dump, sao chép ảnh, ghi nhật ký và hướng dẫn phục hồi", async () => {
    const response = await run().expect(201);
    const { backup, restoreCommands } = response.body.data;
    expect(backup).toMatchObject({ status: "SUCCESS", trigger: "MANUAL" });
    expect(backup.folderName).toMatch(/^sao-luu-\d{4}-\d{2}-\d{2}-\d{6}$/);
    expect(Number(backup.databaseBytes)).toBeGreaterThan(0);
    expect(backup.storageFiles).toBe(1);
    expect(restoreCommands.join(" ")).toContain(backup.folderName);

    const folder = path.join(backupRoot(), backup.folderName);
    expect((await stat(path.join(folder, "database.dump"))).size).toBeGreaterThan(0);
    expect(await readdir(path.join(folder, "storage"))).toEqual(["anh-thu-nghiem.jpg"]);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "BACKUP_RUN" } });
    expect(audit.actorId).toBe(fixture.adminId);

    const { status, items } = await overview();
    expect(items).toHaveLength(1);
    expect(items[0].actor.fullName).toBe("Quản trị");
    expect(status.isStale).toBe(false);
    expect(status.keptCount).toBe(1);
    expect(status.totalBytes).toBeGreaterThan(0);
  });

  it("dump lỗi: không giữ thư mục dở dang, ghi rõ lý do để người dùng biết cần sửa gì", async () => {
    runners.dumpDatabase = async () => {
      throw new Error('Không tìm thấy lệnh "pg_dump"');
    };
    await run().expect(500);

    const failed = await prisma.backup.findFirstOrThrow();
    expect(failed.status).toBe("FAILED");
    expect(failed.errorText).toContain("pg_dump");
    expect(await readdir(backupRoot()).catch(() => [])).toEqual([]);
    expect(await prisma.auditLog.count({ where: { action: "BACKUP_FAILED" } })).toBe(1);

    const { status } = await overview();
    expect(status.isStale).toBe(true);
    expect(status.lastAttempt.status).toBe("FAILED");
  });

  it("không chạy hai lượt cùng lúc", async () => {
    runners.dumpDatabase = async (target: string) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(target, "cham");
    };
    const [first, second] = await Promise.all([run(), run()]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(await prisma.backup.count()).toBe(1);
  });

  it("chỉ giữ số bản đã cài, bản cũ bị dọn tệp nhưng còn trong lịch sử", async () => {
    await api()
      .put("/api/v1/backups/settings")
      .set(h())
      .send({ enabled: true, hour: 23, minute: 30, keepCount: 2, includeStorage: false, staleAfterHours: 12 })
      .expect(200);

    for (let index = 0; index < 3; index++) await run().expect(201);

    const rows = await prisma.backup.findMany({ orderBy: { startedAt: "asc" } });
    expect(rows).toHaveLength(3);
    expect(rows[0]!.deletedAt).not.toBeNull();
    expect(rows[2]!.deletedAt).toBeNull();
    expect(await readdir(backupRoot())).toHaveLength(2);
    // Tắt sao lưu ảnh thì không tạo thư mục storage trong bản sao lưu.
    expect(await readdir(path.join(backupRoot(), rows[2]!.folderName))).toEqual(["database.dump"]);

    const { status } = await overview();
    expect(status.settings).toMatchObject({ hour: 23, minute: 30, keepCount: 2, includeStorage: false });
    expect(status.keptCount).toBe(2);
  });
});

describe("Tải bản sao lưu về máy khác", () => {
  it("tải được tệp dump và ghi nhật ký", async () => {
    const { backup } = (await run().expect(201)).body.data;
    const file = await api()
      .get(`/api/v1/backups/${backup.id}/download`)
      .set(h())
      .buffer(true)
      .parse((res: unknown, callback: (error: Error | null, body: Buffer) => void) => {
        const stream = res as NodeJS.ReadableStream;
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(file.headers["content-disposition"]).toContain(`${backup.folderName}.dump`);
    expect((file.body as Buffer).toString()).toContain("PGDMP");
    expect(await prisma.auditLog.count({ where: { action: "BACKUP_DOWNLOAD" } })).toBe(1);
  });

  it("báo rõ khi bản sao lưu không tồn tại, đã hỏng hoặc đã bị dọn", async () => {
    await api().get(`/api/v1/backups/${crypto.randomUUID()}/download`).set(h()).expect(404);

    runners.dumpDatabase = async () => {
      throw new Error("hỏng");
    };
    await run().expect(500);
    const failed = await prisma.backup.findFirstOrThrow({ where: { status: "FAILED" } });
    const response = await api().get(`/api/v1/backups/${failed.id}/download`).set(h()).expect(409);
    expect(response.body.error.message).toContain("không thành công");

    fakeDump();
    const { backup } = (await run().expect(201)).body.data;
    await rm(path.join(backupRoot(), backup.folderName), { recursive: true, force: true });
    const gone = await api().get(`/api/v1/backups/${backup.id}/download`).set(h()).expect(409);
    expect(gone.body.error.message).toContain("Không còn tệp trên đĩa");
  });
});

describe("Cài đặt lịch sao lưu", () => {
  it("kiểm tra giá trị và lưu kèm nhật ký", async () => {
    const bad = await api()
      .put("/api/v1/backups/settings")
      .set(h())
      .send({ enabled: true, hour: 25, minute: 0, keepCount: 14, includeStorage: true, staleAfterHours: 36 })
      .expect(422);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");

    const saved = await api()
      .put("/api/v1/backups/settings")
      .set(h())
      .send({ enabled: false, hour: 6, minute: 15, keepCount: 30, includeStorage: true, staleAfterHours: 48 })
      .expect(200);
    expect(saved.body.data.settings).toMatchObject({ enabled: false, hour: 6, minute: 15, keepCount: 30 });
    expect(saved.body.data.nextRunAt).toBeNull();

    const row = await prisma.setting.findFirstOrThrow({ where: { key: BACKUP_SETTINGS_KEY, storeId: null } });
    expect(row.value).toMatchObject({ hour: 6 });
    expect(await prisma.auditLog.count({ where: { action: "SETTING_UPDATE" } })).toBe(1);
  });
});
