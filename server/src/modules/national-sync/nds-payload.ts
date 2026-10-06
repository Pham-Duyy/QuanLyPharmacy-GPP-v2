import { prisma } from "../../db/prisma.js";
import { isLinkUsable } from "./nds-master.service.js";
import {
  stockInPayloadSchema,
  stockOutPayloadSchema,
  stockTakingPayloadSchema,
  type SyncPayload,
} from "./nds-schemas.js";

/**
 * Dựng dữ liệu gửi lên CSDL Dược từ chính chứng từ đã lưu.
 *
 * Hai quy ước xuyên suốt:
 *
 *   1. **Số lượng luôn quy về đơn vị cơ bản.** Thẻ kho và phân bổ lô của phần
 *      mềm đều tính theo đơn vị cơ bản; báo cáo theo hộp rồi bán lẻ theo vỉ
 *      là lệch ngay. Vì vậy bảng ghép mã chỉ cần một dòng cho mỗi mặt hàng.
 *
 *   2. **Chưa ghép mã thì không gửi.** Thiếu `drug_id` hay `unit_id` chắc chắn
 *      bị từ chối, mà gửi nhầm mã thuốc còn tệ hơn: đó là sai dữ liệu quản lý
 *      dược quốc gia. Chứng từ có mặt hàng chưa ghép mã bị giữ lại ở trạng
 *      thái BLOCKED kèm danh sách mặt hàng còn thiếu.
 */

