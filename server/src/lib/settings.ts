import { prisma } from "../db/prisma.js";

/**
 * Giá trị mặc định khi cài đặt chưa có trong CSDL. Phải khớp với
 * `prisma/seed.ts`, để CSDL test chưa seed cài đặt vẫn chạy đúng luật.
 *
 * Ba giá trị có dấu (*) cần đối chiếu văn bản pháp lý trước khi vận hành
 * thật, xem contract §24.
 */
const DEFAULTS = {
  minRemainingShelfLifeDays: 0, // (*) P11
  nearExpiryWarningDays: 30,
  prescriptionValidityDays: 5, // (*) P14
  returnWindowDays: 7,
  invoiceVoidWindow: "SAME_BUSINESS_DAY",
  discountLimitPercent: { sales_staff: 5, pharmacist: 10 } as Record<string, number>,
  storageLogPerDay: 2,
} as const;

export type SettingKey = keyof typeof DEFAULTS;

/**
 * Đọc một cài đặt. Cửa hàng có giá trị riêng thì dùng giá trị đó, không có
 * thì lấy giá trị chung toàn chuỗi, vẫn không có thì dùng mặc định ở trên.
 */
export async function getSetting<K extends SettingKey>(
  key: K,
  storeId: string | null,
): Promise<(typeof DEFAULTS)[K]> {
  const rows = await prisma.setting.findMany({
    where: {
      key,
      ...(storeId ? { OR: [{ storeId }, { storeId: null }] } : { storeId: null }),
    },
  });

  const row = rows.find((item) => item.storeId !== null) ?? rows[0];
  if (row === undefined || row.value === null) return DEFAULTS[key];

  return row.value as (typeof DEFAULTS)[K];
}

/** Ngày làm việc hiện tại theo giờ Việt Nam, dùng cho cột `date` của chứng từ. */
export function businessDateNow(at: Date = new Date()): Date {
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(at);
  return new Date(`${day}T00:00:00.000Z`);
}
