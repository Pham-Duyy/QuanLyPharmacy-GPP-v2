import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import { api, authHeaders, login, seedFixture, truncateAll, type Fixture } from "../../test/helpers.js";
import { summarize } from "./loyalty.service.js";

let fixture: Fixture;
let adminToken: string;
let pharmacistToken: string;
let salesToken: string;
let categoryId: string;
let customerId: string;

/** Thực phẩm chức năng: nằm trong chương trình tích điểm. */
let vitamin: { id: string; unitId: string };
/** Thuốc: mặc định KHÔNG được tích điểm. */
let para: { id: string; unitId: string };

const h = (token = adminToken) => authHeaders(token, fixture.storeId);
const idem = () => ({ "Idempotency-Key": randomUUID() });

function dayOffset(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return new Date(date.toISOString().slice(0, 10));
}

async function makeProduct(code: string, name: string, productType: string, price: number) {
  const product = await prisma.product.create({
    data: {
      code,
      name,
      productType,
      drugClass: productType === "DRUG" ? "OTC" : null,
      categoryId,
      units: { create: { name: "Viên", conversionToBase: 1, isDefaultSaleUnit: true } },
    },
    include: { units: true },
  });
  const unitId = product.units[0]!.id;
  await prisma.productPrice.create({
    data: {
      productUnitId: unitId,
      salePrice: BigInt(price),
      vatRatePercent: 5,
      effectiveFrom: dayOffset(-1),
    },
  });
  await prisma.batch.create({
    data: {
      storeId: fixture.storeId,
      productId: product.id,
      batchNumber: `LO-${code}`,
      expiryDate: dayOffset(365),
      quantityOnHand: 1000,
    },
  });
  return { id: product.id, unitId };
}

const settings = (patch: Record<string, unknown> = {}) => ({
  enabled: true,
  earnAmountPerPoint: 10_000,
  pointValue: 500,
  minRedeemPoints: 10,
  maxRedeemPercent: 50,
  expiryMonths: 12,
  earnOnDrugs: false,
  ...patch,
});

const saveSettings = (patch: Record<string, unknown> = {}, token = adminToken) =>
  api().put("/api/v1/loyalty/settings").set(h(token)).send(settings(patch));

const sell = (body: Record<string, unknown>, token = salesToken) =>
  api()
    .post("/api/v1/invoices")
    .set({ ...h(token), ...idem() })
    .send(body);

const line = (product: { id: string; unitId: string }, quantity: number) => ({
  productId: product.id,
  unitId: product.unitId,
  quantity,
});

const loyaltyOf = async (token = adminToken) =>
  (await api().get(`/api/v1/customers/${customerId}/loyalty`).set(h(token)).expect(200)).body.data;

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [adminToken, pharmacistToken, salesToken] = await Promise.all([
    login("admin").then((item) => item.token),
    login("duocsi").then((item) => item.token),
    login("banhang").then((item) => item.token),
  ]);

  categoryId = (await prisma.category.create({ data: { name: "Hàng nhà thuốc" } })).id;
  vitamin = await makeProduct("TPCN01", "Vitamin C 1000mg", "SUPPLEMENT", 10_000);
  para = await makeProduct("TH0001", "Paracetamol 500mg", "DRUG", 10_000);
  customerId = (await prisma.customer.create({ data: { fullName: "Chị Lan", phone: "0900000001" } }))
    .id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe("Cách tính số dư điểm", () => {
  const at = (iso: string) => new Date(iso);

  it("tiêu điểm theo lô hết hạn trước, lô hết hạn thì mất điểm", () => {
    const balance = summarize(
      [
        { points: 100, expiresAt: at("2026-03-01T00:00:00Z"), createdAt: at("2026-01-01T00:00:00Z") },
        { points: 50, expiresAt: at("2027-01-01T00:00:00Z"), createdAt: at("2026-01-05T00:00:00Z") },
        { points: -60, expiresAt: null, createdAt: at("2026-02-01T00:00:00Z") },
      ],
      at("2026-06-01T00:00:00Z"),
    );

    // 60 điểm đổi vào lô hết hạn 01/03; 40 điểm còn lại của lô đó mất hạn,
    // chỉ còn nguyên lô 50 điểm hạn 2027.
    expect(balance).toMatchObject({ available: 50, expired: 40, totalEarned: 150, totalRedeemed: 60 });
  });

  it("lô đã hết hạn không gánh cho lần đổi điểm xảy ra sau đó", () => {
    const balance = summarize(
      [
        { points: 100, expiresAt: at("2026-02-01T00:00:00Z"), createdAt: at("2026-01-01T00:00:00Z") },
        { points: 30, expiresAt: at("2027-01-01T00:00:00Z"), createdAt: at("2026-01-10T00:00:00Z") },
        { points: -30, expiresAt: null, createdAt: at("2026-05-01T00:00:00Z") },
      ],
      at("2026-06-01T00:00:00Z"),
    );

    // Lúc đổi điểm (01/05) lô 100 điểm đã hết hạn từ 01/02, nên 30 điểm phải
    // trừ vào lô còn hiệu lực — không thể còn dư 30 điểm.
    expect(balance).toMatchObject({ available: 0, expired: 100 });
  });

  it("đếm riêng số điểm sắp hết hạn trong 30 ngày", () => {
    const balance = summarize(
      [
        { points: 20, expiresAt: at("2026-06-20T00:00:00Z"), createdAt: at("2026-01-01T00:00:00Z") },
        { points: 40, expiresAt: at("2026-12-31T00:00:00Z"), createdAt: at("2026-01-01T00:00:00Z") },
        { points: 5, expiresAt: null, createdAt: at("2026-01-01T00:00:00Z") },
      ],
      at("2026-06-01T00:00:00Z"),
    );

    expect(balance.available).toBe(65);
    expect(balance.expiringSoon).toBe(20);
    expect(balance.nextExpiryAt?.toISOString()).toBe("2026-06-20T00:00:00.000Z");
  });
});

