import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma.js";
import {
  api,
  authHeaders,
  login,
  seedFixture,
  truncateAll,
  useTestRole,
  type Fixture,
} from "../../test/helpers.js";
import { startErxStub, type ErxStub } from "../../test/erx-stub-server.js";
import { drainQueue, invoiceRef, scanInvoices } from "./erx-queue.service.js";

const ACCOUNT = { appName: "pharmacy-gpp", appKey: "khoa-bi-mat-thu" };
const CODE = "01001ab12cd3e-c";
const VALID = "01001ab12cd3-c";

let stub: ErxStub;
let fixture: Fixture;
let admin: string;
let pharmacist: string;
let amoxId: string;
let amoxPill: string;
let paraId: string;
let paraPill: string;

const h = (token = pharmacist) => ({
  ...authHeaders(token, fixture.storeId),
  "Idempotency-Key": randomUUID(),
});

function nationalPrescription(code = VALID) {
  return {
    ma_don_thuoc: code,
    ho_ten_benh_nhan: "Nguyễn Văn Bình",
    ngay_sinh_benh_nhan: "1980-05-12",
    loai_don_thuoc: "c",
    ten_bac_si: "BS. Trần Thị Hà",
    ten_co_so_kham_chua_benh: "Phòng khám Đa khoa An Phú",
    chan_doan: [{ ma_chan_doan: "J02", ten_chan_doan: "Viêm họng cấp", ket_luan: "" }],
    ngay_gio_ke_don: new Date().toISOString().slice(0, 10) + " 08:30:00",
    thong_tin_don_thuoc: [
      {
        ma_thuoc: "QG-AMOX-500",
        biet_duoc: "Amoxicillin",
        ten_thuoc: "Amoxicillin 500mg",
        don_vi_tinh: "Viên",
        so_luong: 14,
        cach_dung: "Uống 1 viên x 2 lần/ngày, 7 ngày",
      },
      {
        ma_thuoc: "QG-PARA-500",
        biet_duoc: "Paracetamol",
        ten_thuoc: "Paracetamol 500mg",
        don_vi_tinh: "Viên",
        so_luong: 10,
        cach_dung: "Uống 1 viên khi sốt",
      },
    ],
  };
}

