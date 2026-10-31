import { looksLikeXlsx, readWorkbook } from "./excel.js";
import { parseCsv } from "./parse.js";
import type { AnalysisSource, Dataset } from "./types.js";

/** Excel lưu "CSV" kiểu cũ bằng bảng mã Windows; UTF-8 lỗi thì đọc lại theo windows-1258. */
function decodeCsv(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1258").decode(buffer);
  }
}

/**
 * Đọc tệp người dùng tải lên (.xlsx hoặc CSV) thành bảng dữ liệu. Dùng chung cho
 * `/analytics/file` và tệp đính kèm trong Trợ lý AI (bước 6.6).
 */
export async function readUpload(
  buffer: Buffer,
  name: string,
  sheet?: string,
): Promise<{ dataset: Dataset; source: AnalysisSource }> {
  if (looksLikeXlsx(buffer, name)) return readWorkbook(buffer, name, sheet);
  return {
    dataset: parseCsv(decodeCsv(buffer), name),
    source: { kind: "csv", sheets: [], sheet: null, notes: [] },
  };
}
