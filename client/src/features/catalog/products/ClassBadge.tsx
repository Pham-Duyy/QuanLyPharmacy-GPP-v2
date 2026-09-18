import { DRUG_CLASS, PRODUCT_TYPE } from "./product-labels.js";

/**
 * Nhãn phân loại hiển thị đúng dữ liệu đã lưu: thuốc theo phân loại kê đơn,
 * hàng khác theo loại hàng. Không suy đoán từ tên hay ảnh.
 */
export function ClassBadge({ productType, drugClass }: { productType: string; drugClass: string | null }) {
  const info = (drugClass ? DRUG_CLASS[drugClass] : null) ?? PRODUCT_TYPE[productType] ?? { text: "Không rõ loại", tone: "slate" };
  return <span className={`class-badge tone-${info.tone}`}>{info.text}</span>;
}
