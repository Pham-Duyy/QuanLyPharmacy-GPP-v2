import type { FormRule as Rule } from "antd";

/**
 * Luật kiểm tra dùng chung cho form, khớp với máy chủ (server/src/lib/validators.ts,
 * Phase 7 D28). Máy chủ vẫn kiểm tra lại; form chỉ báo lỗi sớm.
 */

/** Chuẩn hóa số điện thoại Việt Nam; null khi không hợp lệ. */
export function normalizeVnPhone(raw: string): string | null {
  let digits = raw.replace(/[\s.\-()]/g, "");
  if (digits.startsWith("+84")) digits = `0${digits.slice(3)}`;
  else if (/^84\d{9,10}$/.test(digits)) digits = `0${digits.slice(2)}`;
  if (/^0[35789]\d{8}$/.test(digits)) return digits;
  if (/^02\d{9}$/.test(digits)) return digits;
  return null;
}

export const PHONE_MESSAGE = "Số điện thoại không hợp lệ (di động 10 số, máy bàn 11 số)";

/** Có nhập thì phải là số điện thoại Việt Nam hợp lệ. */
export const phoneRule: Rule = {
  validator: (_, value?: string | null) =>
    !value?.trim() || normalizeVnPhone(value)
      ? Promise.resolve()
      : Promise.reject(new Error(PHONE_MESSAGE)),
};

/** Có nhập thì phải là mã số thuế 10 số (chi nhánh thêm -3 số). */
export const taxCodeRule: Rule = {
  pattern: /^\s*\d{10}(-\d{3})?\s*$/,
  message: "Mã số thuế gồm 10 số, chi nhánh thêm gạch ngang và 3 số",
};

/** Thuế suất GTGT cho phép, giống máy chủ. */
export const VAT_OPTIONS = [0, 5, 8, 10].map((value) => ({
  value,
  label: value === 0 ? "0 % (không chịu thuế)" : `${value} %`,
}));
