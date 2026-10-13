/** Ngày theo giờ Việt Nam dạng YYYY-MM-DD (contract M10: múi giờ Asia/Ho_Chi_Minh). */
export function vnDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(at);
}

/**
 * Ngày YYYY-MM-DD của một giá trị cột `date` (lưu ở nửa đêm UTC). So với
 * `vnDay()` thì đúng theo ngày Việt Nam: so thẳng với `Date.now()` sai lệch
 * từ 0 giờ tới 7 giờ sáng, khi ngày UTC còn là hôm trước.
 */
export function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Cộng hoặc trừ ngày trên mốc nửa đêm UTC — cách các cột `date` được lưu. */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
