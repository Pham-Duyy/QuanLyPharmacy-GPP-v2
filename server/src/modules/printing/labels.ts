import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { getCurrentPrices } from "../catalog/products.service.js";
import { barcodeSvg, detectKind } from "./barcode.js";
import { escapeHtml, money, printDate } from "./print-common.js";

/**
 * In tem mã vạch dán lên hộp thuốc hoặc nhãn kệ.
 *
 * Mã in trên tem lấy theo thứ tự: mã vạch của đơn vị đang chọn → mã vạch của
 * đơn vị khác cùng sản phẩm → mã sản phẩm nội bộ (Code128). Không bao giờ tự
 * sinh mã EAN cho thuốc chưa có, vì mã EAN là của nhà sản xuất đăng ký.
 */

export type LabelSize = "50x30" | "40x30" | "35x22" | "A4_38x21";

type SizeSpec = {
  label: string;
  /** Khổ tem, mm. */
  width: number;
  height: number;
  /** Số tem mỗi hàng khi in trên giấy A4; tem nhiệt thì mỗi tem một trang. */
  columns: number | null;
  nameFont: string;
  priceFont: string;
  metaFont: string;
  barcodeHeight: number;
  moduleMm: number;
};

export const SIZES: Record<LabelSize, SizeSpec> = {
  "50x30": { label: "Tem nhiệt 50 × 30 mm", width: 50, height: 30, columns: null, nameFont: "7.5pt", priceFont: "10pt", metaFont: "6pt", barcodeHeight: 10, moduleMm: 0.33 },
  "40x30": { label: "Tem nhiệt 40 × 30 mm", width: 40, height: 30, columns: null, nameFont: "7pt", priceFont: "9.5pt", metaFont: "5.5pt", barcodeHeight: 9, moduleMm: 0.26 },
  "35x22": { label: "Tem nhiệt 35 × 22 mm", width: 35, height: 22, columns: null, nameFont: "6pt", priceFont: "8pt", metaFont: "5pt", barcodeHeight: 7, moduleMm: 0.25 },
  A4_38x21: { label: "Giấy decal A4 · 65 tem 38 × 21 mm", width: 38, height: 21, columns: 5, nameFont: "6pt", priceFont: "7.5pt", metaFont: "5pt", barcodeHeight: 6.5, moduleMm: 0.25 },
};

export type LabelItemInput = { productId: string; unitId?: string | null; batchId?: string | null; quantity: number };

export type LabelOptions = {
  size: LabelSize;
  showPrice: boolean;
  showBatch: boolean;
  showStoreName: boolean;
  autoPrint: boolean;
};

export type LabelWarning = { productName: string; message: string };

type PreparedLabel = {
  productName: string;
  productCode: string;
  unitName: string;
  price: number | null;
  batchNumber: string | null;
  expiryDate: Date | null;
  barcodeValue: string;
  barcodeSvg: string;
  /** Mã nội bộ: không phải mã vạch do nhà sản xuất đăng ký. */
  internalCode: boolean;
  count: number;
};

export type LabelRender = { html: string; labelCount: number; warnings: LabelWarning[] };

export async function renderLabels(storeId: string, items: LabelItemInput[], options: LabelOptions): Promise<LabelRender> {
  const products = await prisma.product.findMany({
    where: { id: { in: items.map((item) => item.productId) } },
    include: { units: { where: { isActive: true }, include: { barcodes: true }, orderBy: { conversionToBase: "asc" } } },
  });
  const byId = new Map(products.map((product) => [product.id, product]));

  const batches = options.showBatch
    ? await prisma.batch.findMany({
        where: { id: { in: items.map((item) => item.batchId).filter((id): id is string => Boolean(id)) }, storeId },
        select: { id: true, batchNumber: true, expiryDate: true, productId: true },
      })
    : [];
  const batchById = new Map(batches.map((batch) => [batch.id, batch]));

  const unitIds = items
    .map((item) => item.unitId ?? byId.get(item.productId)?.units.find((unit) => unit.isDefaultSaleUnit)?.id ?? byId.get(item.productId)?.units[0]?.id)
    .filter((id): id is string => Boolean(id));
  const prices = options.showPrice ? await getCurrentPrices(unitIds, storeId) : new Map();

  const store = options.showStoreName ? await prisma.store.findUnique({ where: { id: storeId }, select: { name: true } }) : null;
  const warnings: LabelWarning[] = [];
  const prepared: PreparedLabel[] = [];

  for (const item of items) {
    const product = byId.get(item.productId);
    if (!product) throw AppError.notFound("Không tìm thấy sản phẩm cần in tem");
    const unit = (item.unitId ? product.units.find((entry) => entry.id === item.unitId) : undefined) ?? product.units.find((entry) => entry.isDefaultSaleUnit) ?? product.units[0];
    if (!unit) throw AppError.validation(`${product.name} chưa có đơn vị tính, không in tem được`);

    // Mã vạch của chính đơn vị đang in; không có thì dùng mã của đơn vị khác
    // cùng sản phẩm; vẫn không có thì in mã nội bộ.
    const ownBarcode = unit.barcodes[0]?.barcode;
    const anyBarcode = product.units.flatMap((entry) => entry.barcodes)[0]?.barcode;
    const barcodeValue = ownBarcode ?? anyBarcode ?? product.code;
    const internalCode = !ownBarcode && !anyBarcode;
    if (internalCode) {
      warnings.push({ productName: product.name, message: "Chưa có mã vạch nhà sản xuất, tem in mã nội bộ theo mã sản phẩm" });
    } else if (!ownBarcode) {
      warnings.push({ productName: product.name, message: `Đơn vị ${unit.name} chưa có mã vạch riêng, tem dùng mã của đơn vị khác` });
    }

    // Mã lưu trong danh mục trông như EAN nhưng sai số kiểm: in Code128 nguyên
    // văn và nói rõ, vì tự sửa số kiểm sẽ thành mã của mặt hàng khác.
    if (!internalCode && /^\d{8}$|^\d{13}$/.test(barcodeValue) && detectKind(barcodeValue) === "CODE128") {
      warnings.push({ productName: product.name, message: `Mã vạch ${barcodeValue} sai số kiểm của chuẩn EAN, tem in dạng Code128` });
    }

    const price = options.showPrice ? (prices.get(unit.id) ? Number(prices.get(unit.id)!.salePrice) : null) : null;
    if (options.showPrice && price === null) {
      warnings.push({ productName: product.name, message: `Đơn vị ${unit.name} chưa có giá bán, tem in không kèm giá` });
    }

    const batch = item.batchId ? batchById.get(item.batchId) : undefined;
    if (item.batchId && options.showBatch && !batch) {
      throw AppError.validation(`${product.name}: không tìm thấy lô trong kho cửa hàng này`);
    }

    let drawn;
    try {
      drawn = barcodeSvg(barcodeValue, { heightMm: SIZES[options.size].barcodeHeight, moduleMm: SIZES[options.size].moduleMm });
    } catch {
      throw AppError.validation(`${product.name}: mã "${barcodeValue}" có ký tự không in được thành mã vạch`);
    }

    prepared.push({
      productName: product.name,
      productCode: product.code,
      unitName: unit.name,
      price,
      batchNumber: batch?.batchNumber ?? null,
      expiryDate: batch?.expiryDate ?? null,
      barcodeValue,
      barcodeSvg: drawn.svg,
      internalCode,
      count: item.quantity,
    });
  }

  const labelCount = prepared.reduce((sum, label) => sum + label.count, 0);
  return { html: renderHtml(prepared, options, store?.name ?? null), labelCount, warnings };
}

