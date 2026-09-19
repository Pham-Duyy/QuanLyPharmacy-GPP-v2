/**
 * Đơn nháp ở quầy: giữ tạm giỏ hàng để phục vụ khách kế tiếp rồi mở lại.
 * Hệ thống chưa có hóa đơn nháp phía máy chủ, nên nháp chỉ lưu trên máy
 * này, theo từng cửa hàng; không trừ tồn, không giữ giá — mở lại thì giá,
 * tồn và kiểm tra an toàn đều tính lại từ đầu.
 */
export type SaleDraft = {
  id: string;
  savedAt: string;
  customer: { id: string; fullName: string | null; phone: string | null } | null;
  prescriptionId: string | null;
  lines: Array<{ productId: string; productName: string; unitId: string; quantity: number }>;
  discount: { type: "PERCENT" | "AMOUNT"; value: number; reason: string };
};

const MAX_DRAFTS = 10;

function key(storeId: string): string {
  return `gpp.pos.drafts.${storeId}`;
}

export function readDrafts(storeId: string | null): SaleDraft[] {
  if (!storeId) return [];
  try {
    const raw = window.localStorage.getItem(key(storeId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as SaleDraft[]).filter((item) => item && Array.isArray(item.lines)) : [];
  } catch {
    return [];
  }
}

/** Trả về danh sách mới; ném lỗi nếu trình duyệt không cho lưu. */
export function writeDrafts(storeId: string, drafts: SaleDraft[]): SaleDraft[] {
  const trimmed = drafts.slice(0, MAX_DRAFTS);
  window.localStorage.setItem(key(storeId), JSON.stringify(trimmed));
  return trimmed;
}

export const MAX_SALE_DRAFTS = MAX_DRAFTS;