describe("Cài đặt tích điểm", () => {
  it("mặc định là tắt và không tính điểm cho hàng thuốc", async () => {
    const data = (await api().get("/api/v1/loyalty/settings").set(h()).expect(200)).body.data;
    expect(data).toMatchObject({ isDefault: true, settings: { enabled: false, earnOnDrugs: false } });
  });

  it("lưu được cài đặt, ghi audit và quầy bán đọc được", async () => {
    await saveSettings({ pointValue: 1000 }).expect(200);

    const forSales = (await api().get("/api/v1/loyalty/settings").set(h(salesToken)).expect(200)).body
      .data;
    expect(forSales).toMatchObject({ isDefault: false, settings: { enabled: true, pointValue: 1000 } });
    expect(await prisma.auditLog.count({ where: { action: "SETTING_UPDATE" } })).toBe(1);
  });

  it("chặn tỷ lệ quy đổi vô lý và người không có quyền", async () => {
    // 1 điểm đổi 9.000đ trong khi phải chi 10.000đ mới có 1 điểm: gần như
    // bán hàng không công, đây thường là gõ nhầm số.
    const bad = await saveSettings({ pointValue: 9000 }).expect(422);
    expect(JSON.stringify(bad.body.error)).toContain("quá cao");

    await saveSettings({}, salesToken).expect(403);
  });
});

describe("Tích điểm khi bán hàng", () => {
  it("chưa bật chương trình thì không sinh bút toán nào", async () => {
    await sell({ customerId, lines: [line(vitamin, 10)] }).expect(201);
    expect(await prisma.loyaltyTransaction.count()).toBe(0);
  });

  it("tích điểm theo tiền hàng, bỏ hàng thuốc ra ngoài", async () => {
    await saveSettings().expect(200);

    // 10 vitamin (100.000đ) + 5 thuốc (50.000đ): chỉ 100.000đ được tính điểm.
    await sell({ customerId, lines: [line(vitamin, 10), line(para, 5)] }).expect(201);

    const data = await loyaltyOf();
    expect(data.balance).toMatchObject({ available: 10, totalEarned: 10 });
    expect(data.transactions[0]).toMatchObject({ type: "EARN", points: 10, amount: 100000 });
    expect(data.transactions[0].expiresAt).not.toBeNull();
  });

  it("bật tính điểm cho hàng thuốc thì thuốc cũng được tính", async () => {
    await saveSettings({ earnOnDrugs: true }).expect(200);
    await sell({ customerId, lines: [line(vitamin, 10), line(para, 5)] }).expect(201);
    expect((await loyaltyOf()).balance.available).toBe(15);
  });

  it("khách lẻ không có hồ sơ thì không tích điểm", async () => {
    await saveSettings().expect(200);
    await sell({ lines: [line(vitamin, 10)] }).expect(201);
    expect(await prisma.loyaltyTransaction.count()).toBe(0);
  });

  it("điểm không hết hạn khi cài đặt để 0 tháng", async () => {
    await saveSettings({ expiryMonths: 0 }).expect(200);
    await sell({ customerId, lines: [line(vitamin, 10)] }).expect(201);
    expect((await loyaltyOf()).transactions[0].expiresAt).toBeNull();
  });
});

