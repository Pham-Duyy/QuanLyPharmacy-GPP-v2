import type { GoodsReceiptDetail } from "../../../api/types.js";

export const STATUS: Record<GoodsReceiptDetail["status"], { text: string; color: string }> = {
  DRAFT: { text: "Chờ kiểm nhập", color: "gold" },
  CONFIRMED: { text: "Đã nhập kho", color: "green" },
  CANCELLED: { text: "Đã hủy", color: "default" },
};
