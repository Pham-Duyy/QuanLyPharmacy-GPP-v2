import type { ProductListItem } from "../../../api/types.js";
import { formatNumber } from "../../../ui/format.js";

export const DRUG_CLASS: Record<string, { text: string; tone: string }> = {
  OTC: { text: "Không kê đơn", tone: "green" },
  RX: { text: "Kê đơn", tone: "orange" },
  CONTROLLED: { text: "Kiểm soát đặc biệt", tone: "red" },
};

export const PRODUCT_TYPE: Record<string, { text: string; tone: string }> = {
  DRUG: { text: "Thuốc", tone: "slate" },
  SUPPLEMENT: { text: "TP bảo vệ sức khỏe", tone: "blue" },
  MEDICAL_DEVICE: { text: "Thiết bị y tế", tone: "cyan" },
  COSMETIC: { text: "Mỹ phẩm", tone: "purple" },
  OTHER: { text: "Khác", tone: "slate" },
};

const vnd = new Intl.NumberFormat("vi-VN");

/** "1.500 đ / viên". Giá 0 là giá hợp lệ; chưa có giá thì trả `null` để hiển thị "Chưa đặt giá". */
export function priceText(salePrice: number | null | undefined, unitName: string | null | undefined): string | null {
  if (salePrice === null || salePrice === undefined) return null;
  return `${vnd.format(salePrice)} đ${unitName ? ` / ${unitName.toLowerCase()}` : ""}`;
}

export function stockText(quantity: number, unitName: string | null | undefined): string {
  return `${formatNumber(quantity)}${unitName ? ` ${unitName.toLowerCase()}` : ""}`;
}

/** Dòng phụ dưới tên: mã · nhóm hàng (hoặc hoạt chất nếu có). */
export function subtitle(item: Pick<ProductListItem, "code" | "categoryName" | "ingredients">): string {
  const ingredients = item.ingredients
    .map((ingredient) => [ingredient.name, ingredient.strengthText].filter(Boolean).join(" "))
    .join(", ");
  return [item.code, item.categoryName, ingredients].filter(Boolean).join(" · ");
}

export const PRODUCT_DETAIL_QUERY = "product-detail";

/** Ảnh dự phòng khi tệp ảnh lỗi: khung xám nhạt trung tính, không phải ảnh sản phẩm. */
export const IMAGE_FALLBACK =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240"><rect width="240" height="240" fill="#f1f4f9"/><rect x="92" y="96" width="56" height="48" rx="8" fill="none" stroke="#b4c1d3" stroke-width="6"/><path d="M110 96v-8h20v8M120 108v24M108 120h24" stroke="#b4c1d3" stroke-width="6" fill="none" stroke-linecap="round"/></svg>',
  );
