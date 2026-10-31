import { prisma } from "../db/prisma.js";
import { AppError } from "../lib/app-error.js";
import { codeDay, nextDocumentCode } from "../lib/document-code.js";
import { loadAuthContext } from "../modules/auth/auth.context.js";
import { createDefaultLocations } from "../modules/inventory/storage-locations.service.js";
import { getCurrentPrices } from "../modules/catalog/products.service.js";
import { createInvoice } from "../modules/sales/invoices.service.js";
import { createInvoiceSchema } from "../modules/sales/sales.schema.js";

/**
 * Lịch sử bán hàng để chạy thử phân tích, biểu đồ, dự báo, Trợ lý AI.
 *
 *   npm run db:sales-demo                     90 ngày, ~30 hóa đơn/ngày/cửa hàng
 *   npm run db:sales-demo -- --days 120 --per-day 40
 *   npm run db:sales-demo -- --live           sau đó cứ ~5 giây bán thêm 1 hóa đơn (Ctrl+C dừng)
 *   npm run db:sales-demo -- --live-only      chỉ bán trực tiếp, không tạo lịch sử
 *   npm run db:sales-demo -- --stores 3       chuỗi ít hơn 3 cửa hàng thì mở thêm (mặc định 3)
 *
 * Mỗi hóa đơn đi qua đúng hàm bán hàng của phần mềm (trừ tồn theo FEFO, thẻ kho, giá vốn theo lô),
 * rồi dời ngày bán về quá khứ. Hàng được nhập trước bằng phiếu tồn đầu kỳ (lô `DEMOSALE-*`).
 * Chỉ THÊM dữ liệu, không xóa gì. Lịch sử chỉ tạo một lần (ghi dấu trong cài đặt
 * `demo.sales_history`); muốn tạo thêm lần nữa thì thêm `--force`.
 *
 * Để biểu đồ có hình dạng thật: tăng dần theo thời gian, cuối tuần đông hơn, đầu tháng và giữa
 * tháng (ngày lương) nhỉnh hơn, nhóm thuốc ho/cảm tăng theo mùa, một ngày NT02 giảm mạnh (sự cố)
 * và một ngày NT01 tăng vọt (khuyến mãi) để phần Bất thường có cái phát hiện.
 */

type Options = {
  days: number;
  stores: number;
  perDay: number;
  live: boolean;
  liveOnly: boolean;
  interval: number;
  force: boolean;
  seed: number;
};

function parseArgs(argv: string[]): Options {
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const number = (name: string, fallback: number, min: number, max: number) => {
    const raw = value(name);
    const parsed = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      throw new Error(`--${name} phải từ ${min} đến ${max}`);
    }
    return parsed;
  };
  return {
    days: number("days", 90, 14, 365),
    stores: number("stores", 3, 1, 5),
    perDay: number("per-day", 30, 5, 200),
    live: argv.includes("--live") || argv.includes("--live-only"),
    liveOnly: argv.includes("--live-only"),
    interval: number("interval", 5, 1, 600),
    force: argv.includes("--force"),
    seed: number("seed", 2026, 0, 1_000_000),
  };
}

/** Số ngẫu nhiên có hạt giống: chạy lại cùng tham số ra cùng hình dạng dữ liệu. */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const HISTORY_KEY = "demo.sales_history";
const RUN_TAG = Date.now().toString(36).slice(-4).toUpperCase();

/** 00:00 hôm nay theo giờ Việt Nam, dạng ngày UTC (giống cột business_date). */
function vnToday(): Date {
  const vn = new Date(Date.now() + VN_OFFSET_MS);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()));
}

/** Thời điểm theo giờ Việt Nam của một ngày (giờ có phần lẻ). */
function vnMoment(day: Date, hour: number): Date {
  return new Date(day.getTime() + hour * 3_600_000 - VN_OFFSET_MS);
}

const dateText = (day: Date) => day.toISOString().slice(0, 10).split("-").reverse().join("/");
const money = (value: number) => `${Math.round(value).toLocaleString("vi-VN")} đ`;

