/** Ngày theo giờ Việt Nam dạng YYYY-MM-DD (contract M10: múi giờ Asia/Ho_Chi_Minh). */
export function vnDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(at);
}

/** Cộng hoặc trừ ngày trên mốc nửa đêm UTC — cách các cột `date` được lưu. */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
