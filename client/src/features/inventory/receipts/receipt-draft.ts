import dayjs from "dayjs";
import type { GoodsReceiptLine, SupplierListItem } from "../../../api/types.js";
import { daysUntil, vnDateKey } from "../../../ui/format.js";

/** Một dòng đang sửa trong phiếu nhập nháp. */
export type DraftLine = {
  key: string;
  productId: string;
  productCode: string;
  productName: string;
  unitId: string;
  /** Đơn vị lấy từ dòng đã lưu, dùng tạm tới khi tải xong chi tiết sản phẩm. */
  fallbackUnit: { id: string; name: string; conversionToBase: number };
  quantity: number;
  unitCost: number;
  batchNumber: string;
  manufactureDate: string;
  expiryDate: string;
  /** Dòng tách thêm cho cùng sản phẩm nhưng khác lô. */
  extraBatch: boolean;
};

export type Issue = { level: "error" | "warning"; text: string };

export type ReceiptCheck = { label: string; state: "ok" | "error" | "warning" };

export const DATE_FORMAT = "DD/MM/YYYY";
export const NEAR_EXPIRY_DAYS = 90;
/** Khớp MIN_SHELF_LIFE_DAYS ở backend: HSD cách NSX ít hơn mức này là nhập nhầm. */
export const MIN_SHELF_LIFE_DAYS = 30;
/** Hầu hết thuốc có tuổi thọ 12–60 tháng; ngoài khoảng này chỉ nhắc đối chiếu lại bao bì. */
const SHORT_SHELF_LIFE_DAYS = 180;
const LONG_SHELF_LIFE_DAYS = 5 * 365 + 1;

export function shelfLifeDays(line: {
  manufactureDate: string;
  expiryDate: string;
}): number | null {
  return line.manufactureDate && line.expiryDate
    ? dayjs(line.expiryDate).diff(dayjs(line.manufactureDate), "day")
    : null;
}