/** Thứ trong tuần: cuối tuần đông, đầu tuần vắng. 0 = Chủ nhật. */
const WEEKDAY = [1.2, 0.92, 0.88, 0.95, 1.0, 1.06, 1.28];
/** Quy mô từng cửa hàng theo thứ tự mã: cửa hàng đầu đông nhất. */
const STORE_SCALE = [1, 0.78, 0.6, 0.5, 0.45];
/** Nhóm thuốc tăng theo mùa (ho, cảm, hô hấp). */
const SEASONAL = /ho|cảm|cam|hô hấp|ho hap|siro|cúm|cum/i;

type Item = {
  productId: string;
  productUnitId: string;
  name: string;
  conversion: number;
  price: number;
  weight: number;
  /** Số đơn vị bán mỗi lần mua: thuốc viên/gói giá thấp mua theo vỉ 10, hàng khác mua lẻ. */
  pack: number;
  seasonal: boolean;
  minStock: number;
};

async function loadItems(rand: () => number): Promise<Item[]> {
  const units = await prisma.productUnit.findMany({
    where: {
      isDefaultSaleUnit: true,
      isActive: true,
      isSellable: true,
      // Chỉ thuốc không kê đơn và hàng không phải thuốc: bán không cần đơn, không cần dược sĩ duyệt.
      product: { isActive: true, OR: [{ drugClass: "OTC" }, { drugClass: null }] },
    },
    include: { product: { include: { category: true } } },
    orderBy: { product: { code: "asc" } },
  });
  const current = await getCurrentPrices(
    units.map((unit) => unit.id),
    null,
  );
  const items = units.flatMap((unit) => {
    const price = current.get(unit.id);
    if (!price) return [];
    return [
      {
        productId: unit.productId,
        productUnitId: unit.id,
        name: unit.product.name,
        conversion: unit.conversionToBase,
        price: Number(price.salePrice),
        weight: 0,
        pack: Number(price.salePrice) < 6_000 ? 10 : 1,
        seasonal: SEASONAL.test(`${unit.product.name} ${unit.product.category.name}`),
        minStock: unit.product.minStockBaseQuantity ?? 0,
      },
    ];
  });
  // Độ bán chạy kiểu Zipf: vài thuốc bán rất chạy, phần đuôi bán chậm (để có "bán chậm", ABC).
  // Hàng càng đắt càng ít người mua (máy đo huyết áp không bán nhiều như thuốc giảm đau).
  const buyValue = (item: Item) => item.price * item.pack;
  const values = items.map(buyValue).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)]!;
  const order = items.map((_, index) => index).sort(() => rand() - 0.5);
  order.forEach((itemIndex, rank) => {
    const item = items[itemIndex]!;
    const priceFactor = Math.min(Math.max(Math.pow(median / buyValue(item), 0.6), 0.04), 3);
    item.weight = (1 / Math.pow(rank + 1, 0.85)) * priceFactor;
  });
  return items;
}

function pickWeighted<T extends { weight: number }>(
  list: T[],
  rand: () => number,
  boost: (item: T) => number,
): T {
  const total = list.reduce((sum, item) => sum + item.weight * boost(item), 0);
  let target = rand() * total;
  for (const item of list) {
    target -= item.weight * boost(item);
    if (target <= 0) return item;
  }
  return list.at(-1)!;
}

/** Một giỏ hàng: 1–4 mặt hàng khác nhau, mỗi mặt hàng 1–3 lần đơn vị mua (vỉ hoặc cái). */
function basket(
  items: Item[],
  rand: () => number,
  boost: (item: Item) => number,
): Array<{ item: Item; quantity: number }> {
  const roll = rand();
  const count = roll < 0.45 ? 1 : roll < 0.75 ? 2 : roll < 0.9 ? 3 : 4;
  const chosen = new Map<string, Item>();
  for (let tries = 0; chosen.size < count && tries < 12; tries += 1) {
    const item = pickWeighted(items, rand, boost);
    chosen.set(item.productId, item);
  }
  return [...chosen.values()].map((item) => {
    const q = rand();
    return { item, quantity: (q < 0.65 ? 1 : q < 0.9 ? 2 : 3) * item.pack };
  });
}

