import { packBreakdown, type PackUnit } from "./packs.js";

/**
 * Dòng phụ quy đổi số lượng sang đơn vị lớn ("= 66 Hộp 1 Vỉ"), đặt dưới số
 * theo đơn vị cơ bản. Không có gì để quy đổi thì không hiện gì.
 */
export function PackHint({
  quantity,
  item,
  block = false,
}: {
  quantity: number;
  item: { packUnits: readonly PackUnit[]; baseUnitName: string | null };
  /** Đứng riêng một dòng ngoài ô bảng (khung chi tiết). */
  block?: boolean;
}) {
  const text = packBreakdown(quantity, item.packUnits, item.baseUnitName ?? "");
  if (!text) return null;
  return block ? <div className="muted">= {text}</div> : <span className="cell-sub">= {text}</span>;
}
