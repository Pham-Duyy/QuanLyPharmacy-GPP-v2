import { z } from "zod";
import { addDays, dateKey, vnDay } from "./dates.js";

/**
 * Kiểm tra dùng chung cho dữ liệu nhập tay (Phase 7, D28). Mỗi hàm trả về một
 * schema zod để các module dùng chung một luật và một câu báo lỗi.
 */

/**
 * Số lượng tối đa trên một dòng chứng từ, theo đơn vị đã chọn. Nhân với hệ số
 * quy đổi lớn nhất (MAX_CONVERSION) vẫn nằm trong cột số nguyên 32 bit của CSDL.
 */
export const MAX_LINE_QUANTITY = 100_000;
/** Hệ số quy đổi đơn vị lớn nhất (ví dụ thùng 10.000 viên). */
export const MAX_CONVERSION = 10_000;
/** Số tiền tối đa một lần nhập: 1.000 tỷ đồng, đủ cho mọi chứng từ của nhà thuốc. */
export const MAX_MONEY = 1_000_000_000_000;
/** Hạn dùng và ngày sản xuất xa quá 10 năm gần như luôn là gõ nhầm năm. */
export const MAX_SHELF_YEARS = 10;

/**
 * Chuẩn hóa số điện thoại Việt Nam: bỏ khoảng trắng, dấu chấm, gạch, ngoặc;
 * đầu số +84/84 đổi về 0. Trả về null khi không phải số hợp lệ.
 * Di động 10 số (0xxxxxxxxx), máy bàn 11 số (02xxxxxxxxx).
 */
export function normalizeVnPhone(raw: string): string | null {
  let digits = raw.replace(/[\s.\-()]/g, "");
  if (digits.startsWith("+84")) digits = `0${digits.slice(3)}`;
  else if (/^84\d{9,10}$/.test(digits)) digits = `0${digits.slice(2)}`;
  // Excel đọc số điện thoại thành số và bỏ mất số 0 đầu.
  else if (/^[35789]\d{8}$/.test(digits) || /^2\d{9}$/.test(digits)) digits = `0${digits}`;
  if (/^0[35789]\d{8}$/.test(digits)) return digits;
  if (/^02\d{9}$/.test(digits)) return digits;
  return null;
}

const PHONE_MESSAGE = "Số điện thoại không hợp lệ (di động 10 số, máy bàn 11 số, bắt đầu bằng 0)";

/** Số điện thoại tùy chọn: chuỗi rỗng coi như không nhập; có nhập thì phải đúng và được chuẩn hóa. */
export function optionalPhone() {
  return z
    .string()
    .trim()
    .max(20, PHONE_MESSAGE)
    .nullish()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      if (value === null || value === "") return null;
      const phone = normalizeVnPhone(value);
      if (!phone) {
        ctx.addIssue({ code: "custom", message: PHONE_MESSAGE });
        return z.NEVER;
      }
      return phone;
    });
}

/** Mã số thuế: 10 số, chi nhánh thêm "-" và 3 số. Chuỗi rỗng coi như không nhập. */
export function optionalTaxCode() {
  return z
    .string()
    .trim()
    .nullish()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      if (value === null || value === "") return null;
      if (!/^\d{10}(-\d{3})?$/.test(value)) {
        ctx.addIssue({
          code: "custom",
          message: "Mã số thuế gồm 10 số, chi nhánh thêm gạch ngang và 3 số (0101234567-001)",
        });
        return z.NEVER;
      }
      return value;
    });
}

/** Thuế suất GTGT dùng cho thuốc và hàng hóa nhà thuốc: 0 (không chịu thuế), 5, 8, 10 %. */
export const VAT_RATES = [0, 5, 8, 10] as const;

export function vatRate() {
  return z.coerce
    .number("Thuế suất phải là số")
    .refine((value) => (VAT_RATES as readonly number[]).includes(value), {
      message: `Thuế suất GTGT chỉ nhận ${VAT_RATES.join(", ")} %`,
    });
}

/** Mã vạch: chữ, số, gạch ngang; 6–50 ký tự. */
export const barcodeSchema = z
  .string()
  .trim()
  .min(6, "Mã vạch tối thiểu 6 ký tự")
  .max(50, "Mã vạch tối đa 50 ký tự")
  .regex(/^[A-Za-z0-9-]+$/, "Mã vạch chỉ gồm chữ, số và gạch ngang");

/** Số tiền nguyên đồng, không âm, không quá MAX_MONEY. */
export function money(label = "Số tiền") {
  return z.coerce
    .number(`${label} phải là số`)
    .int(`${label} phải là số nguyên đồng`)
    .min(0, `${label} không được âm`)
    .max(MAX_MONEY, `${label} quá lớn`);
}

/** Số lượng nguyên dương trên một dòng chứng từ. */
export function lineQuantity(label = "Số lượng") {
  return z.coerce
    .number(`${label} phải là số`)
    .int(`${label} phải là số nguyên`)
    .positive(`${label} phải lớn hơn 0`)
    .max(MAX_LINE_QUANTITY, `${label} tối đa ${MAX_LINE_QUANTITY.toLocaleString("vi-VN")}`);
}

/** Ngày giờ không ở tương lai (cho phép lệch đồng hồ máy 5 phút). */
export function notFuture(label: string) {
  return z.coerce
    .date(`${label} không hợp lệ`)
    .refine(
      (value) => value.getTime() <= Date.now() + 5 * 60_000,
      `${label} không được ở tương lai`,
    );
}

/** Ngày (theo giờ Việt Nam) không sau hôm nay. */
export function notFutureDay(label: string) {
  return z.coerce
    .date(`${label} không hợp lệ`)
    .refine((value) => dateKey(value) <= vnDay(), `${label} không được ở tương lai`);
}

/** Ngày không xa hơn `years` năm về trước so với hôm nay — chặn gõ nhầm năm. */
export function withinYearsBack(value: Date, years = MAX_SHELF_YEARS): boolean {
  return dateKey(value) >= dateKey(addDays(new Date(`${vnDay()}T00:00:00Z`), -366 * years));
}

/** Ngày không xa hơn `years` năm tới. */
export function withinYearsAhead(value: Date, years = MAX_SHELF_YEARS): boolean {
  return dateKey(value) <= dateKey(addDays(new Date(`${vnDay()}T00:00:00Z`), 366 * years));
}