describe("Đổi điểm ở quầy", () => {
  /** Tích sẵn 30 điểm từ một hóa đơn 300.000đ. */
  async function earnPoints(): Promise<void> {
    await saveSettings().expect(200);
    await sell({ customerId, lines: [line(vitamin, 30)] }).expect(201);
  }

  it("trừ tiền theo giá trị điểm, lưu lên hóa đơn và trừ đúng số dư", async () => {
    await earnPoints();

    const sale = await sell({ customerId, lines: [line(vitamin, 10)], loyaltyRedeemPoints: 20 }).expect(
      201,
    );
    // 100.000đ hàng, đổi 20 điểm × 500đ = 10.000đ.
    expect(sale.body.data).toMatchObject({
      subtotal: 100000,
      discountAmount: 10000,
      loyaltyPointsRedeemed: 20,
      loyaltyDiscountAmount: 10000,
      totalAmount: 90000,
    });
    // Hóa đơn sau vẫn tích điểm trên số tiền khách thực trả: 90.000đ → 9 điểm.
    expect(sale.body.data.loyaltyPointsEarned).toBe(9);
    expect((await loyaltyOf()).balance.available).toBe(30 - 20 + 9);
  });

  it("nhân viên bán hàng đổi điểm vượt hạn mức giảm giá của vai trò vẫn được", async () => {
    await earnPoints();

    // Hạn mức giảm giá của nhân viên bán hàng là 5%, ở đây giảm 15% bằng
    // điểm của chính khách nên không bị chặn.
    const sale = await sell({ customerId, lines: [line(vitamin, 10)], loyaltyRedeemPoints: 30 }).expect(
      201,
    );
    expect(sale.body.data.totalAmount).toBe(85000);
  });

  it("chặn đổi quá số dư, dưới mức tối thiểu và vượt trần phần trăm", async () => {
    await earnPoints();

    const tooMany = await sell({
      customerId,
      lines: [line(vitamin, 10)],
      loyaltyRedeemPoints: 40,
    }).expect(422);
    expect(tooMany.body.error.code).toBe("LOYALTY_INSUFFICIENT_POINTS");

    const tooFew = await sell({
      customerId,
      lines: [line(vitamin, 10)],
      loyaltyRedeemPoints: 5,
    }).expect(422);
    expect(tooFew.body.error.code).toBe("LOYALTY_MIN_POINTS");

    // Hóa đơn 20.000đ chỉ được giảm 10.000đ, tức tối đa 20 điểm.
    const overCap = await sell({
      customerId,
      lines: [line(vitamin, 2)],
      loyaltyRedeemPoints: 30,
    }).expect(422);
    expect(overCap.body.error.code).toBe("LOYALTY_REDEEM_LIMIT");
    expect(overCap.body.error.message).toContain("tối đa 20 điểm");

    // Hóa đơn toàn thuốc thì không có gì để đổi điểm.
    const allDrugs = await sell({
      customerId,
      lines: [line(para, 10)],
      loyaltyRedeemPoints: 10,
    }).expect(422);
    expect(allDrugs.body.error.message).toContain("không có mặt hàng nào được đổi điểm");

    // Không có lần đổi nào thành công nên số dư giữ nguyên.
    expect((await loyaltyOf()).balance.available).toBe(30);
  });

  it("chưa bật chương trình hoặc chưa chọn khách thì không đổi được", async () => {
    const off = await sell({ customerId, lines: [line(vitamin, 10)], loyaltyRedeemPoints: 10 }).expect(
      409,
    );
    expect(off.body.error.code).toBe("LOYALTY_DISABLED");

    await saveSettings().expect(200);
    await sell({ lines: [line(vitamin, 10)], loyaltyRedeemPoints: 10 }).expect(422);
  });
});