/**
 * Số đơn vị bán trung bình mỗi hóa đơn của từng mặt hàng, ước bằng cách thử 5.000 giỏ hàng.
 * Không tính bằng tỷ trọng: giỏ nhiều món phải chọn món khác nhau nên hàng ít phổ biến bán
 * nhiều hơn tỷ trọng của nó, nhập theo tỷ trọng sẽ hết hàng sớm.
 */
function unitsPerInvoice(
  items: Item[],
  rand: () => number,
  boost: (item: Item) => number,
): Map<string, number> {
  const totals = new Map<string, number>();
  const runs = 5_000;
  for (let run = 0; run < runs; run += 1) {
    for (const { item, quantity } of basket(items, rand, boost)) {
      totals.set(item.productId, (totals.get(item.productId) ?? 0) + quantity);
    }
  }
  return new Map([...totals].map(([id, units]) => [id, units / runs]));
}

/** Nhập hàng bằng phiếu tồn đầu kỳ đã kiểm nhập: phiếu, dòng phiếu, lô, thẻ kho (giống db:demo). */
async function receiveStock(
  storeId: string,
  storeCode: string,
  userId: string,
  receivedAt: Date,
  item: Item,
  lots: Array<{ suffix: string; baseQuantity: number; expiryDate: Date }>,
  unitCost: number,
) {
  const prefix = `PN-${storeCode}-${codeDay(receivedAt)}-`;
  await prisma.$transaction(async (tx) => {
    const code = await nextDocumentCode(tx, storeId, prefix);
    const total = lots.reduce((sum, lot) => sum + lot.baseQuantity, 0);
    const receipt = await tx.goodsReceipt.create({
      data: {
        storeId,
        code,
        type: "OPENING_BALANCE",
        receivedAt,
        status: "CONFIRMED",
        note: "Dữ liệu chạy thử (db:sales-demo)",
        goodsAmount: BigInt(Math.round(unitCost * total)),
        totalCost: BigInt(Math.round(unitCost * total)),
        createdBy: userId,
        confirmedBy: userId,
        confirmedAt: receivedAt,
        createdAt: receivedAt,
      },
    });
    let lineNo = 0;
    for (const lot of lots) {
      lineNo += 1;
      // Mã lần chạy ở cuối: chạy lại với --force không trùng số lô cũ.
      const batchNumber = `DEMOSALE-${storeCode}-${lot.suffix}-${RUN_TAG}`;
      const line = await tx.goodsReceiptLine.create({
        data: {
          goodsReceiptId: receipt.id,
          lineNo,
          productId: item.productId,
          productUnitId: item.productUnitId,
          quantity: lot.baseQuantity,
          baseQuantity: lot.baseQuantity,
          unitCost: BigInt(Math.round(unitCost)),
          lineCost: BigInt(Math.round(unitCost * lot.baseQuantity)),
          batchNumber,
          expiryDate: lot.expiryDate,
        },
      });
      const batch = await tx.batch.create({
        data: {
          storeId,
          productId: item.productId,
          batchNumber,
          expiryDate: lot.expiryDate,
          quantityOnHand: lot.baseQuantity,
          unitCost: Math.round(unitCost),
          shelfLocation: "Kệ demo",
          status: "AVAILABLE",
          sourceType: "GOODS_RECEIPT",
          sourceId: receipt.id,
          createdAt: receivedAt,
        },
      });
      await tx.goodsReceiptLine.update({ where: { id: line.id }, data: { batchId: batch.id } });
      await tx.stockMovement.create({
        data: {
          occurredAt: receivedAt,
          storeId,
          batchId: batch.id,
          productId: item.productId,
          type: "OPENING_BALANCE",
          baseQuantity: lot.baseQuantity,
          balanceAfter: lot.baseQuantity,
          sourceType: "GOODS_RECEIPT",
          sourceId: receipt.id,
          sourceLineId: line.id,
          userId,
        },
      });
    }
  });
}

type Store = { id: string; code: string; name: string; scale: number };
type Auth = NonNullable<Awaited<ReturnType<typeof loadAuthContext>>>;

