import { z, type ZodType } from "zod";
import { AppError } from "./app-error.js";

/**
 * Câu báo lỗi mặc định bằng tiếng Việt cho các luật chưa ghi câu riêng
 * (Phase 7, D28). Trường hợp hay gặp viết lại cho dễ hiểu; còn lại dùng bản
 * tiếng Việt có sẵn của zod.
 */
const vi = z.locales.vi();
z.config({
  ...vi,
  customError: (issue) => {
    const count = (value: unknown) =>
      typeof value === "number" || typeof value === "bigint"
        ? Number(value).toLocaleString("vi-VN")
        : String(value);
    switch (issue.code) {
      case "invalid_type":
        if (issue.input === undefined || issue.input === null) return "Thiếu giá trị";
        if (issue.expected === "int") return "Phải là số nguyên";
        if (issue.expected === "number") return "Phải là số";
        if (issue.expected === "date") return "Ngày không hợp lệ";
        return undefined;
      case "too_big":
        if (issue.origin === "number" || issue.origin === "int")
          return `Tối đa ${count(issue.maximum)}`;
        if (issue.origin === "string") return `Tối đa ${count(issue.maximum)} ký tự`;
        if (issue.origin === "array") return `Tối đa ${count(issue.maximum)} dòng`;
        return undefined;
      case "too_small":
        if (issue.origin === "number" || issue.origin === "int") {
          return issue.inclusive
            ? `Tối thiểu ${count(issue.minimum)}`
            : `Phải lớn hơn ${count(issue.minimum)}`;
        }
        if (issue.origin === "string") {
          return Number(issue.minimum) <= 1
            ? "Không được để trống"
            : `Tối thiểu ${count(issue.minimum)} ký tự`;
        }
        if (issue.origin === "array") return `Phải có ít nhất ${count(issue.minimum)} dòng`;
        return undefined;
      case "invalid_value":
        return "Giá trị không nằm trong danh sách cho phép";
      default:
        return undefined;
    }
  },
});

/**
 * Kiểm tra dữ liệu vào bằng zod và dịch lỗi sang khung response chuẩn
 * (contract §2.6, mã VALIDATION_ERROR).
 */
export function parseOrThrow<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const details = result.error.issues.map((issue) => ({
    field: issue.path.join(".") || "(gốc)",
    message: issue.message,
  }));

  throw new AppError(422, "VALIDATION_ERROR", "Dữ liệu gửi lên không hợp lệ", details);
}
