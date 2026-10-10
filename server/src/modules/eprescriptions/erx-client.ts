import { env } from "../../config/env.js";

/**
 * Gọi Hệ thống đơn thuốc quốc gia theo tài liệu kết nối ban hành kèm Quyết
 * định 808/QĐ-BYT:
 *
 *   - mục VIII  GET  /api/v1/thong-tin-don-thuoc/{ma_don_thuoc}  — nhà thuốc lấy đơn;
 *   - mục IX    POST /api/v1/cap-nhat-don-thuoc                  — báo số lượng đã bán.
 *
 * Xác thực bằng header `app-name` / `app-key` cấp cho đơn vị làm phần mềm.
 *
 * Tài liệu ghi gốc của hai API này là `www.donthuocquocgia.vn` nhưng các API
 * phía cơ sở khám chữa bệnh lại dùng `api.donthuocquocgia.vn` — chưa rõ, xem
 * contract §12.1. Gốc mặc định theo đúng mục VIII/IX; đặt EPRESCRIPTION_BASE_URL
 * khi được đơn vị vận hành chỉ định khác.
 */

const DEFAULT_ROOT = "https://www.donthuocquocgia.vn";
const REQUEST_TIMEOUT_MS = 15_000;

export function erxRoot(): string {
  return process.env["EPRESCRIPTION_BASE_URL"] ?? env.EPRESCRIPTION_BASE_URL ?? DEFAULT_ROOT;
}

/** Lỗi khi gọi hệ thống quốc gia. `transient` = nên thử lại sau (mạng, 5xx). */
export class ErxError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

/** Một dòng thuốc trên đơn (mục VII, thong_tin_don_thuoc). */
export type NationalDrugItem = {
  ma_thuoc?: string;
  biet_duoc?: string;
  ten_thuoc?: string;
  don_vi_tinh?: string;
  so_luong?: number | string;
  cach_dung?: string;
};

/** Dữ liệu trả về của API lấy đơn (mục VIII.4). */
export type NationalPrescription = {
  ma_don_thuoc: string;
  ho_ten_benh_nhan?: string;
  ngay_sinh_benh_nhan?: string;
  loai_don_thuoc?: string;
  chan_doan?: unknown;
  loi_dan?: string;
  luu_y?: string;
  ten_bac_si?: string;
  ten_co_so_kham_chua_benh?: string;
  ngay_gio_ke_don?: string;
  thong_tin_don_thuoc?: NationalDrugItem[];
  [key: string]: unknown;
};

/** Một dòng báo đã bán (mục IX.3). */
export type DispensedItem = {
  ma_thuoc_da_ke_don: string;
  ma_thuoc: string;
  biet_duoc: string;
  ten_thuoc: string;
  don_vi_tinh: string;
  so_luong: number;
  so_luong_ban: number;
  cach_dung: string;
};

export type DispensePayload = {
  ma_don_thuoc: string;
  thong_tin_thuoc: DispensedItem[];
  ma_dinh_danh_co_so_cung_ung_thuoc: string;
  ten_co_so_cung_ung_thuoc: string;
  so_dien_thoai_co_so_cung_ung_thuoc: string;
  dia_chi_co_so_cung_ung_thuoc: string;
  ma_hoa_don: string;
};

/** Danh sách lỗi trả về (`danh_sach_cac_loi`) thành một câu. */
function errorText(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const list = (body as Record<string, unknown>)["danh_sach_cac_loi"];
    if (Array.isArray(list) && list.length > 0) return list.map(String).join("; ");
    if (typeof list === "string" && list) return list;
  }
  return fallback;
}

export class ErxClient {
  constructor(
    private readonly appName: string,
    private readonly appKey: string,
    private readonly root = erxRoot(),
  ) {}

  private async call(path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await fetch(`${this.root}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          "app-name": this.appName,
          "app-key": this.appKey,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ErxError(
        `Không kết nối được Hệ thống đơn thuốc quốc gia: ${error instanceof Error ? error.message : String(error)}`,
        null,
        true,
      );
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  }

  /** Lấy đơn theo mã. Không có đơn: ErxError 404 (không thử lại). */
  async getPrescription(code: string): Promise<NationalPrescription> {
    const { status, body } = await this.call(
      `/api/v1/thong-tin-don-thuoc/${encodeURIComponent(code)}`,
      { method: "GET" },
    );
    if (status === 200 && body && typeof body === "object") return body as NationalPrescription;
    if (status === 404) throw new ErxError(errorText(body, "Không tìm thấy đơn thuốc"), 404, false);
    if (status === 401 || status === 403) {
      throw new ErxError("Hệ thống đơn thuốc quốc gia từ chối app-name/app-key", status, false);
    }
    throw new ErxError(
      errorText(body, `Hệ thống đơn thuốc quốc gia trả lỗi ${status}`),
      status,
      status >= 500,
    );
  }

  /** Báo số lượng đã bán. 404/422: dữ liệu bị từ chối, không tự thử lại. */
  async reportDispensed(payload: DispensePayload): Promise<void> {
    const { status, body } = await this.call("/api/v1/cap-nhat-don-thuoc", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (status === 200) return;
    if (status === 401 || status === 403) {
      throw new ErxError("Hệ thống đơn thuốc quốc gia từ chối app-name/app-key", status, false);
    }
    throw new ErxError(
      errorText(body, `Hệ thống đơn thuốc quốc gia trả lỗi ${status}`),
      status,
      status >= 500 || status === 429,
    );
  }
}

/**
 * Mã đơn thuốc điện tử (mục VII.1): 14 ký tự — 5 ký tự mã cơ sở khám chữa
 * bệnh, 7 ký tự chữ hoặc số, rồi `-c` (thường), `-n` (gây nghiện), `-h` (hướng
 * thần), `-y` (y học cổ truyền).
 */
export const PRESCRIPTION_CODE = /^[0-9a-z]{12}-[cnhy]$/i;

export function normalizeCode(raw: string): string {
  return raw.trim().replace(/\s+/g, "");
}
