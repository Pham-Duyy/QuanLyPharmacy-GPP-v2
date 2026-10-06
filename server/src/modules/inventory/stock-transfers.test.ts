import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { hashPassword } from "../../lib/password.js";
import { buildTransferInPayload, buildTransferOutPayload } from "../national-sync/nds-payload.js";
import { scanDocuments } from "../national-sync/nds-queue.service.js";
import {
  TEST_PASSWORD,
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  type Fixture,
} from "../../test/helpers.js";

let fixture: Fixture;
let khoA: string;
let khoB: string;
let pharmacistToken: string;
let productId: string;
let pillId: string;
let boxId: string;

const idem = () => ({ "Idempotency-Key": randomUUID() });
const atA = (token = khoA) => ({ ...authHeaders(token, fixture.storeId), ...idem() });
const atB = (token = khoB) => ({ ...authHeaders(token, fixture.otherStoreId), ...idem() });

function dayOffset(days: number): Date {
  const vnToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(
    new Date(),
  );
  const date = new Date(`${vnToday}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

async function batchAt(
  storeId: string,
  batchNumber: string,
  quantity: number,
  unitCost: number | null,
  expiryDays = 400,
) {
  return prisma.batch.create({
    data: {
      storeId,
      productId,
      batchNumber,
      expiryDate: dayOffset(expiryDays),
      quantityOnHand: quantity,
      unitCost: unitCost === null ? null : new Prisma.Decimal(unitCost),
    },
  });
}

async function warehouseUser(username: string, storeId: string): Promise<string> {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: "warehouse_staff" } });
  const user = await prisma.user.create({
    data: {
      username,
      passwordHash: await hashPassword(TEST_PASSWORD),
      fullName: `Kho ${username}`,
      defaultStoreId: storeId,
    },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, storeId } });
  return (await login(username)).token;
}

const draft = (
  lines: Array<{ batchId: string; unitId?: string; quantity: number }>,
  token = khoA,
) =>
  api()
    .post("/api/v1/stock-transfers")
    .set(atA(token))
    .send({
      toStoreId: fixture.otherStoreId,
      lines: lines.map((line) => ({ unitId: pillId, ...line })),
    });
const ship = (id: string, token = khoA) =>
  api().post(`/api/v1/stock-transfers/${id}/ship`).set(atA(token)).send({});
const receive = (id: string, body: Record<string, unknown>, token = khoB) =>
  api().post(`/api/v1/stock-transfers/${id}/receive`).set(atB(token)).send(body);

/** Lập, xuất và trả về phiếu đang chuyển. */
async function shipped(lines: Array<{ batchId: string; unitId?: string; quantity: number }>) {
  const created = await draft(lines).expect(201);
  return (await ship(created.body.data.id).expect(200)).body.data as {
    id: string;
    code: string;
    lines: Array<{ id: string; baseQuantity: number; batchNumber: string }>;
  };
}

const fullReceipt = (transfer: { lines: Array<{ id: string; baseQuantity: number }> }) => ({
  lines: transfer.lines.map((line) => ({
    lineId: line.id,
    receivedBaseQuantity: line.baseQuantity,
    passed: true,
  })),
});

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  const category = await prisma.category.create({ data: { name: "Thuốc giảm đau" } });
  const product = await prisma.product.create({
    data: {
      code: "TH0001",
      name: "Paracetamol 500mg",
      productType: "DRUG",
      drugClass: "OTC",
      categoryId: category.id,
      units: {
        create: [
          { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true },
          { name: "Hộp", conversionToBase: 100 },
        ],
      },
    },
    include: { units: true },
  });
  productId = product.id;
  pillId = product.units.find((unit) => unit.name === "Viên")!.id;
  boxId = product.units.find((unit) => unit.name === "Hộp")!.id;
  await prisma.productPrice.create({
    data: {
      productUnitId: pillId,
      salePrice: 1000n,
      vatRatePercent: 5,
      effectiveFrom: new Date(Date.now() - 86_400_000),
    },
  });
  [khoA, khoB, pharmacistToken] = await Promise.all([
    warehouseUser("khoa", fixture.storeId),
    warehouseUser("khob", fixture.otherStoreId),
    login("duocsi").then((item) => item.token),
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Chuyển hàng giữa cửa hàng — luồng chính", () => {
  it("nháp chưa trừ tồn; xuất trừ tồn nơi gửi; nhận đủ thì nơi nhận có lô cùng số lô, hạn dùng, giá vốn", async () => {
    const source = await batchAt(fixture.storeId, "L1", 300, 1200);

    const created = await draft([{ batchId: source.id, unitId: boxId, quantity: 2 }]).expect(201);
    expect(created.body.data).toMatchObject({
      status: "DRAFT",
      direction: "OUT",
      fromStore: { code: "NT01" },
      toStore: { code: "NT02" },
    });
    expect(created.body.data.code).toMatch(/^CK-NT01-\d{8}-0001$/);
    expect(
      (await prisma.batch.findUniqueOrThrow({ where: { id: source.id } })).quantityOnHand,
    ).toBe(300);

    const out = await ship(created.body.data.id).expect(200);
    // Nhân viên kho không có quyền xem giá vốn: API ẩn, nhưng phiếu vẫn chụp giá vốn lúc xuất.
    expect(out.body.data).toMatchObject({ status: "IN_TRANSIT", totalValue: null });
    expect(
      (await prisma.stockTransfer.findUniqueOrThrow({ where: { id: created.body.data.id } }))
        .totalValue,
    ).toBe(240000n);
    expect(
      (await prisma.batch.findUniqueOrThrow({ where: { id: source.id } })).quantityOnHand,
    ).toBe(100);
    expect(
      await prisma.stockMovement.findFirst({ where: { batchId: source.id, type: "TRANSFER_OUT" } }),
    ).toMatchObject({
      baseQuantity: -200,
      balanceAfter: 100,
    });

    const incoming = await api()
      .get("/api/v1/stock-transfers?direction=IN")
      .set(authHeaders(khoB, fixture.otherStoreId))
      .expect(200);
    expect(incoming.body.data.map((row: { id: string }) => row.id)).toEqual([created.body.data.id]);
    const count = await api()
      .get("/api/v1/stock-transfers/incoming-count")
      .set(authHeaders(khoB, fixture.otherStoreId))
      .expect(200);
    expect(count.body.data.inTransit).toBe(1);

    const received = await receive(created.body.data.id, fullReceipt(out.body.data)).expect(200);
    expect(received.body.data).toMatchObject({ status: "RECEIVED", direction: "IN" });

    const destination = await prisma.batch.findFirstOrThrow({
      where: { storeId: fixture.otherStoreId, batchNumber: "L1" },
    });
    expect(destination).toMatchObject({
      quantityOnHand: 200,
      status: "AVAILABLE",
      sourceType: "STOCK_TRANSFER",
    });
    expect(destination.expiryDate.getTime()).toBe(source.expiryDate.getTime());
    expect(Number(destination.unitCost)).toBe(1200);
    expect(
      await prisma.stockMovement.findFirst({
        where: { batchId: destination.id, type: "TRANSFER_IN" },
      }),
    ).toMatchObject({
      baseQuantity: 200,
      balanceAfter: 200,
    });
  });

  it("nhập vào lô đã có ở nơi nhận thì cộng dồn và tính giá vốn bình quân", async () => {
    const source = await batchAt(fixture.storeId, "L1", 100, 1000);
    const existing = await batchAt(fixture.otherStoreId, "L1", 100, 2000);
    const transfer = await shipped([{ batchId: source.id, quantity: 100 }]);
    await receive(transfer.id, fullReceipt(transfer)).expect(200);

    const merged = await prisma.batch.findUniqueOrThrow({ where: { id: existing.id } });
    expect(merged.quantityOnHand).toBe(200);
    expect(Number(merged.unitCost)).toBe(1500);
  });

  it("nhận thiếu phải ghi lý do; phần thiếu là hao hụt, không cộng lại nơi gửi; hàng không đạt vào biệt trữ", async () => {
    const good = await batchAt(fixture.storeId, "L1", 100, 1000);
    const bad = await batchAt(fixture.storeId, "L2", 50, 1000);
    const transfer = await shipped([
      { batchId: good.id, quantity: 100 },
      { batchId: bad.id, quantity: 50 },
    ]);
    const [lineGood, lineBad] = [
      transfer.lines.find((l) => l.batchNumber === "L1")!,
      transfer.lines.find((l) => l.batchNumber === "L2")!,
    ];
    const lines = [
      { lineId: lineGood.id, receivedBaseQuantity: 90, passed: true },
      { lineId: lineBad.id, receivedBaseQuantity: 50, passed: false, rejectReason: "Vỏ hộp ướt" },
    ];

    const missingNote = await receive(transfer.id, { lines }).expect(422);
    expect(missingNote.body.error.message).toContain("lý do hao hụt");
    const missingReason = await receive(transfer.id, {
      note: "Rơi vỡ khi vận chuyển",
      lines: [lines[0], { ...lines[1], rejectReason: null }],
    }).expect(422);
    expect(missingReason.body.error.message).toContain("không đạt");

    const done = await receive(transfer.id, {
      note: "Rơi vỡ 10 viên khi vận chuyển",
      lines,
    }).expect(200);
    expect(
      done.body.data.lines.find((l: { batchNumber: string }) => l.batchNumber === "L1"),
    ).toMatchObject({
      receivedBaseQuantity: 90,
      shortageBaseQuantity: 10,
    });
    expect(
      (
        await prisma.batch.findFirstOrThrow({
          where: { storeId: fixture.otherStoreId, batchNumber: "L1" },
        })
      ).quantityOnHand,
    ).toBe(90);
    expect(
      await prisma.batch.findFirstOrThrow({
        where: { storeId: fixture.otherStoreId, batchNumber: "L2" },
      }),
    ).toMatchObject({
      status: "QUARANTINED",
      note: "Vỏ hộp ướt",
      quantityOnHand: 50,
    });
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: good.id } })).quantityOnHand).toBe(
      0,
    );
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "STOCK_TRANSFER_RECEIVE" },
    });
    expect(audit.reason).toBe("Rơi vỡ 10 viên khi vận chuyển");
  });

  it("không nhận quá số đã gửi, không nhận thiếu dòng, không nhận hai lần", async () => {
    const source = await batchAt(fixture.storeId, "L1", 100, 1000);
    const transfer = await shipped([{ batchId: source.id, quantity: 40 }]);
    await receive(transfer.id, {
      lines: [{ lineId: transfer.lines[0]!.id, receivedBaseQuantity: 41, passed: true }],
    }).expect(422);
    await receive(transfer.id, {
      lines: [{ lineId: randomUUID(), receivedBaseQuantity: 40, passed: true }],
    }).expect(422);
    await receive(transfer.id, fullReceipt(transfer)).expect(200);
    const again = await receive(transfer.id, fullReceipt(transfer)).expect(409);
    expect(again.body.error.code).toBe("INVALID_STATE");
    expect(
      (await prisma.batch.findFirstOrThrow({ where: { storeId: fixture.otherStoreId } }))
        .quantityOnHand,
    ).toBe(40);
  });
});

describe("Chuyển hàng — hủy và thu hồi phiếu", () => {
  it("thu hồi phiếu đang chuyển thì hàng về lại đúng lô cũ; đã nhận thì không hủy được", async () => {
    const source = await batchAt(fixture.storeId, "L1", 100, 1000);
    const transfer = await shipped([{ batchId: source.id, quantity: 60 }]);

    await api()
      .post(`/api/v1/stock-transfers/${transfer.id}/cancel`)
      .set(atA())
      .send({})
      .expect(422);
    const cancelled = await api()
      .post(`/api/v1/stock-transfers/${transfer.id}/cancel`)
      .set(atA())
      .send({ reason: "Xe giao hàng không đi" })
      .expect(200);
    expect(cancelled.body.data).toMatchObject({
      status: "CANCELLED",
      cancelReason: "Xe giao hàng không đi",
    });
    expect(
      (await prisma.batch.findUniqueOrThrow({ where: { id: source.id } })).quantityOnHand,
    ).toBe(100);
    expect(
      await prisma.stockMovement.findFirst({
        where: { batchId: source.id, type: "TRANSFER_CANCEL" },
      }),
    ).toMatchObject({
      baseQuantity: 60,
      balanceAfter: 100,
    });
    await receive(transfer.id, fullReceipt(transfer)).expect(409);

    const second = await shipped([{ batchId: source.id, quantity: 10 }]);
    await receive(second.id, fullReceipt(second)).expect(200);
    const late = await api()
      .post(`/api/v1/stock-transfers/${second.id}/cancel`)
      .set(atA())
      .send({ reason: "Đổi ý" })
      .expect(409);
    expect(late.body.error.message).toContain("chuyển ngược");
  });

  it("cửa hàng nhận không hủy được phiếu, cửa hàng gửi không tự nhận được", async () => {
    const source = await batchAt(fixture.storeId, "L1", 100, 1000);
    const transfer = await shipped([{ batchId: source.id, quantity: 10 }]);
    await api()
      .post(`/api/v1/stock-transfers/${transfer.id}/cancel`)
      .set(atB())
      .send({ reason: "x" })
      .expect(404);
    const self = await api()
      .post(`/api/v1/stock-transfers/${transfer.id}/receive`)
      .set({ ...authHeaders((await login("admin")).token, fixture.storeId), ...idem() })
      .send(fullReceipt(transfer))
      .expect(404);
    expect(self.body.error.code).toBe("NOT_FOUND");
  });
});

describe("Chuyển hàng — chặn lô không được chuyển", () => {
  it("chặn thuốc kiểm soát đặc biệt, lô thu hồi, lô biệt trữ, lô hết hạn và chuyển cho chính mình", async () => {
    const recalled = await batchAt(fixture.storeId, "R1", 10, 1000);
    await prisma.batch.update({ where: { id: recalled.id }, data: { status: "RECALLED" } });
    const quarantined = await batchAt(fixture.storeId, "Q1", 10, 1000);
    await prisma.batch.update({ where: { id: quarantined.id }, data: { status: "QUARANTINED" } });
    const expired = await batchAt(fixture.storeId, "E1", 10, 1000, -1);

    for (const [batch, text] of [
      [recalled, "thu hồi"],
      [quarantined, "biệt trữ"],
      [expired, "hết hạn"],
    ] as const) {
      const response = await draft([{ batchId: batch.id, quantity: 1 }]).expect(422);
      expect(response.body.error).toMatchObject({ code: "BATCH_NOT_TRANSFERABLE" });
      expect(response.body.error.message).toContain(text);
    }

    await prisma.product.update({ where: { id: productId }, data: { drugClass: "CONTROLLED" } });
    const controlled = await batchAt(fixture.storeId, "C1", 10, 1000);
    const blocked = await draft([{ batchId: controlled.id, quantity: 1 }]).expect(422);
    expect(blocked.body.error.message).toContain("kiểm soát đặc biệt");

    const transferable = await api()
      .get("/api/v1/stock-transfers/transferable")
      .set(authHeaders(khoA, fixture.storeId))
      .expect(200);
    expect(transferable.body.data).toEqual([]);

    await prisma.product.update({ where: { id: productId }, data: { drugClass: "OTC" } });
    const ok = await batchAt(fixture.storeId, "OK1", 10, 1000);
    const self = await api()
      .post("/api/v1/stock-transfers")
      .set(atA())
      .send({
        toStoreId: fixture.storeId,
        lines: [{ batchId: ok.id, unitId: pillId, quantity: 1 }],
      })
      .expect(422);
    expect(self.body.error.message).toContain("khác cửa hàng");
    expect(await prisma.stockTransfer.count()).toBe(0);
  });

  it("bán bớt sau khi lập nháp thì xuất báo thiếu hàng, phiếu vẫn là nháp", async () => {
    const source = await batchAt(fixture.storeId, "L1", 20, 1000);
    const created = await draft([{ batchId: source.id, quantity: 15 }]).expect(201);
    await api()
      .post("/api/v1/invoices")
      .set({ ...authHeaders(pharmacistToken, fixture.storeId), ...idem() })
      .send({ lines: [{ productId, unitId: pillId, quantity: 10 }] })
      .expect(201);

    const response = await ship(created.body.data.id).expect(409);
    expect(response.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(
      (await prisma.stockTransfer.findUniqueOrThrow({ where: { id: created.body.data.id } }))
        .status,
    ).toBe("DRAFT");
    expect(
      (await prisma.batch.findUniqueOrThrow({ where: { id: source.id } })).quantityOnHand,
    ).toBe(10);
  });

  it("hai lệnh xuất cùng lúc cho một phiếu chỉ trừ tồn một lần", async () => {
    const source = await batchAt(fixture.storeId, "L1", 100, 1000);
    const created = await draft([{ batchId: source.id, quantity: 30 }]).expect(201);
    const results = await Promise.all([ship(created.body.data.id), ship(created.body.data.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (await prisma.batch.findUniqueOrThrow({ where: { id: source.id } })).quantityOnHand,
    ).toBe(70);
  });

  it("lô bị thu hồi trong lúc hàng trên đường thì về tới nơi nhận cũng bị khóa ngay", async () => {
    const source = await batchAt(fixture.storeId, "L1", 100, 1000);
    const transfer = await shipped([{ batchId: source.id, quantity: 40 }]);

    const admin = (await login("admin")).token;
    await api()
      .post("/api/v1/recalls")
      .set({ ...authHeaders(admin, fixture.storeId), ...idem() })
      .send({
        documentNumber: "01/QLD",
        issuedAt: "2026-10-06",
        items: [{ productId, batchNumber: "L1" }],
      })
      .expect(201);

    await receive(transfer.id, fullReceipt(transfer)).expect(200);
    const destination = await prisma.batch.findFirstOrThrow({
      where: { storeId: fixture.otherStoreId, batchNumber: "L1" },
    });
    expect(destination.status).toBe("RECALLED");
    expect(destination.recallId).not.toBeNull();
  });
});

describe("Chuyển hàng — phân quyền và phạm vi cửa hàng", () => {
  it("dược sĩ không lập được; người kho cửa hàng A không nhận thay cửa hàng B", async () => {
    const source = await batchAt(fixture.storeId, "L1", 100, 1000);
    await draft([{ batchId: source.id, quantity: 1 }], pharmacistToken).expect(403);

    const transfer = await shipped([{ batchId: source.id, quantity: 10 }]);
    await api()
      .post(`/api/v1/stock-transfers/${transfer.id}/receive`)
      .set({ ...authHeaders(khoA, fixture.otherStoreId), ...idem() })
      .send(fullReceipt(transfer))
      .expect(403);
  });

  it("cửa hàng nhận không thấy phiếu nháp; cửa hàng thứ ba không thấy phiếu", async () => {
    const source = await batchAt(fixture.storeId, "L1", 100, 1000);
    const created = await draft([{ batchId: source.id, quantity: 10 }]).expect(201);
    await api()
      .get(`/api/v1/stock-transfers/${created.body.data.id}`)
      .set(authHeaders(khoB, fixture.otherStoreId))
      .expect(404);
    const incoming = await api()
      .get("/api/v1/stock-transfers?direction=IN")
      .set(authHeaders(khoB, fixture.otherStoreId))
      .expect(200);
    expect(incoming.body.data).toEqual([]);

    await ship(created.body.data.id).expect(200);
    await api()
      .get(`/api/v1/stock-transfers/${created.body.data.id}`)
      .set(authHeaders(khoB, fixture.otherStoreId))
      .expect(200);

    const third = await prisma.store.create({
      data: { code: "NT03", name: "Nhà thuốc kiểm thử 3" },
    });
    const admin = (await login("admin")).token;
    await api()
      .get(`/api/v1/stock-transfers/${created.body.data.id}`)
      .set(authHeaders(admin, third.id))
      .expect(404);
  });

  it("không có quyền xem giá vốn thì không thấy giá trị phiếu", async () => {
    const source = await batchAt(fixture.storeId, "L1", 100, 1000);
    const transfer = await shipped([{ batchId: source.id, quantity: 10 }]);
    const view = await api()
      .get(`/api/v1/stock-transfers/${transfer.id}`)
      .set(authHeaders(khoB, fixture.otherStoreId))
      .expect(200);
    expect(view.body.data.totalValue).toBeNull();
    expect(view.body.data.lines[0].unitCost).toBeNull();
  });
});

describe("Chuyển hàng — liên thông CSDL Dược", () => {
  it("nơi gửi gửi phiếu xuất transfer-out, nơi nhận gửi phiếu nhập transfer-in theo số thực nhận", async () => {
    await prisma.nationalDrugLink.create({
      data: { productId, drugId: "D001", unitId: "U01", matchedBy: "REGISTRATION_NUMBER" },
    });
    for (const storeId of [fixture.storeId, fixture.otherStoreId]) {
      await prisma.nationalSyncStoreConfig.create({ data: { storeId, startDate: dayOffset(-30) } });
    }
    const source = await batchAt(fixture.storeId, "L1", 100, 1234.5);
    const transfer = await shipped([{ batchId: source.id, quantity: 50 }]);

    const out = await buildTransferOutPayload(transfer.id);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.payload).toMatchObject({
        reason: "transfer-out",
        reference_number: transfer.code,
      });
      expect((out.payload as { note?: string }).note).toContain("Chuyển đến NT02");
      expect((out.payload as { items: unknown[] }).items[0]).toMatchObject({
        quantity: 50,
        batch_no: "L1",
        price: 1234.5,
      });
    }

    let scan = await scanDocuments();
    expect(scan.byType).toEqual({ stock_transfer_out: 1 });

    await receive(transfer.id, {
      note: "Thiếu 5 viên",
      lines: [{ lineId: transfer.lines[0]!.id, receivedBaseQuantity: 45, passed: true }],
    }).expect(200);
    const inbound = await buildTransferInPayload(transfer.id);
    expect(
      inbound.ok && (inbound.payload as { items: Array<{ quantity: number }> }).items[0]!.quantity,
    ).toBe(45);

    scan = await scanDocuments();
    expect(scan.byType).toEqual({ stock_transfer_in: 1 });
    const jobs = await prisma.nationalSyncJob.findMany({ orderBy: { createdAt: "asc" } });
    expect(jobs.map((job) => [job.sourceType, job.storeId, job.reason])).toEqual([
      ["stock_transfer_out", fixture.storeId, "transfer-out"],
      ["stock_transfer_in", fixture.otherStoreId, "transfer-in"],
    ]);
  });

  it("phiếu đã gửi phiếu xuất lên rồi bị thu hồi thì đánh dấu cần xử lý tay", async () => {
    await prisma.nationalSyncStoreConfig.create({
      data: { storeId: fixture.storeId, startDate: dayOffset(-30) },
    });
    const source = await batchAt(fixture.storeId, "L1", 100, 1000);
    const transfer = await shipped([{ batchId: source.id, quantity: 10 }]);
    await scanDocuments();
    await prisma.nationalSyncJob.updateMany({ data: { status: "ACCEPTED" } });

    await api()
      .post(`/api/v1/stock-transfers/${transfer.id}/cancel`)
      .set(atA())
      .send({ reason: "Xe hỏng" })
      .expect(200);
    const scan = await scanDocuments();
    expect(scan.needsReview).toBe(1);
    expect((await prisma.nationalSyncJob.findFirstOrThrow()).status).toBe("NEEDS_REVIEW");
  });
});
