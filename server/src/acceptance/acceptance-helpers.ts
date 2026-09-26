import { randomUUID } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { api, authHeaders, login, seedFixture, type Fixture } from "../test/helpers.js";
import { hashPassword } from "../lib/password.js";

/**
 * Tiện ích dựng dữ liệu cho kiểm thử nghiệm thu nghiệp vụ.
 *
 * Mọi kỳ vọng trong các ca kiểm thử đều được tính tay từ dữ liệu ở đây, KHÔNG
 * gọi lại hàm nghiệp vụ đang được kiểm tra để lấy đáp án.
 */

export type Stage = {
  fixture: Fixture;
  /** Chủ nhà thuốc, làm việc được ở cả hai cửa hàng. */
  admin: string;
  /** Dược sĩ cửa hàng A: lập phiếu, bán thuốc kê đơn. */
  pharmacist: string;
  /** Dược sĩ thứ hai của cửa hàng A, để thử hai quầy cùng bán thuốc kê đơn. */
  pharmacistB: string;
  /** Nhân viên bán hàng cửa hàng A. */
  sellerA: string;
  /** Nhân viên bán hàng cửa hàng B. */
  sellerB: string;
  sellerBId: string;
  supplierId: string;
  categoryId: string;
};

export const idem = () => ({ "Idempotency-Key": randomUUID() });