/** Giờ Việt Nam kèm độ lệch múi giờ: không phụ thuộc múi giờ của máy chủ. */
export function vnDateTime(at: Date): string {
  const shifted = new Date(at.getTime() + 7 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+07:00`;
}

/** Cột kiểu DATE của Prisma là nửa đêm UTC, cắt thẳng là đúng ngày. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Giá quy về đơn vị cơ bản, làm tròn 2 chữ số thập phân theo đặc tả. */
function unitPrice(amount: bigint, conversionToBase: number): number {
  if (conversionToBase <= 0) return 0;
  return Math.round((Number(amount) / conversionToBase) * 100) / 100;
}

export type MissingLink = { productId: string; code: string; name: string; reason: string };

export type BuildResult =
  { ok: true; payload: SyncPayload } | { ok: false; missing: MissingLink[]; message: string };

type LinkRow = { drugId: string; unitId: string; gtin: string | null };

/**
 * Lấy mã quốc gia cho một loạt mặt hàng. Mặt hàng chưa ghép, hoặc ghép theo
 * tên mà chưa ai xác nhận, đều bị coi là thiếu.
 */
async function resolveLinks(
  productIds: string[],
): Promise<{ links: Map<string, LinkRow>; missing: MissingLink[] }> {
  const unique = [...new Set(productIds)];
  const [products, linkRows] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: unique } },
      select: { id: true, code: true, name: true },
    }),
    prisma.nationalDrugLink.findMany({ where: { productId: { in: unique } } }),
  ]);

  const byProduct = new Map(linkRows.map((row) => [row.productId, row]));
  const links = new Map<string, LinkRow>();
  const missing: MissingLink[] = [];

  for (const product of products) {
    const link = byProduct.get(product.id);
    if (!link) {
      missing.push({ ...product, productId: product.id, reason: "Chưa ghép mã thuốc quốc gia" });
      continue;
    }
    if (!isLinkUsable(link)) {
      missing.push({
        ...product,
        productId: product.id,
        reason: "Mã ghép theo tên, cần người xác nhận trước khi gửi",
      });
      continue;
    }
    links.set(product.id, { drugId: link.drugId, unitId: link.unitId, gtin: link.gtin });
  }

  return { links, missing };
}

function blocked(missing: MissingLink[]): BuildResult {
  const names = missing
    .slice(0, 3)
    .map((item) => item.code)
    .join(", ");
  const more = missing.length > 3 ? ` và ${missing.length - 3} mặt hàng khác` : "";
  return {
    ok: false,
    missing,
    message: `Chưa gửi được: ${names}${more} chưa có mã thuốc quốc gia`,
  };
}

type RawItem = {
  productId: string;
  quantity: number;
  batchNo: string;
  expiryDate: Date;
  price?: number;
  manufacturer?: { name?: string | null; country?: string | null };
  systemQuantity?: number;
  actualQuantity?: number;
};

function toItems(raw: RawItem[], links: Map<string, LinkRow>) {
  return raw.map((item) => {
    const link = links.get(item.productId)!;
    return {
      drug_id: link.drugId,
      unit_id: link.unitId,
      quantity: item.quantity,
      batch_no: item.batchNo,
      expiry_date: isoDate(item.expiryDate),
      ...(link.gtin ? { gtin: link.gtin } : {}),
      ...(item.price === undefined ? {} : { price: item.price }),
      ...(item.manufacturer?.name
        ? {
            manufacturer: {
              name: item.manufacturer.name.slice(0, 200),
              ...(item.manufacturer.country
                ? { country: item.manufacturer.country.slice(0, 5) }
                : {}),
            },
          }
        : {}),
      ...(item.systemQuantity === undefined ? {} : { system_quantity: item.systemQuantity }),
      ...(item.actualQuantity === undefined ? {} : { actual_quantity: item.actualQuantity }),
    };
  });
}

/** Mã giấy phép của đúng cửa hàng phát sinh chứng từ. */
async function practiceLicenseCode(storeId: string): Promise<string | undefined> {
  const config = await prisma.nationalSyncStoreConfig.findUnique({ where: { storeId } });
  return config?.practiceLicenseCode ?? undefined;
}

// --- Phiếu nhập -------------------------------------------------------------

export async function buildGoodsReceiptPayload(goodsReceiptId: string): Promise<BuildResult> {
  const receipt = await prisma.goodsReceipt.findUnique({
    where: { id: goodsReceiptId },
    include: {
      supplier: { select: { taxCode: true, name: true } },
      lines: {
        include: {
          product: { select: { id: true, manufacturer: true, countryOfOrigin: true } },
          productUnit: { select: { conversionToBase: true } },
        },
        orderBy: { lineNo: "asc" },
      },
    },
  });
  if (!receipt) return { ok: false, missing: [], message: "Không tìm thấy phiếu nhập" };
  if (receipt.lines.length === 0) {
    return { ok: false, missing: [], message: "Phiếu nhập không có dòng hàng nào" };
  }

  const { links, missing } = await resolveLinks(receipt.lines.map((line) => line.productId));
  if (missing.length > 0) return blocked(missing);

  const items = toItems(
    receipt.lines.map((line) => ({
      productId: line.productId,
      quantity: line.baseQuantity,
      batchNo: line.batchNumber,
      expiryDate: line.expiryDate,
      price: unitPrice(line.unitCost, line.productUnit.conversionToBase),
      manufacturer: {
        name: line.product.manufacturer,
        country: line.product.countryOfOrigin,
      },
    })),
    links,
  );

  const licence = await practiceLicenseCode(receipt.storeId);
  const payload = stockInPayloadSchema.parse({
    transaction_date: vnDateTime(receipt.receivedAt),
    reason: receipt.type === "OPENING_BALANCE" ? "opening-balance" : "supplier",
    reference_number: receipt.code,
    ...(receipt.supplier?.taxCode ? { supplier_id: receipt.supplier.taxCode } : {}),
    ...(receipt.note ? { note: receipt.note.slice(0, 500) } : {}),
    ...(licence ? { practice_license_code: licence } : {}),
    items,
  });

  return { ok: true, payload };
}

// --- Hóa đơn bán lẻ ---------------------------------------------------------

export async function buildInvoicePayload(invoiceId: string): Promise<BuildResult> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      lines: {
        include: {
          product: { select: { id: true, manufacturer: true, countryOfOrigin: true } },
          allocations: { include: { batch: { select: { batchNumber: true, expiryDate: true } } } },
        },
        orderBy: { lineNo: "asc" },
      },
    },
  });
  if (!invoice) return { ok: false, missing: [], message: "Không tìm thấy hóa đơn" };

  const { links, missing } = await resolveLinks(invoice.lines.map((line) => line.productId));
  if (missing.length > 0) return blocked(missing);

  // Một dòng hóa đơn có thể lấy từ nhiều lô (FEFO), mà CSDL Dược ghi nhận
  // theo lô, nên mỗi lô là một dòng gửi đi.
  const raw: RawItem[] = [];
  for (const line of invoice.lines) {
    for (const allocation of line.allocations) {
      // Số đã trả lại phải trừ đi: hóa đơn gửi lên phản ánh số thực xuất.
      const quantity = allocation.baseQuantity - allocation.returnedBaseQuantity;
      if (quantity <= 0) continue;
      raw.push({
        productId: line.productId,
        quantity,
        batchNo: allocation.batch.batchNumber,
        expiryDate: allocation.batch.expiryDate,
        price: unitPrice(line.unitPrice, line.conversionToBase),
        manufacturer: {
          name: line.product.manufacturer,
          country: line.product.countryOfOrigin,
        },
      });
    }
  }

  if (raw.length === 0) {
    return { ok: false, missing: [], message: "Hóa đơn không còn dòng hàng nào để gửi" };
  }

  const licence = await practiceLicenseCode(invoice.storeId);
  const payload = stockOutPayloadSchema.parse({
    transaction_date: vnDateTime(invoice.soldAt),
    reason: "sale-retail",
    reference_number: invoice.code,
    ...(licence ? { practice_license_code: licence } : {}),
    items: toItems(raw, links),
  });

  return { ok: true, payload };
}

// --- Trả hàng nhà cung cấp --------------------------------------------------

export async function buildSupplierReturnPayload(supplierReturnId: string): Promise<BuildResult> {
  const supplierReturn = await prisma.supplierReturn.findUnique({
    where: { id: supplierReturnId },
    include: {
      supplier: { select: { taxCode: true } },
      lines: {
        include: {
          product: { select: { id: true, manufacturer: true, countryOfOrigin: true } },
          productUnit: { select: { conversionToBase: true } },
          batch: { select: { batchNumber: true, expiryDate: true } },
        },
        orderBy: { lineNo: "asc" },
      },
    },
  });
  if (!supplierReturn) return { ok: false, missing: [], message: "Không tìm thấy phiếu trả hàng" };
  if (supplierReturn.lines.length === 0) {
    return { ok: false, missing: [], message: "Phiếu trả hàng không có dòng nào" };
  }

  const { links, missing } = await resolveLinks(supplierReturn.lines.map((line) => line.productId));
  if (missing.length > 0) return blocked(missing);

  const licence = await practiceLicenseCode(supplierReturn.storeId);
  const payload = stockOutPayloadSchema.parse({
    transaction_date: vnDateTime(supplierReturn.returnedAt),
    reason: "return",
    reference_number: supplierReturn.code,
    ...(supplierReturn.supplier.taxCode ? { supplier_id: supplierReturn.supplier.taxCode } : {}),
    ...(licence ? { practice_license_code: licence } : {}),
    ...(supplierReturn.note ? { note: supplierReturn.note.slice(0, 500) } : {}),
    items: toItems(
      supplierReturn.lines.map((line) => ({
        productId: line.productId,
        quantity: line.baseQuantity,
        batchNo: line.batch.batchNumber,
        expiryDate: line.batch.expiryDate,
        price: unitPrice(line.unitCost, line.productUnit.conversionToBase),
        manufacturer: {
          name: line.product.manufacturer,
          country: line.product.countryOfOrigin,
        },
      })),
      links,
    ),
  });

  return { ok: true, payload };
}

// --- Chuyển hàng giữa các cửa hàng -----------------------------------------

/**
 * Đặc tả có `source_store_id` / `target_store_id` nhưng không nói đó là mã gì
 * (mã cơ sở trên CSDL Dược? mã giấy phép?), nên KHÔNG điền — gửi nhầm mã cơ
 * sở còn tệ hơn để trống. Cửa hàng đối ứng ghi vào `note` (§25.8).
 */
function counterpartNote(
  prefix: string,
  store: { code: string; name: string; gppCertificateNumber: string | null },
) {
  const gpp = store.gppCertificateNumber ? ` (GPP ${store.gppCertificateNumber})` : "";
  return `${prefix} ${store.code} · ${store.name}${gpp}`.slice(0, 500);
}

function transferPrice(unitCost: { toNumber(): number } | null): number | undefined {
  return unitCost === null ? undefined : Math.round(unitCost.toNumber() * 100) / 100;
}

async function loadTransfer(transferId: string) {
  return prisma.stockTransfer.findUnique({
    where: { id: transferId },
    include: {
      fromStore: { select: { code: true, name: true, gppCertificateNumber: true } },
      toStore: { select: { code: true, name: true, gppCertificateNumber: true } },
      lines: {
        include: { product: { select: { manufacturer: true, countryOfOrigin: true } } },
        orderBy: { lineNo: "asc" },
      },
    },
  });
}

/** Cửa hàng gửi: phiếu xuất lý do `transfer-out`, ngày xuất kho. */
export async function buildTransferOutPayload(transferId: string): Promise<BuildResult> {
  const transfer = await loadTransfer(transferId);
  if (!transfer || !transfer.shippedAt) {
    return { ok: false, missing: [], message: "Không tìm thấy phiếu chuyển đã xuất kho" };
  }

  const { links, missing } = await resolveLinks(transfer.lines.map((line) => line.productId));
  if (missing.length > 0) return blocked(missing);

  const licence = await practiceLicenseCode(transfer.fromStoreId);
  const payload = stockOutPayloadSchema.parse({
    transaction_date: vnDateTime(transfer.shippedAt),
    reason: "transfer-out",
    reference_number: transfer.code,
    ...(licence ? { practice_license_code: licence } : {}),
    note: counterpartNote("Chuyển đến", transfer.toStore),
    items: toItems(
      transfer.lines.map((line) => {
        const price = transferPrice(line.unitCost);
        return {
          productId: line.productId,
          quantity: line.baseQuantity,
          batchNo: line.batchNumber,
          expiryDate: line.expiryDate,
          ...(price === undefined ? {} : { price }),
          manufacturer: { name: line.product.manufacturer, country: line.product.countryOfOrigin },
        };
      }),
      links,
    ),
  });
  return { ok: true, payload };
}

/** Cửa hàng nhận: phiếu nhập lý do `transfer-in`, chỉ phần thực nhận. */
export async function buildTransferInPayload(transferId: string): Promise<BuildResult> {
  const transfer = await loadTransfer(transferId);
  if (!transfer || !transfer.receivedAt) {
    return { ok: false, missing: [], message: "Không tìm thấy phiếu chuyển đã nhận" };
  }
  const received = transfer.lines.filter((line) => (line.receivedBaseQuantity ?? 0) > 0);
  if (received.length === 0) {
    return { ok: false, missing: [], message: "Phiếu chuyển không có hàng thực nhận" };
  }

  const { links, missing } = await resolveLinks(received.map((line) => line.productId));
  if (missing.length > 0) return blocked(missing);

  const licence = await practiceLicenseCode(transfer.toStoreId);
  const payload = stockInPayloadSchema.parse({
    transaction_date: vnDateTime(transfer.receivedAt),
    reason: "transfer-in",
    reference_number: transfer.code,
    ...(licence ? { practice_license_code: licence } : {}),
    note: counterpartNote("Nhận từ", transfer.fromStore),
    items: toItems(
      received.map((line) => {
        const price = transferPrice(line.unitCost);
        return {
          productId: line.productId,
          quantity: line.receivedBaseQuantity!,
          batchNo: line.batchNumber,
          expiryDate: line.expiryDate,
          ...(price === undefined ? {} : { price }),
          manufacturer: { name: line.product.manufacturer, country: line.product.countryOfOrigin },
        };
      }),
      links,
    ),
  });
  return { ok: true, payload };
}

// --- Khách trả hàng (nhập lại kho) -----------------------------------------

export async function buildCustomerReturnPayload(returnId: string): Promise<BuildResult> {
  const customerReturn = await prisma.return.findUnique({
    where: { id: returnId },
    include: {
      lines: {
        include: {
          invoiceLine: {
            include: {
              product: { select: { id: true, manufacturer: true, countryOfOrigin: true } },
            },
          },
          invoiceAllocation: {
            include: { batch: { select: { batchNumber: true, expiryDate: true } } },
          },
          productUnit: { select: { conversionToBase: true } },
        },
        orderBy: { lineNo: "asc" },
      },
    },
  });
  if (!customerReturn) return { ok: false, missing: [], message: "Không tìm thấy phiếu trả hàng" };
  // Hàng không nhập lại kho thì thẻ kho không tăng, nên không có gì để báo nhập.
  if (customerReturn.disposition !== "RESTOCK") {
    return { ok: false, missing: [], message: "Phiếu trả hàng hủy, không nhập lại kho" };
  }

  const productIds = customerReturn.lines.map((line) => line.invoiceLine.productId);
  const { links, missing } = await resolveLinks(productIds);
  if (missing.length > 0) return blocked(missing);

  const licence = await practiceLicenseCode(customerReturn.storeId);
  const payload = stockInPayloadSchema.parse({
    transaction_date: vnDateTime(customerReturn.createdAt),
    reason: "return",
    reference_number: customerReturn.code,
    ...(licence ? { practice_license_code: licence } : {}),
    ...(customerReturn.reason ? { note: customerReturn.reason.slice(0, 500) } : {}),
    items: toItems(
      customerReturn.lines.map((line) => ({
        productId: line.invoiceLine.productId,
        quantity: line.baseQuantity,
        batchNo: line.invoiceAllocation.batch.batchNumber,
        expiryDate: line.invoiceAllocation.batch.expiryDate,
        price: unitPrice(line.invoiceLine.unitPrice, line.invoiceLine.conversionToBase),
        manufacturer: {
          name: line.invoiceLine.product.manufacturer,
          country: line.invoiceLine.product.countryOfOrigin,
        },
      })),
      links,
    ),
  });

  return { ok: true, payload };
}

// --- Kiểm kê ----------------------------------------------------------------

export async function buildStockCountPayload(stockCountId: string): Promise<BuildResult> {
  const stockCount = await prisma.stockCount.findUnique({
    where: { id: stockCountId },
    include: {
      lines: {
        include: {
          product: { select: { id: true, manufacturer: true, countryOfOrigin: true } },
          batch: { select: { batchNumber: true, expiryDate: true } },
        },
        orderBy: { lineNo: "asc" },
      },
    },
  });
  if (!stockCount) return { ok: false, missing: [], message: "Không tìm thấy đợt kiểm kê" };

  // Chỉ gửi dòng đã đếm; dòng bỏ trống không phải là "đếm được 0".
  const counted = stockCount.lines.filter((line) => line.countedBaseQuantity !== null);
  if (counted.length === 0) {
    return { ok: false, missing: [], message: "Đợt kiểm kê chưa có dòng nào được đếm" };
  }

  const { links, missing } = await resolveLinks(counted.map((line) => line.productId));
  if (missing.length > 0) return blocked(missing);

  const licence = await practiceLicenseCode(stockCount.storeId);
  const payload = stockTakingPayloadSchema.parse({
    transaction_date: vnDateTime(stockCount.closedAt ?? stockCount.startedAt),
    reference_number: stockCount.code,
    ...(licence ? { practice_license_code: licence } : {}),
    ...(stockCount.note ? { note: stockCount.note.slice(0, 500) } : {}),
    items: toItems(
      counted.map((line) => ({
        productId: line.productId,
        quantity: line.countedBaseQuantity!,
        batchNo: line.batch.batchNumber,
        expiryDate: line.batch.expiryDate,
        systemQuantity: line.systemBaseQuantityAtCount ?? line.systemBaseQuantityAtOpen,
        actualQuantity: line.countedBaseQuantity!,
        manufacturer: {
          name: line.product.manufacturer,
          country: line.product.countryOfOrigin,
        },
      })),
      links,
    ),
  });

  return { ok: true, payload };
}

/**
 * Phiếu kiểm hàng đầu kỳ: ảnh chụp toàn bộ tồn hiện tại, gửi đúng một lần khi
 * bắt đầu liên thông. Hệ thống quốc gia chỉ ghi nhận chứng từ phát sinh sau
 * ngày của phiếu này. Nhà thuốc chưa có hàng vẫn phải gửi, danh sách rỗng.
 */
export async function buildOpeningStockTakingPayload(
  storeId: string,
  referenceNumber: string,
  at: Date,
): Promise<BuildResult> {
  const batches = await prisma.batch.findMany({
    where: { storeId, quantityOnHand: { gt: 0 } },
    include: {
      product: { select: { id: true, manufacturer: true, countryOfOrigin: true } },
    },
    orderBy: [{ productId: "asc" }, { expiryDate: "asc" }],
  });

  const { links, missing } = await resolveLinks(batches.map((batch) => batch.productId));
  if (missing.length > 0) return blocked(missing);

  const licence = await practiceLicenseCode(storeId);
  const payload = stockTakingPayloadSchema.parse({
    transaction_date: vnDateTime(at),
    reference_number: referenceNumber,
    ...(licence ? { practice_license_code: licence } : {}),
    note: "Tồn đầu kỳ khi bắt đầu liên thông CSDL Dược",
    items: toItems(
      batches.map((batch) => ({
        productId: batch.productId,
        quantity: batch.quantityOnHand,
        batchNo: batch.batchNumber,
        expiryDate: batch.expiryDate,
        systemQuantity: batch.quantityOnHand,
        actualQuantity: batch.quantityOnHand,
        price: batch.unitCost ? Math.round(Number(batch.unitCost) * 100) / 100 : undefined,
        manufacturer: {
          name: batch.product.manufacturer,
          country: batch.product.countryOfOrigin,
        },
      })),
      links,
    ),
  });

  return { ok: true, payload };
}
