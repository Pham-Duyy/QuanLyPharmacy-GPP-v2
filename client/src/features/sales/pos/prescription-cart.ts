import type { PrescriptionItem, ProductDetail, ProductUnit } from "../../../api/types.js";

/** Số còn bán được theo một dòng đơn thuốc, tính theo đơn vị nhỏ nhất. */
export function remainingBase(item: PrescriptionItem): number {
  return Math.max(0, (item.baseQuantity ?? 0) - item.dispensedBaseQuantity);
}

/**
 * Số còn lại để hiện cho người bán: theo đơn vị kê nếu chia hết, không thì
 * theo đơn vị nhỏ nhất của sản phẩm (đã bán lẻ một phần theo viên).
 */
export function remainingText(item: PrescriptionItem, baseUnitName: string | undefined): string {
  const left = remainingBase(item);
  const perUnit = item.baseQuantity && item.quantity > 0 ? item.baseQuantity / item.quantity : 1;
  if (item.unitName && Number.isInteger(left / perUnit))
    return `${left / perUnit} ${item.unitName}`;
  return `${left} ${baseUnitName ?? ""}`.trim();
}

function sellableUnits(product: ProductDetail): ProductUnit[] {
  return product.units.filter((unit) => unit.isSellable !== false && unit.isActive !== false);
}

export type PrescriptionCartLine = {
  product: ProductDetail;
  unitId: string;
  quantity: number;
  prescriptionItemId: string;
};

/**
 * Các dòng giỏ hàng lấy từ đơn thuốc: mỗi dòng đơn còn số lượng thành một
 * dòng, đơn vị theo đơn kê nếu chia hết số còn lại, không thì đơn vị nhỏ
 * nhất. Dòng có sản phẩm đã nằm trong giỏ thì để nguyên giỏ, không thêm.
 * `skipped` là tên các thuốc không tự thêm được để người bán thêm tay.
 */
export function prescriptionCartLines(
  items: PrescriptionItem[],
  products: Map<string, ProductDetail>,
  inCart: Set<string>,
): { lines: PrescriptionCartLine[]; skipped: string[] } {
  const lines: PrescriptionCartLine[] = [];
  const skipped: string[] = [];
  for (const item of items) {
    const left = remainingBase(item);
    if (left <= 0 || (item.productId && inCart.has(item.productId))) continue;
    const product = item.productId ? products.get(item.productId) : undefined;
    const units = product?.isActive ? sellableUnits(product) : [];
    const prescribed = units.find((unit) => unit.id === item.unitId);
    const unit = [
      ...(prescribed ? [prescribed] : []),
      ...[...units].sort((a, b) => a.conversionToBase - b.conversionToBase),
    ].find((candidate) => left % candidate.conversionToBase === 0);
    if (!product || !unit) {
      skipped.push(item.productName ?? item.drugNameText);
      continue;
    }
    lines.push({
      product,
      unitId: unit.id,
      quantity: left / unit.conversionToBase,
      prescriptionItemId: item.id,
    });
  }
  return { lines, skipped };
}

/** Sản phẩm của các dòng đơn còn bán được mà giỏ chưa có, để tải chi tiết trước khi thêm. */
export function productsToFetch(items: PrescriptionItem[], inCart: Set<string>): string[] {
  return [
    ...new Set(
      items
        .filter((item) => item.productId && remainingBase(item) > 0 && !inCart.has(item.productId))
        .map((item) => item.productId!),
    ),
  ];
}
