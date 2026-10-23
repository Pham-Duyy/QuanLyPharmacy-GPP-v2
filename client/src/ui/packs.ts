import { formatNumber } from "./format.js";

/** Đơn vị lớn đang dùng của một thuốc (hộp, vỉ…), máy chủ trả sẵn lớn trước. */
export type PackUnit = { name: string; conversionToBase: number };

/**
 * Quy đổi số lượng theo đơn vị cơ bản sang đơn vị lớn để đối chiếu hàng trên
 * kệ: 931 viên (Hộp = 14, Vỉ = 7) → "66 Hộp 1 Vỉ". Thuốc không có đơn vị lớn,
 * hoặc chưa đủ một đơn vị lớn nhỏ nhất, thì không có gì để quy đổi (null).
 * Số âm quy đổi theo trị tuyệt đối rồi thêm dấu trừ.
 */
export function packBreakdown(
  quantity: number,
  packUnits: readonly PackUnit[],
  baseUnitName: string,
): string | null {
  const packs = [...packUnits].sort((a, b) => b.conversionToBase - a.conversionToBase);
  const smallest = packs.at(-1);
  let left = Math.abs(quantity);
  if (!smallest || left < smallest.conversionToBase) return null;

  const parts: string[] = [];
  for (const unit of packs) {
    const count = Math.floor(left / unit.conversionToBase);
    if (count > 0) parts.push(`${formatNumber(count)} ${unit.name}`);
    left -= count * unit.conversionToBase;
  }
  if (left > 0) parts.push(`${formatNumber(left)} ${baseUnitName}`);
  return `${quantity < 0 ? "−" : ""}${parts.join(" ")}`;
}
