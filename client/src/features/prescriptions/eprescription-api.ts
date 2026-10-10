import { http } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";

/** Mã đơn thuốc điện tử 14 ký tự (QĐ 808 mục VII.1): xxxxxyyyyyyy-c|n|h|y. */
export const ERX_CODE = /^[0-9a-z]{12}-[cnhy]$/i;

export type ImportResult = { prescriptionId: string; created: boolean; unmatched: number };

/** Lấy đơn từ Hệ thống đơn thuốc quốc gia thành đơn thuốc nháp (contract §12.1). */
export async function importEPrescription(code: string): Promise<ImportResult> {
  return (await http.post<Envelope<ImportResult>>("/eprescriptions/import", { code: code.trim() }))
    .data.data;
}
