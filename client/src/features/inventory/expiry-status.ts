import { formatNumber } from "../../ui/format.js";

/**
 * Lô hết hạn từ chính ngày ghi trên bao bì (`daysLeft` = 0), cùng cách tính với
 * quầy bán: hôm đó đã không bán được nữa.
 */
export function isExpired(daysLeft: number): boolean {
  return daysLeft <= 0;
}

/** Dòng chữ dưới hạn dùng: "Đã quá hạn 3 ngày", "Hết hạn hôm nay", "Còn 12 ngày". */
export function daysLeftLabel(daysLeft: number): string {
  if (daysLeft < 0) return `Đã quá hạn ${formatNumber(-daysLeft)} ngày`;
  if (daysLeft === 0) return "Hết hạn hôm nay";
  return `Còn ${formatNumber(daysLeft)} ngày`;
}