describe("Hủy hóa đơn và trả hàng", () => {
  it("hủy hóa đơn thì thu lại điểm đã tích và trả lại điểm đã đổi", async () => {
    await saveSettings().expect(200);
    await sell({ customerId, lines: [line(vitamin, 30)] }).expect(201);
    const sale = await sell({
      customerId,
      lines: [line(vitamin, 10)],
      loyaltyRedeemPoints: 20,
    }).expect(201);
    expect((await loyaltyOf()).balance.available).toBe(19);

    await api()
      .post(`/api/v1/invoices/${sale.body.data.id}/void`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({ reason: "Khách đổi ý ngay tại quầy" })
      .expect(200);

    // Trả lại 20 điểm đã đổi, thu lại 9 điểm vừa tích: về đúng 30 điểm ban đầu.
    const data = await loyaltyOf();
    expect(data.balance.available).toBe(30);
    expect(data.transactions.filter((item: { type: string }) => item.type === "REVERSE")).toHaveLength(
      2,
    );
    expect(
      (await api().get(`/api/v1/invoices/${sale.body.data.id}`).set(h()).expect(200)).body.data
        .loyaltyPointsEarned,
    ).toBe(0);
  });

  it("khách trả một phần hàng thì thu lại điểm theo đúng tỷ lệ tiền hoàn", async () => {
    await saveSettings().expect(200);
    const sale = await sell({ customerId, lines: [line(vitamin, 30)] }).expect(201);
    expect((await loyaltyOf()).balance.available).toBe(30);

    const invoice = (await api().get(`/api/v1/invoices/${sale.body.data.id}`).set(h()).expect(200)).body
      .data;
    await api()
      .post(`/api/v1/invoices/${sale.body.data.id}/returns`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({
        disposition: "RESTOCK",
        refundMethod: "CASH",
        lines: [{ invoiceLineId: invoice.lines[0].id, unitId: vitamin.unitId, quantity: 10 }],
      })
      .expect(201);

    // Hoàn 100.000đ trên 300.000đ đã tính điểm: thu lại 10 trong 30 điểm.
    const data = await loyaltyOf();
    expect(data.balance.available).toBe(20);
    expect(data.transactions[0]).toMatchObject({ type: "REVERSE", points: -10 });
  });

  it("trả hàng thuốc không đụng tới điểm vì thuốc không được tích", async () => {
    await saveSettings().expect(200);
    const sale = await sell({ customerId, lines: [line(vitamin, 10), line(para, 10)] }).expect(201);
    const invoice = (await api().get(`/api/v1/invoices/${sale.body.data.id}`).set(h()).expect(200)).body
      .data;
    const drugLine = invoice.lines.find((item: { productId: string }) => item.productId === para.id);

    await api()
      .post(`/api/v1/invoices/${sale.body.data.id}/returns`)
      .set({ ...h(pharmacistToken), ...idem() })
      .send({
        disposition: "DISPOSE",
        refundMethod: "CASH",
        reason: "Vỉ thuốc bị móp, khách trả lại",
        lines: [{ invoiceLineId: drugLine.id, unitId: para.unitId, quantity: 10 }],
      })
      .expect(201);

    expect((await loyaltyOf()).balance.available).toBe(10);
  });
});

describe("Điều chỉnh điểm bằng tay", () => {
  const adjust = (body: Record<string, unknown>, token = adminToken) =>
    api().post(`/api/v1/customers/${customerId}/loyalty/adjust`).set(h(token)).send(body);

  it("cộng điểm có lý do và ghi audit", async () => {
    const result = await adjust({ points: 50, reason: "Bù điểm cho hóa đơn ghi thiếu" }).expect(200);
    expect(result.body.data.available).toBe(50);
    expect(await prisma.auditLog.count({ where: { action: "LOYALTY_ADJUST" } })).toBe(1);

    const data = await loyaltyOf();
    expect(data.transactions[0]).toMatchObject({
      type: "ADJUST",
      points: 50,
      note: "Bù điểm cho hóa đơn ghi thiếu",
      createdByName: "Quản trị",
    });
  });

  it("không trừ quá số dư và bắt buộc có lý do", async () => {
    await adjust({ points: 20, reason: "Điểm chương trình khai trương" }).expect(200);

    const tooMuch = await adjust({ points: -30, reason: "Trừ nhầm" }).expect(422);
    expect(tooMuch.body.error.code).toBe("LOYALTY_INSUFFICIENT_POINTS");

    await adjust({ points: -5, reason: "" }).expect(422);
    await adjust({ points: 0, reason: "Không có gì" }).expect(422);
    expect((await loyaltyOf()).balance.available).toBe(20);
  });

  it("nhân viên bán hàng không được tự cộng điểm nhưng vẫn xem được sổ điểm", async () => {
    await adjust({ points: 10, reason: "Tự thưởng" }, salesToken).expect(403);
    expect((await loyaltyOf(salesToken)).balance.available).toBe(0);
  });

  it("khách không tồn tại thì báo 404", async () => {
    await api()
      .post(`/api/v1/customers/${randomUUID()}/loyalty/adjust`)
      .set(h())
      .send({ points: 10, reason: "Thử" })
      .expect(404);
  });
});