/**
 * Một hóa đơn qua đúng hàm bán hàng. Giỏ hàng ngẫu nhiên đôi khi chạm kiểm tra an toàn (ví dụ hai
 * thuốc trùng hoạt chất cần dược sĩ xác nhận): không tự xác nhận hộ, chọn giỏ khác (tối đa 4 lần).
 * Hết hàng thì bỏ qua (trả null).
 */
async function sell(
  store: Store,
  auth: Auth,
  items: Item[],
  rand: () => number,
  boost: (item: Item) => number,
): Promise<{ id: string; total: number; lines: number } | null> {
  auth.storeId = store.id;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const lines = basket(items, rand, boost).map(({ item, quantity }) => ({
      productId: item.productId,
      unitId: item.productUnitId,
      quantity,
    }));
    const method = rand();
    const input = createInvoiceSchema.parse({
      lines,
      payment: { method: method < 0.7 ? "CASH" : method < 0.9 ? "BANK_TRANSFER" : "CARD" },
    });
    try {
      const id = await createInvoice(store.id, auth, input);
      const invoice = await prisma.invoice.findUniqueOrThrow({
        where: { id },
        select: { totalAmount: true },
      });
      return { id, total: Number(invoice.totalAmount), lines: lines.length };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (error.code === "INSUFFICIENT_STOCK") return null;
      // Kiểm tra an toàn chặn hoặc cần xác nhận: thử giỏ khác. Lỗi quyền, lỗi khác: báo ngay.
      if (error.status === 403 || error.status >= 500) throw error;
    }
  }
  return null;
}

/** Dời hóa đơn vừa bán về đúng ngày giờ trong quá khứ, cả mã hóa đơn và thẻ kho. */
async function backdate(
  storeId: string,
  storeCode: string,
  invoiceId: string,
  soldAt: Date,
  day: Date,
) {
  await prisma.$transaction(async (tx) => {
    const code = await nextDocumentCode(tx, storeId, `HD-${storeCode}-${codeDay(soldAt)}-`);
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { soldAt, businessDate: day, createdAt: soldAt, code },
    });
    await tx.stockMovement.updateMany({
      where: { sourceId: invoiceId },
      data: { occurredAt: soldAt },
    });
  });
}

