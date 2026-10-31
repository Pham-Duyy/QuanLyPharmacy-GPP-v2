/**
 * Kiểu dữ liệu và định dạng số dùng chung cho biểu đồ (Bảng điều hành, biểu đồ trong câu trả lời
 * của Trợ lý AI). Trang "Trợ lý phân tích" cũ đã gộp vào Trợ lý AI ở bước 6.6.
 */
export type ValueFormat = "currency" | "number" | "percent";

export type SeriesLine = {
  name: string;
  values: Array<number | null>;
  /** Nét đứt (ví dụ đường dự báo). */
  dashed?: boolean;
  /** Màu riêng; bỏ trống thì lấy theo thứ tự trong bảng màu. */
  color?: string;
};

/** Số gọn cho trục và nhãn: 1,2 tỷ, 350 triệu; giống cách máy chủ viết nhận xét. */
export function formatCompact(value: number, format: ValueFormat): string {
  const abs = Math.abs(value);
  const unit = format === "currency" ? " đ" : "";
  if (format === "percent")
    return `${value.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
  if (abs >= 1e9)
    return `${(value / 1e9).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} tỷ${unit}`;
  if (abs >= 1e6)
    return `${(value / 1e6).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} triệu${unit}`;
  if (abs >= 1e4 && format === "currency")
    return `${(value / 1e3).toLocaleString("vi-VN", { maximumFractionDigits: 0 })} nghìn${unit}`;
  return `${value.toLocaleString("vi-VN", { maximumFractionDigits: 2 })}${unit}`;
}

export function formatFull(value: number, format: ValueFormat): string {
  if (format === "percent")
    return `${value.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
  const text = value.toLocaleString("vi-VN", { maximumFractionDigits: 2 });
  return format === "currency" ? `${text} ₫` : text;
}

export function formatSignedPercent(value: number | null): string {
  if (value === null) return "—";
  const text = Math.abs(value).toLocaleString("vi-VN", { maximumFractionDigits: 1 });
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${text}%`;
}
