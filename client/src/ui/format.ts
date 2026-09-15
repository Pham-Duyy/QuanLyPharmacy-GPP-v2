const VN_TIME_ZONE = "Asia/Ho_Chi_Minh";

export const numberFormat = new Intl.NumberFormat("vi-VN");

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : numberFormat.format(value);
}

export function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleDateString("vi-VN") : "—";
}

export function formatDateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" }) : "—";
}

/** Ngày hôm nay theo giờ Việt Nam, dạng yyyy-mm-dd — khớp cách máy chủ tính ngày nghiệp vụ. */
export function vnDateKey(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: VN_TIME_ZONE }).format(date);
}

/** Ngày đầu tháng hiện tại theo giờ Việt Nam, dạng yyyy-mm-dd. */
export function vnMonthStartKey(date = new Date()): string {
  return `${vnDateKey(date).slice(0, 7)}-01`;
}

/** Số ngày từ hôm nay tới một ngày (âm nghĩa là đã qua). */
export function daysUntil(value: string): number {
  return Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000);
}