function labelHtml(label: PreparedLabel, options: LabelOptions, storeName: string | null): string {
  const meta = [
    label.batchNumber ? `Lô ${escapeHtml(label.batchNumber)}` : null,
    label.expiryDate ? `HSD ${printDate(label.expiryDate)}` : null,
  ].filter(Boolean);

  return `<div class="label">
  ${storeName ? `<div class="store">${escapeHtml(storeName)}</div>` : ""}
  <div class="name">${escapeHtml(label.productName)}</div>
  <div class="barcode">${label.barcodeSvg}</div>
  <div class="code">${escapeHtml(label.barcodeValue)}${label.internalCode ? " · mã nội bộ" : ""}</div>
  <div class="foot">
    ${label.price === null ? `<span class="unit">${escapeHtml(label.unitName)}</span>` : `<span class="price">${money(label.price)} đ/${escapeHtml(label.unitName)}</span>`}
    ${meta.length > 0 ? `<span class="meta">${meta.join(" · ")}</span>` : ""}
  </div>
</div>`;
}

function renderHtml(labels: PreparedLabel[], options: LabelOptions, storeName: string | null): string {
  const spec = SIZES[options.size];
  const sheet = spec.columns !== null;
  const body = labels.flatMap((label) => Array.from({ length: label.count }, () => labelHtml(label, options, storeName))).join("\n");

  // Tem nhiệt: mỗi tem một trang đúng khổ. Giấy decal A4: xếp lưới theo cột.
  const page = sheet ? `@page { size: A4; margin: 10mm 6mm; }` : `@page { size: ${spec.width}mm ${spec.height}mm; margin: 0; }`;
  const layout = sheet
    ? `.sheet { display: grid; grid-template-columns: repeat(${spec.columns}, ${spec.width}mm); gap: 0; }
       .label { width: ${spec.width}mm; height: ${spec.height}mm; }`
    : `.label { width: ${spec.width}mm; height: ${spec.height}mm; page-break-after: always; }
       .label:last-child { page-break-after: auto; }`;

  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<title>Tem mã vạch</title>
<style>
  ${page}
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", Roboto, Arial, sans-serif; color: #000; -webkit-print-color-adjust: exact; }
  ${layout}
  .label {
    padding: 1mm 1.2mm;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    overflow: hidden;
    text-align: center;
  }
  .store { font-size: ${spec.metaFont}; line-height: 1.1; opacity: 0.75; width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .name {
    font-size: ${spec.nameFont};
    line-height: 1.15;
    font-weight: 600;
    width: 100%;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .barcode { line-height: 0; }
  .barcode svg { display: block; }
  .code { font-size: ${spec.metaFont}; letter-spacing: 0.3px; line-height: 1.1; }
  .foot { width: 100%; display: flex; flex-direction: column; gap: 0.3mm; }
  .price { font-size: ${spec.priceFont}; font-weight: 700; line-height: 1.1; }
  .unit { font-size: ${spec.metaFont}; }
  .meta { font-size: ${spec.metaFont}; line-height: 1.1; }
  @media screen {
    body { background: #f4f7fb; padding: 8mm; }
    .label { background: #fff; outline: 1px dashed #b4c1d3; }
    ${sheet ? "" : ".label { margin: 0 auto 4mm; }"}
  }
</style>
</head>
<body>
${sheet ? `<div class="sheet">${body}</div>` : body}
${options.autoPrint ? "<script>window.addEventListener('load', () => window.print());</script>" : ""}
</body>
</html>`;
}
