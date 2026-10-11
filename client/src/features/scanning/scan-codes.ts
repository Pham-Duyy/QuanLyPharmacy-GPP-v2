// Ký tự điều khiển, gồm dấu phân cách GS (0x1D) giữa các trường GS1.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f]/g;

/**
 * Chuẩn hóa nội dung quét từ hộp thuốc trước khi tra danh mục. Hộp có mã GS1
 * DataMatrix (truy xuất nguồn gốc) mã hóa AI (01) + GTIN 14 số rồi tới hạn
 * dùng, số lô; danh mục lưu mã vạch EAN-13 nên lấy GTIN và bỏ số 0 đứng đầu.
 * Máy quét có thể thêm tiền tố nhận dạng như "]d2" và ký tự phân cách GS.
 */
export function productCodeFromScan(raw: string): string {
  const text = raw
    .replace(/^\][A-Za-z]\d/, "")
    .replace(CONTROL_CHARS, "")
    .trim();
  const gs1 = /^01(\d{14})(?:$|1[0157]|21)/.exec(text);
  if (!gs1) return text;
  const gtin = gs1[1]!;
  return gtin.startsWith("0") ? gtin.slice(1) : gtin;
}