/** Ngày tương đối theo ngày làm việc giờ Việt Nam, dạng YYYY-MM-DD. */
export function dayKey(offsetDays = 0): string {
  const vnToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  const date = new Date(`${vnToday}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export const dayDate = (offsetDays = 0): Date => new Date(`${dayKey(offsetDays)}T00:00:00.000Z`);

/** Dựng hai cửa hàng, ba vai trò và một nhà cung cấp. */
export async function setupStage(): Promise<Stage> {
  const fixture = await seedFixture();

  const salesRole = await prisma.role.findUniqueOrThrow({ where: { code: "sales_staff" } });
  const pharmacistRole = await prisma.role.findUniqueOrThrow({ where: { code: "pharmacist" } });
  const passwordHash = await hashPassword("MatKhau@12345");

  const pharmacistBUser = await prisma.user.create({
    data: {
      username: "duocsi2",
      passwordHash,
      fullName: "Dược sĩ quầy 2",
      defaultStoreId: fixture.storeId,
      mustChangePassword: false,
    },
  });
  await prisma.userRole.create({
    data: { userId: pharmacistBUser.id, roleId: pharmacistRole.id, storeId: fixture.storeId },
  });
  const sellerBUser = await prisma.user.create({
    data: {
      username: "banhangb",
      passwordHash,
      fullName: "Nhân viên quầy B",
      defaultStoreId: fixture.otherStoreId,
      mustChangePassword: false,
    },
  });
  await prisma.userRole.create({
    data: { userId: sellerBUser.id, roleId: salesRole.id, storeId: fixture.otherStoreId },
  });

  const [admin, pharmacist, pharmacistB, sellerA, sellerB] = await Promise.all([
    login("admin").then((item) => item.token),
    login("duocsi").then((item) => item.token),
    login("duocsi2").then((item) => item.token),
    login("banhang").then((item) => item.token),
    login("banhangb").then((item) => item.token),
  ]);

  const category = await prisma.category.create({ data: { name: "Hàng nhà thuốc" } });
  const supplier = await prisma.supplier.create({
    data: { name: "Công ty Dược Minh Tâm", paymentTermDays: 30 },
  });

  return {
    fixture,
    admin,
    pharmacist,
    pharmacistB,
    sellerA,
    sellerB,
    sellerBId: sellerBUser.id,
    supplierId: supplier.id,
    categoryId: category.id,
  };
}

export type MadeProduct = {
  id: string;
  code: string;
  /** Đơn vị theo tên: Viên, Vỉ, Hộp... */
  units: Record<string, string>;
};

/** Tạo sản phẩm có nhiều đơn vị quy đổi và giá niêm yết (đã gồm VAT). */
export async function makeProduct(
  stage: Stage,
  options: {
    code: string;
    name: string;
    productType?: string;
    drugClass?: string | null;
    /** [tên đơn vị, hệ số quy đổi, giá bán] — hệ số 1 là đơn vị nhỏ nhất. */
    units: Array<[string, number, number | null]>;
    vatRatePercent?: number;
  },
): Promise<MadeProduct> {
  const product = await prisma.product.create({
    data: {
      code: options.code,
      name: options.name,
      productType: options.productType ?? "DRUG",
      drugClass: options.drugClass === undefined ? "OTC" : options.drugClass,
      categoryId: stage.categoryId,
      units: {
        create: options.units.map(([name, conversionToBase]) => ({
          name,
          conversionToBase,
          isDefaultSaleUnit: conversionToBase === 1,
        })),
      },
    },
    include: { units: true },
  });

  const byName = Object.fromEntries(product.units.map((unit) => [unit.name, unit.id]));
  for (const [name, , price] of options.units) {
    if (price === null) continue;
    await prisma.productPrice.create({
      data: {
        productUnitId: byName[name]!,
        salePrice: BigInt(price),
        vatRatePercent: options.vatRatePercent ?? 5,
        effectiveFrom: dayDate(-5),
      },
    });
  }

  return { id: product.id, code: product.code, units: byName };
}

/** Tạo lô thẳng trong CSDL (dùng cho dữ liệu nền, không phải luồng nhập hàng). */
export async function makeBatch(
  stage: Stage,
  options: {
    product: MadeProduct;
    batchNumber: string;
    quantity: number;
    unitCost: number;
    expiryInDays?: number;
    status?: string;
    storeId?: string;
  },
): Promise<string> {
  const batch = await prisma.batch.create({
    data: {
      storeId: options.storeId ?? stage.fixture.storeId,
      productId: options.product.id,
      batchNumber: options.batchNumber,
      expiryDate: dayDate(options.expiryInDays ?? 365),
      quantityOnHand: options.quantity,
      unitCost: options.unitCost,
      status: options.status ?? "AVAILABLE",
    },
  });
  return batch.id;
}

export const headers = (token: string, storeId: string) => authHeaders(token, storeId);

/** Lập phiếu nhập ở trạng thái nháp. */
export const draftReceipt = (
  stage: Stage,
  body: Record<string, unknown>,
  token = stage.pharmacist,
  storeId = stage.fixture.storeId,
) =>
  api()
    .post("/api/v1/goods-receipts")
    .set({ ...headers(token, storeId), ...idem() })
    .send({ supplierId: stage.supplierId, ...body });

/** Kiểm nhập một phiếu: mặc định mọi dòng đều đạt. */
export const confirmReceipt = (
  stage: Stage,
  receipt: { id: string; lines: Array<{ id: string }> },
  results?: Array<{ lineId: string; passed: boolean; rejectReason?: string }>,
  token = stage.pharmacist,
  storeId = stage.fixture.storeId,
) =>
  api()
    .post(`/api/v1/goods-receipts/${receipt.id}/confirm`)
    .set({ ...headers(token, storeId), ...idem() })
    .send({
      lines: results ?? receipt.lines.map((line) => ({ lineId: line.id, passed: true })),
    });

export const sell = (
  stage: Stage,
  body: Record<string, unknown>,
  token = stage.sellerA,
  storeId = stage.fixture.storeId,
) =>
  api()
    .post("/api/v1/invoices")
    .set({ ...headers(token, storeId), ...idem() })
    .send(body);

export const line = (product: MadeProduct, unitName: string, quantity: number) => ({
  productId: product.id,
  unitId: product.units[unitName]!,
  quantity,
});

export const batchOf = (batchNumber: string, storeId?: string) =>
  prisma.batch.findFirstOrThrow({
    where: { batchNumber, ...(storeId ? { storeId } : {}) },
  });

/** Giá trị tồn của một lô = tồn × giá vốn bình quân. */
export async function stockValue(batchNumber: string, storeId?: string): Promise<number> {
  const batch = await batchOf(batchNumber, storeId);
  return batch.quantityOnHand * Number(batch.unitCost ?? 0);
}

/**
 * VAT tách ngược từ giá đã gồm VAT, làm tròn nửa lên theo từng dòng
 * (contract §6.5, P9). Đây là công thức tính tay để đối chiếu, viết độc lập
 * với mã nghiệp vụ.
 */
export function vatOf(lineTotal: number, vatPercent = 5): number {
  const bp = Math.round(vatPercent * 100);
  return Math.floor((lineTotal * bp * 2 + (10000 + bp)) / ((10000 + bp) * 2));
}

/** Dung sai giá vốn: cột numeric(18,4) nên chênh lệch cho phép là nửa đơn vị cuối. */
export const COST_TOLERANCE = 0.00005;
