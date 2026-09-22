import { AxiosError } from "axios";
import { getErrorMessage, http } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";
import type { Dayjs } from "dayjs";

export type ImportType = "products" | "suppliers" | "customers" | "opening-balance" | "receipt-lines";
export type ExportType = "products" | "suppliers" | "customers" | "inventory" | "invoices" | "goods-receipts" | "rx-sales";

export type ImportIssue = { row: number; column?: string; message: string };

export type ImportPreview = {
  type: ImportType;
  fileName: string;
  totalRows: number;
  validRows: number;
  creates: number;
  updates: number;
  missingColumns: string[];
  issueCount: number;
  issues: ImportIssue[];
  notes: string[];
  sample?: Array<{ row: number; action: "create" | "update"; label: string }>;
};

export type ImportResult = ImportPreview & { created: number; updated: number; documentId?: string };

/** Dòng phiếu nhập đã khớp sản phẩm (chỉ có ở loại receipt-lines). */
export type ReceiptLine = {
  row: number;
  productId: string;
  productCode: string;
  productName: string;
  unitId: string;
  unitName: string;
  conversionToBase: number;
  quantity: number;
  unitCost: number;
  batchNumber: string;
  manufactureDate: string | null;
  expiryDate: string;
};

export type ExcelCatalog = {
  imports: Array<{ type: ImportType; title: string; needsStore: boolean; guide: string[] }>;
  exports: Array<{ type: ExportType; title: string; needsStore: boolean; dated: boolean; audited: boolean }>;
};

/** Lỗi của request dạng blob cũng là blob: đọc lại JSON để lấy thông điệp tiếng Việt. */
async function blobErrorMessage(error: unknown, fallback: string): Promise<string> {
  if (error instanceof AxiosError && error.response?.data instanceof Blob) {
    try {
      const payload = JSON.parse(await error.response.data.text()) as { error?: { message?: string } };
      if (payload.error?.message) return payload.error.message;
    } catch {
      // Không phải JSON: dùng thông điệp mặc định.
    }
  }
  return getErrorMessage(error, fallback);
}

function fileNameFrom(header: unknown, fallback: string): string {
  const value = typeof header === "string" ? header : "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded) return decodeURIComponent(encoded);
  return /filename="([^"]+)"/i.exec(value)?.[1] ?? fallback;
}

/** Tải tệp từ API về máy; lỗi được ném lại với thông điệp đã đọc. */
export async function downloadFile(path: string, params: Record<string, string | undefined> = {}, fallbackName = "du-lieu.xlsx"): Promise<void> {
  try {
    const response = await http.get<Blob>(path, { params, responseType: "blob" });
    const url = URL.createObjectURL(response.data);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileNameFrom(response.headers["content-disposition"], fallbackName);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    throw new Error(await blobErrorMessage(error, "Không tải được tệp"));
  }
}

export const downloadTemplate = (type: ImportType) => downloadFile(`/excel/templates/${type}`, {}, `mau-nhap-${type}.xlsx`);

export const downloadExport = (type: ExportType, range?: { from?: string; to?: string }) => downloadFile(`/excel/exports/${type}`, { from: range?.from, to: range?.to }, `${type}.xlsx`);

export async function sendImport<T extends ImportPreview>(type: ImportType, file: File, mode: "preview" | "commit"): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  const response = await http.post<Envelope<T>>(`/excel/imports/${type}`, form, { params: { mode } });
  return response.data.data;
}

export async function fetchCatalog(): Promise<ExcelCatalog> {
  return (await http.get<Envelope<ExcelCatalog>>("/excel/catalog")).data.data;
}

/** Khoảng ngày của bộ lọc trên trang → tham số from/to (YYYY-MM-DD). */
export function rangeParams(range: [Dayjs, Dayjs] | null | undefined): { from?: string; to?: string } {
  return range ? { from: range[0].format("YYYY-MM-DD"), to: range[1].format("YYYY-MM-DD") } : {};
}