/** Chuỗi có ít cửa hàng hơn `wanted` thì mở thêm, như thao tác "Mở cửa hàng mới". */
async function openStores(wanted: number, actorId: string): Promise<void> {
  const existing = await prisma.store.findMany({ select: { code: true, isActive: true } });
  let missing = wanted - existing.filter((store) => store.isActive).length;
  const codes = new Set(existing.map((store) => store.code));
  for (let number = 1; missing > 0 && number < 100; number += 1) {
    const code = `NT${String(number).padStart(2, "0")}`;
    if (codes.has(code)) continue;
    await prisma.$transaction(async (tx) => {
      const store = await tx.store.create({
        data: {
          code,
          name: `Nhà thuốc GPP số ${number} (demo)`,
          address: `${number * 12} đường Demo, TP. Hồ Chí Minh`,
          gppCertificateNumber: `GPP-DEMO-${String(number).padStart(4, "0")}`,
        },
      });
      await createDefaultLocations(tx, store.id);
      await tx.auditLog.create({
        data: {
          storeId: store.id,
          actorId,
          action: "STORE_CREATE",
          resourceType: "store",
          resourceId: store.id,
          after: { code, name: store.name, source: "db:sales-demo" },
        },
      });
    });
    console.log(`Đã mở cửa hàng ${code}.`);
    missing -= 1;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rand = random(options.seed);

  // Người bán: tài khoản quản lý (ưu tiên vai trò toàn chuỗi).
  const seller = await prisma.userRole.findFirst({
    where: { role: { code: "admin" }, user: { isActive: true } },
    orderBy: { storeId: { sort: "asc", nulls: "first" } },
    select: { userId: true },
  });
  if (!seller) throw new Error("Chưa có tài khoản quản lý: chạy npm run db:seed trước");

  await openStores(options.stores, seller.userId);
  const activeStores = await prisma.store.findMany({
    where: { isActive: true },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });
  if (activeStores.length === 0) throw new Error("Chưa có cửa hàng: chạy npm run db:seed trước");
  const stores: Store[] = activeStores.map((store, index) => ({
    ...store,
    scale: STORE_SCALE[index] ?? 0.4,
  }));

  const auth = await loadAuthContext(seller.userId, "sales-demo");
  if (!auth) throw new Error("Không đọc được quyền của tài khoản quản lý");

  const items = await loadItems(rand);
  if (items.length < 5) {
    throw new Error("Cần ít nhất 5 thuốc không kê đơn có giá bán: chạy npm run db:catalog trước");
  }
  const today = vnToday();
  const start = new Date(today.getTime() - options.days * DAY_MS);
  const seasonalBoost = (progress: number) => (item: Item) =>
    item.seasonal ? 1 + 1.4 * progress : 1;

  const marker = await prisma.setting.findFirst({ where: { key: HISTORY_KEY, storeId: null } });
  if (!options.liveOnly && marker && !options.force) {
    console.log(
      `Đã có lịch sử bán hàng demo (tạo lúc ${marker.updatedAt.toLocaleString("vi-VN")}). ` +
        "Bỏ qua phần lịch sử; thêm --force để tạo thêm.",
    );
  } else if (!options.liveOnly) {
    console.log(
      `Tạo ${options.days} ngày bán hàng cho ${stores.length} cửa hàng, ~${options.perDay} hóa đơn/ngày ở cửa hàng đông nhất, ${items.length} mặt hàng.`,
    );

    // 1. Nhập hàng: đủ bán cả kỳ (cộng dư 30%), chia 2 lô; lô hạn gần bán trước (FEFO).
    // Hệ số trung bình theo thứ, ngày lương, xu hướng, nhiễu ≈ 1,1; nhóm mùa vụ tính theo mức cuối kỳ.
    const perInvoice = unitsPerInvoice(items, random(options.seed + 1), seasonalBoost(1));
    const receivedAt = vnMoment(new Date(start.getTime() - 2 * DAY_MS), 8);
    for (const store of stores) {
      const invoicesExpected = options.days * options.perDay * store.scale * 1.1;
      for (const [index, item] of items.entries()) {
        const expectedSaleUnits = invoicesExpected * (perInvoice.get(item.productId) ?? 0);
        // Vài mặt hàng cố ý nhập ít để có cảnh báo sắp hết, gợi ý đặt hàng.
        const cover = index % 9 === 4 ? 0.85 : 1.3;
        const base = Math.max(
          Math.ceil(expectedSaleUnits * cover) * item.conversion,
          item.conversion * 10,
        );
        const unitCost = (item.price / item.conversion) * (0.62 + rand() * 0.18);
        const nearExpiry = Math.round(base * 0.3);
        await receiveStock(
          store.id,
          store.code,
          auth.userId,
          receivedAt,
          item,
          [
            {
              suffix: `${String(index + 1).padStart(2, "0")}A`,
              baseQuantity: nearExpiry,
              // Lô hạn gần: một phần còn lại lúc cuối kỳ sẽ thành "sắp hết hạn".
              expiryDate: new Date(today.getTime() + (20 + Math.floor(rand() * 100)) * DAY_MS),
            },
            {
              suffix: `${String(index + 1).padStart(2, "0")}B`,
              baseQuantity: base - nearExpiry,
              expiryDate: new Date(today.getTime() + (300 + Math.floor(rand() * 400)) * DAY_MS),
            },
          ],
          unitCost,
        );
      }
    }
    console.log(`Đã nhập hàng: ${stores.length * items.length * 2} lô DEMOSALE-*.`);

    // 2. Bán hàng từng ngày.
    const dropDay = Math.floor(options.days * 0.65);
    const spikeDay = options.days - 9;
    const nowHour = (Date.now() + VN_OFFSET_MS - today.getTime()) / 3_600_000;
    let invoices = 0;
    let revenue = 0;
    let skipped = 0;
    for (let offset = 0; offset <= options.days; offset += 1) {
      const day = new Date(start.getTime() + offset * DAY_MS);
      const isToday = offset === options.days;
      const progress = offset / options.days;
      const date = new Date(day);
      const weekday = WEEKDAY[date.getUTCDay()]!;
      const dom = date.getUTCDate();
      const payday = dom <= 5 || (dom >= 15 && dom <= 17) ? 1.08 : 1;
      const trend = 0.85 + 0.3 * progress;
      let dayInvoices = 0;
      for (const [storeIndex, store] of stores.entries()) {
        let factor = weekday * payday * trend * store.scale * (0.85 + rand() * 0.3);
        if (offset === dropDay && storeIndex === 1) factor *= 0.3;
        if (offset === spikeDay && storeIndex === 0) factor *= 2;
        let count = Math.max(1, Math.round(options.perDay * factor));
        // Hôm nay: chỉ phần đã qua của ngày (mở cửa 7h–22h).
        if (isToday) count = Math.round(count * Math.min(Math.max((nowHour - 7) / 15, 0), 1));
        const hours = Array.from({ length: count }, () => {
          // Đông giờ trưa và chiều tối.
          const r = rand();
          const peak = r < 0.5 ? 11 + rand() * 2.5 : r < 0.85 ? 17 + rand() * 3.5 : 7 + rand() * 15;
          return isToday ? Math.min(peak, Math.max(nowHour - 0.05, 7)) : peak;
        }).sort((a, b) => a - b);
        for (const hour of hours) {
          const sold = await sell(store, auth, items, rand, seasonalBoost(progress));
          if (!sold) {
            skipped += 1;
            continue;
          }
          await backdate(store.id, store.code, sold.id, vnMoment(day, hour), day);
          invoices += 1;
          dayInvoices += 1;
          revenue += sold.total;
        }
      }
      if (offset % 7 === 0 || isToday) {
        console.log(
          `  ${dateText(day)} · ${dayInvoices} hóa đơn · tổng ${invoices.toLocaleString("vi-VN")} hóa đơn, ${money(revenue)}`,
        );
      }
    }
    const summary = { days: options.days, perDay: options.perDay, invoices, revenue };
    if (marker) {
      await prisma.setting.update({ where: { id: marker.id }, data: { value: summary } });
    } else {
      await prisma.setting.create({ data: { key: HISTORY_KEY, storeId: null, value: summary } });
    }
    console.log(
      `Xong: ${invoices.toLocaleString("vi-VN")} hóa đơn, doanh thu ${money(revenue)}` +
        (skipped ? `, ${skipped} hóa đơn bỏ qua vì hết hàng` : "") +
        ".",
    );
    console.log(
      `Có sẵn để thử: ngày ${dateText(new Date(start.getTime() + dropDay * DAY_MS))} ${stores[1]?.code ?? ""} giảm mạnh, ngày ${dateText(new Date(start.getTime() + spikeDay * DAY_MS))} ${stores[0]!.code} tăng vọt.`,
    );
  }

  if (!options.live) return;

  // 3. Bán trực tiếp: cứ vài giây một hóa đơn, ngày giờ thật, để xem số liệu nhảy.
  console.log(`\nBán trực tiếp: ~${options.interval} giây một hóa đơn. Ctrl+C để dừng.`);
  // Đổi trong trình xử lý Ctrl+C: để trong đối tượng cho vòng lặp đọc lại mỗi lượt.
  const state = { stopped: false };
  process.on("SIGINT", () => {
    state.stopped = true;
  });
  const totalScale = stores.reduce((sum, store) => sum + store.scale, 0);
  while (!state.stopped) {
    let target = rand() * totalScale;
    const store = stores.find((item) => (target -= item.scale) <= 0) ?? stores[0]!;
    const sold = await sell(store, auth, items, rand, seasonalBoost(1));
    const time = new Date().toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    console.log(
      sold
        ? `  ${time} · ${store.code} · ${sold.lines} dòng · ${money(sold.total)}`
        : `  ${time} · ${store.code} · bỏ qua (hết hàng)`,
    );
    const wait = options.interval * 1000 * (0.5 + rand());
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  console.log("Đã dừng bán trực tiếp.");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
