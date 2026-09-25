import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../test/helpers.js";
import { idempotencyRequestHash, takeOverStaleKey } from "./idempotency.js";

/**
 * Khóa idempotency phải đúng trong cả bốn tình huống hỏng: gửi song song,
 * gửi lại sau khi mất response, tiến trình chết sau khi đã commit nghiệp vụ,
 * và hai người cùng tiếp quản một khóa treo.
 */

let fixture: Fixture;
let adminToken: string;
let productId: string;
let unitId: string;

const h = (storeId?: string) => authHeaders(adminToken, storeId ?? fixture.storeId);

function dayOffset(days: number): Date {
  const vnToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  const date = new Date(`${vnToday}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

const saleBody = () => ({ lines: [{ productId, unitId, quantity: 1 }] });

const sell = (key: string, storeId?: string) =>
  api()
    .post("/api/v1/invoices")
    .set({ ...h(storeId), "Idempotency-Key": key })
    .send(saleBody());

/** Chữ ký đúng như một lần gửi thật sẽ sinh ra. */
const saleHash = (storeId?: string) =>
  idempotencyRequestHash("POST", "/api/v1/invoices", storeId ?? fixture.storeId, saleBody());

/** Dựng một khóa treo: tiến trình trước chết giữa chừng, chưa ghi chứng từ nào. */
async function staleKey(key: string, options: { requestHash?: string } = {}) {
  return prisma.idempotencyKey.create({
    data: {
      key,
      userId: fixture.adminId,
      storeId: fixture.storeId,
      ownerToken: randomUUID(),
      method: "POST",
      path: "/api/v1/invoices",
      requestHash: options.requestHash ?? saleHash(),
      status: "IN_PROGRESS",
      expiresAt: new Date(Date.now() - 60_000),
    },
  });
}

const stockOf = async () =>
  (await prisma.batch.findFirstOrThrow({ where: { productId } })).quantityOnHand;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  adminToken = (await login("admin")).token;
  const categoryId = (await prisma.category.create({ data: { name: "Hàng nhà thuốc" } })).id;
  const product = await prisma.product.create({
    data: {
      code: "TH0001",
      name: "Paracetamol 500mg",
      productType: "DRUG",
      drugClass: "OTC",
      categoryId,
      units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  productId = product.id;
  unitId = product.units[0]!.id;
  await prisma.productPrice.create({
    data: { productUnitId: unitId, salePrice: 2000n, vatRatePercent: 5, effectiveFrom: dayOffset(-1) },
  });
  await prisma.batch.create({
    data: {
      storeId: fixture.storeId,
      productId,
      batchNumber: "LO1",
      expiryDate: dayOffset(400),
      quantityOnHand: 100,
      unitCost: 900,
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Khóa idempotency", () => {
  it("hai request song song cùng khóa chỉ tạo một hóa đơn", async () => {
    const key = randomUUID();
    const results = await Promise.allSettled([sell(key), sell(key)]);
    const statuses = results.map((item) => (item.status === "fulfilled" ? item.value.status : 0));

    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(await prisma.invoice.count()).toBe(1);
    expect(await stockOf()).toBe(99);
    // Request còn lại bị chặn, không phải lỗi 500.
    expect(statuses.some((status) => status === 409)).toBe(true);
  });

  it("gửi lại sau khi mất response nhận đúng kết quả cũ, không bán lần hai", async () => {
    const key = randomUUID();
    const first = await sell(key).expect(201);
    const again = await sell(key).expect(201);

    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await prisma.invoice.count()).toBe(1);
    expect(await stockOf()).toBe(99);
    expect(await prisma.idempotencyKey.findFirstOrThrow({ where: { key } })).toMatchObject({
      status: "COMPLETED",
      resourceType: "invoice",
    });
  });

  it("nghiệp vụ đã commit mà response lỗi thì lần gửi lại không tạo chứng từ thứ hai", async () => {
    const key = randomUUID();
    const first = await sell(key).expect(201);

    // Khóa đã gắn với hóa đơn ngay trong transaction bán hàng.
    const saved = await prisma.idempotencyKey.findFirstOrThrow({ where: { key } });
    expect(saved).toMatchObject({ resourceType: "invoice", resourceId: first.body.data.id });

    // Dựng lại đúng tình huống: tiến trình chết sau commit nên khóa còn dở
    // dang, chưa kịp lưu response. Để cả quá hạn để chắc chắn nó vẫn không
    // bị tiếp quản.
    await prisma.idempotencyKey.update({
      where: { id: saved.id },
      data: {
        status: "IN_PROGRESS",
        responseStatus: null,
        responseBody: Prisma.DbNull,
        completedAt: null,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const retry = await sell(key).expect(409);
    expect(retry.body.error.code).toBe("REQUEST_ALREADY_COMMITTED");
    expect(retry.body.error.details[0]).toMatchObject({
      resourceType: "invoice",
      resourceId: first.body.data.id,
    });
    expect(await prisma.invoice.count()).toBe(1);
    expect(await stockOf()).toBe(99);
    // Khóa vẫn còn nguyên, không bị xóa cũng không bị đổi chủ.
    expect(await prisma.idempotencyKey.findFirstOrThrow({ where: { key } })).toMatchObject({
      ownerToken: saved.ownerToken,
      resourceId: first.body.data.id,
    });
  });

  it("khóa hết hạn, đúng chữ ký, chưa ghi chứng từ: phải xử lý được", async () => {
    const key = randomUUID();
    const stale = await staleKey(key);

    const result = await sell(key).expect(201);

    expect(await prisma.invoice.count()).toBe(1);
    expect(await stockOf()).toBe(99);
    const after = await prisma.idempotencyKey.findFirstOrThrow({ where: { key } });
    expect(after).toMatchObject({ status: "COMPLETED", resourceId: result.body.data.id });
    // Đã đổi chủ: token cũ không còn hiệu lực.
    expect(after.ownerToken).not.toBe(stale.ownerToken);
  });

  it("khóa hết hạn nhưng khác chữ ký thì bị từ chối, không tiếp quản", async () => {
    const key = randomUUID();
    const stale = await staleKey(key, { requestHash: "chu-ky-cua-noi-dung-khac" });

    const result = await sell(key).expect(422);
    expect(result.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await prisma.invoice.count()).toBe(0);
    expect(await stockOf()).toBe(100);
    const after = await prisma.idempotencyKey.findFirstOrThrow({ where: { key } });
    expect(after.ownerToken).toBe(stale.ownerToken);
    expect(after.requestHash).toBe("chu-ky-cua-noi-dung-khac");
  });

  it("hai request cùng tiếp quản một khóa treo: chỉ một request được bán", async () => {
    const key = randomUUID();
    await staleKey(key);

    // Điều phối thứ tự thật sự: một transaction thứ ba giữ khóa hàng của bản
    // ghi idempotency, cả hai request đều phải dừng ở bước tiếp quản. Khi thả
    // ra, chúng chạy nối tiếp nhau — đúng tình huống nguy hiểm nhất.
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM idempotency_keys WHERE key = ${key} FOR UPDATE`;
        locked();
        await gate;
      },
      { timeout: 15_000 },
    );
    await ready;

    const pending = Promise.allSettled([sell(key), sell(key)]);

    // Chờ cả hai request thật sự đang nằm chờ khóa hàng mới thả.
    let waiters = 0;
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query ILIKE '%UPDATE%idempotency_keys%'`;
      waiters = rows[0]?.n ?? 0;
      if (waiters >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await holder;

    const results = await pending;
    const statuses = results.map((item) => (item.status === "fulfilled" ? item.value.status : 0));

    expect(waiters).toBe(2);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);
    // Chỉ một nghiệp vụ chạy: đúng một hóa đơn và tồn chỉ trừ một lần.
    expect(await prisma.invoice.count()).toBe(1);
    expect(await stockOf()).toBe(99);
    // Request thua không xóa mất khóa của request thắng.
    const after = await prisma.idempotencyKey.findFirstOrThrow({ where: { key } });
    expect(after.status).toBe("COMPLETED");
    expect(after.resourceType).toBe("invoice");
  });

  it("khóa đã đổi chủ thì chủ cũ không tiếp quản lại, không xóa và không ghi đè được", async () => {
    const key = randomUUID();
    const stale = await staleKey(key);

    // Cả hai request đều đã đọc được khóa treo này (cùng một bản đọc).
    const snapshot = { id: stale.id, ownerToken: stale.ownerToken };
    const patch = {
      storeId: fixture.storeId,
      method: "POST",
      path: "/api/v1/invoices",
      requestHash: saleHash(),
    };

    // R1 tiếp quản trước.
    const first = await takeOverStaleKey(snapshot, patch);
    expect(first).not.toBeNull();

    // R2 vẫn cầm bản đọc cũ: phải trượt. Nếu việc tiếp quản làm theo kiểu
    // "xóa rồi tạo lại" thì R2 sẽ xóa mất khóa của R1 và cùng chạy nghiệp vụ.
    const second = await takeOverStaleKey(snapshot, patch);
    expect(second).toBeNull();

    const removed = await prisma.idempotencyKey.deleteMany({
      where: {
        key,
        userId: fixture.adminId,
        ownerToken: stale.ownerToken,
        status: "IN_PROGRESS",
        resourceId: null,
      },
    });
    expect(removed.count).toBe(0);

    const survivor = await prisma.idempotencyKey.findFirstOrThrow({ where: { key } });
    expect(survivor.ownerToken).toBe(first);
    expect(await prisma.idempotencyKey.count({ where: { key } })).toBe(1);

    // Và R2 gửi lại qua HTTP thì bị chặn, không tạo hóa đơn thứ hai.
    const blocked = await sell(key).expect(409);
    expect(blocked.body.error.code).toBe("REQUEST_IN_PROGRESS");
    expect(await prisma.invoice.count()).toBe(0);
    expect(await stockOf()).toBe(100);
  });

  it("cùng một khóa nhưng khác cửa hàng không lấy được kết quả của cửa hàng kia", async () => {
    const key = randomUUID();
    await sell(key).expect(201);

    const other = await sell(key, fixture.otherStoreId).expect(422);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await prisma.invoice.count()).toBe(1);
  });

  it("thiếu header thì báo lỗi rõ ràng", async () => {
    const missing = await api()
      .post("/api/v1/invoices")
      .set(h())
      .send(saleBody())
      .expect(400);
    expect(missing.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});