export function toDateKey(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

/** Nhận ngày dạng dd/mm/yyyy hoặc yyyy-mm-dd từ file CSV. */
export function parseCsvDate(value: string): string {
  const text = value.trim();
  const vn = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (vn) return `${vn[3]}-${vn[2]!.padStart(2, "0")}-${vn[1]!.padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

/** Đánh dấu "Lô bổ sung" cho dòng có sản phẩm đã xuất hiện ở dòng phía trên. */
export function markExtraBatches<T extends { productId: string; extraBatch: boolean }>(
  lines: T[],
): T[] {
  return lines.map((line, index) => ({
    ...line,
    extraBatch: lines.slice(0, index).some((previous) => previous.productId === line.productId),
  }));
}

export function toDraftLines(lines: GoodsReceiptLine[]): DraftLine[] {
  return markExtraBatches(
    lines.map((line) => ({
      key: line.id,
      productId: line.productId,
      productCode: line.productCode,
      productName: line.productName,
      unitId: line.unitId,
      fallbackUnit: {
        id: line.unitId,
        name: line.unitName,
        conversionToBase: line.conversionToBase,
      },
      quantity: line.quantity,
      unitCost: line.unitCost,
      batchNumber: line.batchNumber,
      manufactureDate: toDateKey(line.manufactureDate),
      expiryDate: toDateKey(line.expiryDate),
      extraBatch: false,
    })),
  );
}

/** Khóa các dòng trùng sản phẩm, đơn vị và số lô (không phân biệt hoa thường). */
export function duplicateLineKeys(lines: DraftLine[]): Set<string> {
  const keyOf = (line: DraftLine) =>
    `${line.productId}|${line.unitId}|${line.batchNumber.trim().toUpperCase()}`;
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(keyOf(line), (counts.get(keyOf(line)) ?? 0) + 1);
  return new Set(
    lines
      .filter((line) => line.batchNumber.trim() && (counts.get(keyOf(line)) ?? 0) > 1)
      .map((line) => line.key),
  );
}

/** Kiểm tra từng dòng như người nhập hàng tự soát trước khi lưu. */
export function lineIssues(line: DraftLine, duplicate: boolean): Issue[] {
  const issues: Issue[] = [];
  const today = vnDateKey();
  if (duplicate)
    issues.push({ level: "error", text: "Trùng sản phẩm, đơn vị và số lô với dòng khác" });
  if (!line.batchNumber.trim()) issues.push({ level: "error", text: "Thiếu số lô" });
  if (line.quantity <= 0) issues.push({ level: "error", text: "Số lượng phải lớn hơn 0" });
  if (!line.expiryDate) issues.push({ level: "error", text: "Thiếu hạn dùng" });
  else if (line.expiryDate <= today) issues.push({ level: "error", text: "Hạn dùng đã qua" });
  else if (daysUntil(line.expiryDate) <= NEAR_EXPIRY_DAYS)
    issues.push({ level: "warning", text: `Hạn dùng chỉ còn ${daysUntil(line.expiryDate)} ngày` });
  if (line.manufactureDate && line.manufactureDate > today)
    issues.push({ level: "error", text: "Ngày sản xuất ở tương lai" });
  const shelfLife = shelfLifeDays(line);
  if (shelfLife !== null && shelfLife < MIN_SHELF_LIFE_DAYS) {
    issues.push({
      level: "error",
      text:
        shelfLife <= 0
          ? "Ngày sản xuất phải trước hạn dùng"
          : `Hạn dùng chỉ cách ngày sản xuất ${shelfLife} ngày — gần như chắc chắn nhập nhầm`,
    });
  } else if (shelfLife !== null && shelfLife < SHORT_SHELF_LIFE_DAYS) {
    issues.push({
      level: "warning",
      text: `Tuổi thọ chỉ khoảng ${Math.round(shelfLife / 30)} tháng — đối chiếu lại NSX/HSD trên bao bì`,
    });
  } else if (shelfLife !== null && shelfLife > LONG_SHELF_LIFE_DAYS) {
    issues.push({
      level: "warning",
      text: `Tuổi thọ hơn 5 năm (${(shelfLife / 365).toFixed(1)} năm) — đối chiếu lại NSX/HSD`,
    });
  }
  if (line.unitCost === 0) issues.push({ level: "warning", text: "Đơn giá bằng 0 (hàng tặng?)" });
  return issues;
}

/** Danh sách kiểm tra cả phiếu trước khi lưu; còn mục "error" thì không cho lưu. */
export function receiptChecks(input: {
  supplier: SupplierListItem | null;
  lines: DraftLine[];
  issuesByLine: Map<string, Issue[]>;
  receivedAt: string;
  supplierInvoiceDate: string;
  goodsAmount: number;
  discountAmount: number;
}): ReceiptCheck[] {
  const { supplier, lines, issuesByLine, receivedAt, supplierInvoiceDate } = input;
  const hasLevel = (level: Issue["level"]) =>
    lines.filter((line) => issuesByLine.get(line.key)?.some((issue) => issue.level === level))
      .length;
  const errorLines = hasLevel("error");
  const warningLines = hasLevel("warning");
  const completeLines = lines.filter((line) => line.batchNumber.trim() && line.expiryDate).length;
  const today = vnDateKey();
  const invoiceGapDays = supplierInvoiceDate
    ? Math.abs(dayjs(supplierInvoiceDate).diff(dayjs(receivedAt), "day"))
    : 0;

  const checks: ReceiptCheck[] = [
    {
      label: supplier ? "Đã chọn nhà cung cấp" : "Chưa chọn nhà cung cấp",
      state: supplier ? "ok" : "error",
    },
    {
      label:
        lines.length === 0
          ? "Chưa có dòng hàng"
          : `${completeLines}/${lines.length} dòng đủ số lô và hạn dùng`,
      state: lines.length > 0 && completeLines === lines.length ? "ok" : "error",
    },
  ];
  if (errorLines > 0)
    checks.push({
      label: `${errorLines} dòng còn lỗi — di chuột vào biểu tượng đỏ để xem`,
      state: "error",
    });
  if (warningLines > 0)
    checks.push({
      label: `${warningLines} dòng cần lưu ý (cận hạn, tuổi thọ bất thường, đơn giá 0)`,
      state: "warning",
    });
  if (input.discountAmount > input.goodsAmount)
    checks.push({ label: "Chiết khấu lớn hơn tổng tiền hàng", state: "error" });
  if (receivedAt > today || supplierInvoiceDate > today)
    checks.push({ label: "Ngày nhận hàng / ngày hóa đơn ở tương lai", state: "error" });
  if (invoiceGapDays > 30)
    checks.push({
      label: `Ngày hóa đơn và ngày nhận lệch ${invoiceGapDays} ngày — kiểm tra lại`,
      state: "warning",
    });
  if (supplier && !supplier.licenseNumber)
    checks.push({ label: "Nhà cung cấp chưa lưu số giấy phép kinh doanh dược", state: "warning" });
  return checks;
}