async function product(code: string, name: string, drugClass: string) {
  const category =
    (await prisma.category.findFirst()) ??
    (await prisma.category.create({ data: { name: "Thuốc" } }));
  const created = await prisma.product.create({
    data: {
      code,
      name,
      productType: "DRUG",
      drugClass,
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
  const pill = created.units.find((unit) => unit.name === "Viên")!;
  await prisma.productPrice.create({
    data: {
      productUnitId: pill.id,
      salePrice: 1500n,
      vatRatePercent: 5,
      effectiveFrom: new Date(Date.now() - 86_400_000),
    },
  });
  await prisma.batch.create({
    data: {
      storeId: fixture.storeId,
      productId: created.id,
      batchNumber: `${code}-L1`,
      expiryDate: new Date("2029-06-30"),
      quantityOnHand: 500,
    },
  });
  return { id: created.id, pill: pill.id };
}

async function enable() {
  await api()
    .put("/api/v1/eprescriptions/config")
    .set(authHeaders(admin, fixture.storeId))
    .send({ enabled: true, ...ACCOUNT })
    .expect(200);
  await api()
    .put("/api/v1/eprescriptions/store-config")
    .set(authHeaders(admin, fixture.storeId))
    .send({ facilityCode: "79-NT-0001" })
    .expect(200);
}

beforeAll(async () => {
  stub = await startErxStub(ACCOUNT);
  process.env["EPRESCRIPTION_BASE_URL"] = stub.baseUrl;
});

afterAll(async () => {
  delete process.env["EPRESCRIPTION_BASE_URL"];
  await stub.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll();
  fixture = await seedFixture();
  [admin, pharmacist] = await Promise.all([
    login("admin").then((r) => r.token),
    login("duocsi").then((r) => r.token),
  ]);
  ({ id: amoxId, pill: amoxPill } = await product("TH0401", "Amoxicillin 500mg", "RX"));
  ({ id: paraId, pill: paraPill } = await product("TH0402", "Paracetamol 500mg", "OTC"));
  stub.dispensed.length = 0;
  stub.addPrescription(nationalPrescription());
});

describe("Lấy đơn thuốc điện tử", () => {
  it("chưa bật thì báo rõ; mã sai định dạng 422; mã không có 404", async () => {
    const off = await api()
      .post("/api/v1/eprescriptions/import")
      .set(h())
      .send({ code: VALID })
      .expect(409);
    expect(off.body.error.code).toBe("EPRESCRIPTION_DISABLED");
    await enable();
    await api().post("/api/v1/eprescriptions/import").set(h()).send({ code: CODE }).expect(422);
    await api()
      .post("/api/v1/eprescriptions/import")
      .set(h())
      .send({ code: "99999zzzzzzz-c" })
      .expect(404);
  });

  it("lấy về thành đơn nháp: người bệnh, bác sĩ, chẩn đoán, cách dùng; thuốc đã ghép thì tự khớp; lấy lại cùng mã trả đúng đơn cũ", async () => {
    await enable();
    const adminUser = await prisma.user.findFirstOrThrow({ where: { username: "admin" } });
    await prisma.ePrescriptionDrugLink.create({
      data: { nationalDrugCode: "QG-PARA-500", productId: paraId, createdBy: adminUser.id },
    });

    const first = await api()
      .post("/api/v1/eprescriptions/import")
      .set(h())
      .send({ code: ` ${VALID.toUpperCase()} ` })
      .expect(201);
    expect(first.body.data).toMatchObject({ created: true, unmatched: 1 });

    const detail = (
      await api()
        .get(`/api/v1/prescriptions/${first.body.data.prescriptionId}`)
        .set(authHeaders(pharmacist, fixture.storeId))
        .expect(200)
    ).body.data;
    expect(detail).toMatchObject({
      source: "NATIONAL",
      status: "DRAFT",
      patientName: "Nguyễn Văn Bình",
      prescriberName: "BS. Trần Thị Hà",
      facilityName: "Phòng khám Đa khoa An Phú",
      diagnosisText: "J02 Viêm họng cấp",
    });
    expect(detail.items).toEqual([
      expect.objectContaining({
        productId: null,
        nationalDrugCode: "QG-AMOX-500",
        dosageInstruction: "Uống 1 viên x 2 lần/ngày, 7 ngày",
        quantity: 14,
      }),
      expect.objectContaining({
        productId: paraId,
        unitId: paraPill,
        nationalDrugCode: "QG-PARA-500",
        baseQuantity: 10,
      }),
    ]);

    const again = await api()
      .post("/api/v1/eprescriptions/import")
      .set(h())
      .send({ code: VALID })
      .expect(200);
    expect(again.body.data).toMatchObject({
      prescriptionId: first.body.data.prescriptionId,
      created: false,
    });
  });

  it("khớp tay một lần thì lần sau tự khớp; không sửa danh sách thuốc của đơn điện tử", async () => {
    await enable();
    const imported = (
      await api().post("/api/v1/eprescriptions/import").set(h()).send({ code: VALID }).expect(201)
    ).body.data;
    const detail = (
      await api()
        .get(`/api/v1/prescriptions/${imported.prescriptionId}`)
        .set(authHeaders(pharmacist, fixture.storeId))
    ).body.data;
    for (const item of detail.items) {
      const target =
        item.nationalDrugCode === "QG-AMOX-500"
          ? { productId: amoxId, unitId: amoxPill }
          : { productId: paraId, unitId: paraPill };
      await api()
        .post(
          `/api/v1/eprescriptions/prescriptions/${imported.prescriptionId}/items/${item.id}/match`,
        )
        .set(h())
        .send(target)
        .expect(200);
    }
    await api()
      .patch(`/api/v1/prescriptions/${imported.prescriptionId}`)
      .set(h())
      .send({ version: detail.version + 2, items: [{ drugNameText: "x", quantity: 1 }] })
      .expect(409);
    await api()
      .post(`/api/v1/prescriptions/${imported.prescriptionId}/verify`)
      .set(h())
      .send({})
      .expect(200);

    stub.addPrescription(nationalPrescription("01001zz99yy8-c"));
    const second = await api()
      .post("/api/v1/eprescriptions/import")
      .set(h())
      .send({ code: "01001zz99yy8-c" })
      .expect(201);
    expect(second.body.data.unmatched).toBe(0);
  });

  it("nhân viên kho không lấy đơn được; cấu hình không lộ app-key", async () => {
    await enable();
    await useTestRole(fixture.salesId, "warehouse_staff", fixture.storeId);
    const kho = (await login("banhang")).token;
    await api().post("/api/v1/eprescriptions/import").set(h(kho)).send({ code: VALID }).expect(403);
    const config = await api()
      .get("/api/v1/eprescriptions/config")
      .set(authHeaders(admin, fixture.storeId))
      .expect(200);
    expect(config.body.data).toMatchObject({
      enabled: true,
      appName: ACCOUNT.appName,
      hasAppKey: true,
      facilityCode: "79-NT-0001",
    });
    expect(JSON.stringify(config.body.data)).not.toContain(ACCOUNT.appKey);
    const stored = await prisma.ePrescriptionConfig.findUniqueOrThrow({ where: { id: 1 } });
    expect(stored.appKeyCipher).not.toContain(ACCOUNT.appKey);
  });
});

describe("Báo đã bán lên hệ thống quốc gia", () => {
  async function sellImported(soldAmox = 14) {
    await enable();
    const imported = (
      await api().post("/api/v1/eprescriptions/import").set(h()).send({ code: VALID }).expect(201)
    ).body.data;
    const detail = (
      await api()
        .get(`/api/v1/prescriptions/${imported.prescriptionId}`)
        .set(authHeaders(pharmacist, fixture.storeId))
    ).body.data;
    for (const item of detail.items) {
      const target =
        item.nationalDrugCode === "QG-AMOX-500"
          ? { productId: amoxId, unitId: amoxPill }
          : { productId: paraId, unitId: paraPill };
      await api()
        .post(
          `/api/v1/eprescriptions/prescriptions/${imported.prescriptionId}/items/${item.id}/match`,
        )
        .set(h())
        .send(target)
        .expect(200);
    }
    await api()
      .post(`/api/v1/prescriptions/${imported.prescriptionId}/verify`)
      .set(h())
      .send({})
      .expect(200);
    const items = (
      await api()
        .get(`/api/v1/prescriptions/${imported.prescriptionId}`)
        .set(authHeaders(pharmacist, fixture.storeId))
    ).body.data.items;
    const amoxItem = items.find(
      (item: { nationalDrugCode: string }) => item.nationalDrugCode === "QG-AMOX-500",
    );
    const sold = await api()
      .post("/api/v1/invoices")
      .set(h())
      .send({
        prescriptionId: imported.prescriptionId,
        lines: [
          {
            productId: amoxId,
            unitId: amoxPill,
            quantity: soldAmox,
            prescriptionItemId: amoxItem.id,
          },
        ],
      })
      .expect(201);
    return sold.body.data as { id: string; code: string };
  }

  it("gửi đúng mã đơn, số lượng bán theo đơn vị trên đơn, cách dùng, mã hóa đơn ≤ 20 ký tự và mã định danh cơ sở", async () => {
    const invoice = await sellImported(10);
    expect(await scanInvoices()).toMatchObject({ created: 1 });
    expect(await drainQueue()).toMatchObject({ sent: 1 });

    expect(stub.dispensed).toHaveLength(1);
    const body = stub.dispensed[0]!;
    expect(body).toMatchObject({
      ma_don_thuoc: VALID,
      ma_dinh_danh_co_so_cung_ung_thuoc: "79-NT-0001",
      ma_hoa_don: invoiceRef(invoice.code),
    });
    expect(String(body["ma_hoa_don"]).length).toBeLessThanOrEqual(20);
    expect(body["thong_tin_thuoc"]).toEqual([
      {
        ma_thuoc_da_ke_don: "QG-AMOX-500",
        ma_thuoc: "QG-AMOX-500",
        biet_duoc: "Amoxicillin",
        ten_thuoc: "Amoxicillin 500mg",
        don_vi_tinh: "Viên",
        so_luong: 14,
        so_luong_ban: 10,
        cach_dung: "Uống 1 viên x 2 lần/ngày, 7 ngày",
      },
    ]);
    expect((await prisma.ePrescriptionDispenseJob.findFirstOrThrow()).status).toBe("SENT");
    // Quét lại không tạo việc thứ hai.
    expect((await scanInvoices()).created).toBe(0);
  });

  it("lỗi mạng thử lại sau; dữ liệu bị từ chối thì dừng chờ xử lý tay rồi thử lại được", async () => {
    await sellImported();
    await scanInvoices();
    stub.failNextDispense(503);
    expect(await drainQueue()).toMatchObject({ failed: 1 });
    const failed = await prisma.ePrescriptionDispenseJob.findFirstOrThrow();
    expect(failed.status).toBe("FAILED");
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await prisma.ePrescriptionDispenseJob.update({
      where: { id: failed.id },
      data: { nextAttemptAt: new Date() },
    });
    stub.failNextDispense(422, ["Số lượng bán vượt số lượng kê"]);
    expect(await drainQueue()).toMatchObject({ rejected: 1 });
    expect(await prisma.ePrescriptionDispenseJob.findFirstOrThrow()).toMatchObject({
      status: "REJECTED",
      lastError: "Số lượng bán vượt số lượng kê",
    });

    await api()
      .post(`/api/v1/eprescriptions/jobs/${failed.id}/retry`)
      .set(authHeaders(admin, fixture.storeId))
      .expect(200);
    expect(await drainQueue()).toMatchObject({ sent: 1 });
  });

  it("thiếu mã định danh cơ sở thì chờ, không gửi; hóa đơn hủy trước khi gửi thì bỏ; hủy sau khi gửi thì cần xử lý tay", async () => {
    const invoice = await sellImported();
    await prisma.ePrescriptionStoreConfig.deleteMany();
    await scanInvoices();
    expect(await drainQueue()).toMatchObject({ failed: 1 });
    expect((await prisma.ePrescriptionDispenseJob.findFirstOrThrow()).lastError).toContain(
      "mã định danh cơ sở",
    );
    expect(stub.dispensed).toHaveLength(0);

    await api()
      .put("/api/v1/eprescriptions/store-config")
      .set(authHeaders(admin, fixture.storeId))
      .send({ facilityCode: "79-NT-0001" })
      .expect(200);
    await prisma.ePrescriptionDispenseJob.updateMany({ data: { nextAttemptAt: new Date() } });
    expect(await drainQueue()).toMatchObject({ sent: 1 });

    await api()
      .post(`/api/v1/invoices/${invoice.id}/void`)
      .set(h(admin))
      .send({ reason: "Bán nhầm" })
      .expect(200);
    expect((await scanInvoices()).needsReview).toBe(1);
    expect((await prisma.ePrescriptionDispenseJob.findFirstOrThrow()).status).toBe("NEEDS_REVIEW");
  });
});
