import type { CustomerSearchItem, PrescriptionDetail, ProductDetail } from "../../../api/types.js";

/** Một dòng trong giỏ hàng ở quầy. */
export type CartLine = {
  key: string;
  product: ProductDetail;
  unitId: string;
  quantity: number;
  /** Chỉ có ý nghĩa với thuốc kê đơn: dòng nào của đơn thuốc đang chọn khớp với dòng này. */
  prescriptionItemId: string | null;
  /** Cách dùng in nhãn; chưa sửa (undefined) thì lấy liều dùng ghi trên đơn thuốc. */
  usage?: string;
  /** Số lần quét mã khớp vào dòng này (quét xác nhận lấy đúng thuốc). */
  scanned: number;
  /** Dòng tự điền từ đơn thuốc, người bán còn phải đi lấy. */
  fromPrescription?: boolean;
};

export type Customer = Pick<CustomerSearchItem, "id" | "fullName" | "phone">;

/** Thuốc kê đơn hoặc thuốc kiểm soát đặc biệt đều cần đơn thuốc mới bán được (contract §14.2). */
export function needsPrescription(drugClass: string | null): boolean {
  return drugClass === "RX" || drugClass === "CONTROLLED";
}

const vnd = new Intl.NumberFormat("vi-VN");
export const money = (value: number) => `${vnd.format(value)} đ`;

export function unitOf(line: CartLine) {
  return line.product.units.find((unit) => unit.id === line.unitId);
}

export function lineTotal(line: CartLine): number {
  return (unitOf(line)?.currentPrice?.salePrice ?? 0) * line.quantity;
}

/** Cách dùng sẽ in nhãn: chữ người bán ghi, không có thì liều dùng trên đơn thuốc. */
export function usageOf(line: CartLine, prescription: PrescriptionDetail | null): string {
  if (line.usage !== undefined) return line.usage.trim();
  const item = prescription?.items.find((candidate) => candidate.id === line.prescriptionItemId);
  return item?.dosageInstruction?.trim() ?? "";
}

/** Dòng đơn thuốc còn khớp được với một sản phẩm: đúng thuốc, chưa bán hết theo đơn. */
export function matchingPrescriptionItems(
  productId: string,
  prescription: PrescriptionDetail | null,
) {
  return (prescription?.items ?? []).filter(
    (item) => item.productId === productId && (item.baseQuantity ?? 0) > item.dispensedBaseQuantity,
  );
}
