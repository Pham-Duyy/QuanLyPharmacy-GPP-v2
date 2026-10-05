import { env } from "../../config/env.js";

/**
 * Máy khách gọi API MISA meInvoice cho hóa đơn khởi tạo từ máy tính tiền.
 *
 * Theo tài liệu tích hợp tại doc.meinvoice.vn (đọc ngày 05/10/2026):
 *   - Lấy token: POST {gốc}/v3/auth/token, body { appid, taxcode, username,
 *     password }; token dùng 15 ngày, hết hạn trả ErrorCode "TokenExpiredCode".
 *   - Phát hành hóa đơn máy tính tiền: POST
 *     {gốc}/v3/code/itg/invoice-calculating/invoiceandpublish, header
 *     CompanyTaxCode, body là mảng { OrgInvoiceData, IsInvoiceCalculatingMachine }.
 *     Data trả về là CHUỖI JSON chứa [{ RefID, TransactionID, InvSeries, InvNo }].
 *   - Trạng thái: POST {gốc}/integration/invoice/status?invoiceWithCode=true
 *     &invoiceCalcu=true&inputType=2, body là mảng RefID. SendTaxStatus:
 *     0 chờ cấp mã, 1 gửi lỗi, 2 đã cấp mã, 3 bị từ chối; InvoiceCode là mã CQT.
 *
 * Những chỗ tài liệu không nói rõ (tên trường viết hoa hay thường ở phản hồi
 * trạng thái, định dạng VATRateName) được đọc mềm dẻo và PHẢI kiểm lại khi có
 * tài khoản sandbox thật.
 */

export const MISA_ROOTS = {
  SANDBOX: "https://testapi.meinvoice.vn/api",
  PRODUCTION: "https://api.meinvoice.vn/api",
} as const;

export type EInvoiceEnvironment = keyof typeof MISA_ROOTS;

export type MisaCredentials = {
  environment: EInvoiceEnvironment;
  appId: string;
  taxCode: string;
  username: string;
  password: string;
};

export class EInvoiceError extends Error {
  constructor(
    message: string,
    readonly kind: "AUTH" | "REJECTED" | "REMOTE" | "NETWORK" | "RESPONSE",
    readonly code?: string,
  ) {
    super(message);
    this.name = "EInvoiceError";
  }

  get retryable(): boolean {
    return this.kind === "REMOTE" || this.kind === "NETWORK";
  }
}

export type PublishedInvoice = {
  refId: string;
  transactionId: string;
  invSeries: string | null;
  invNo: string | null;
};

export type RemoteStatus = {
  refId: string | null;
  transactionId: string | null;
  /** Mã của cơ quan thuế; null khi chưa cấp. */
  taxAuthorityCode: string | null;
  /** 0 chờ cấp mã, 1 gửi lỗi, 2 đã cấp mã, 3 bị từ chối. */
  sendTaxStatus: number | null;
};

const REQUEST_TIMEOUT_MS = 30_000;

export function misaRoot(environment: EInvoiceEnvironment): string {
  return process.env["EINVOICE_BASE_URL"] ?? env.EINVOICE_BASE_URL ?? MISA_ROOTS[environment];
}

/** Đọc trường không phân biệt hoa thường — tài liệu MISA dùng lẫn cả hai kiểu. */
function field(source: unknown, name: string): unknown {
  if (!source || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;
  if (name in record) return record[name];
  const key = Object.keys(record).find((item) => item.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : record[key];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Data có thể là mảng hoặc chuỗi JSON của mảng. */
function arrayOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function errorMessage(body: unknown, fallback: string): string {
  const errors = field(body, "Errors");
  const list = Array.isArray(errors) ? errors.filter((item) => typeof item === "string") : [];
  const description = text(field(body, "descriptionErrorCode"));
  return [description, ...list].filter(Boolean).join("; ") || fallback;
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EInvoiceError(`Không kết nối được tới MISA meInvoice: ${reason}`, "NETWORK");
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status >= 500) {
    throw new EInvoiceError(`MISA meInvoice đang lỗi (HTTP ${response.status})`, "REMOTE");
  }
  if (response.status === 401 || response.status === 403) {
    throw new EInvoiceError("Tài khoản MISA meInvoice không hợp lệ hoặc hết hạn", "AUTH");
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (body === null) {
    throw new EInvoiceError(`Phản hồi MISA không đọc được (HTTP ${response.status})`, "RESPONSE");
  }
  return body;
}

export class MisaClient {
  private token: string | null = null;

  constructor(private readonly credentials: MisaCredentials) {}

  get root(): string {
    return misaRoot(this.credentials.environment);
  }

  async login(): Promise<string> {
    const response = await send(`${this.root}/v3/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appid: this.credentials.appId,
        taxcode: this.credentials.taxCode,
        username: this.credentials.username,
        password: this.credentials.password,
      }),
    });
    const body = await readJson(response);
    const token = text(field(body, "Data"));
    if (field(body, "Success") !== true || !token) {
      throw new EInvoiceError(
        errorMessage(body, "Sai AppID, mã số thuế, tài khoản hoặc mật khẩu MISA"),
        "AUTH",
        text(field(body, "ErrorCode")) ?? undefined,
      );
    }
    this.token = token;
    return token;
  }

  /** Gọi API có token; token hết hạn thì lấy token mới đúng một lần. */
  private async call(url: string, payload: unknown, retried = false): Promise<unknown> {
    const token = this.token ?? (await this.login());
    const response = await send(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        CompanyTaxCode: this.credentials.taxCode,
      },
      body: JSON.stringify(payload),
    });
    if ((response.status === 401 || response.status === 403) && !retried) {
      this.token = null;
      return this.call(url, payload, true);
    }
    const body = await readJson(response);
    if (field(body, "ErrorCode") === "TokenExpiredCode" && !retried) {
      this.token = null;
      return this.call(url, payload, true);
    }
    return body;
  }

  /** Phát hành một hóa đơn máy tính tiền. Lỗi dữ liệu ném REJECTED, không thử lại. */
  async publish(orgInvoiceData: Record<string, unknown>): Promise<PublishedInvoice> {
    const body = await this.call(`${this.root}/v3/code/itg/invoice-calculating/invoiceandpublish`, [
      { OrgInvoiceData: orgInvoiceData, IsInvoiceCalculatingMachine: true },
    ]);
    if (field(body, "Success") !== true) {
      throw new EInvoiceError(
        errorMessage(body, "MISA từ chối phát hành hóa đơn"),
        "REJECTED",
        text(field(body, "ErrorCode")) ?? undefined,
      );
    }
    const first = arrayOf(field(body, "Data"))[0];
    const itemError = text(field(first, "ErrorCode"));
    const transactionId = text(field(first, "TransactionID"));
    if (itemError || !transactionId) {
      throw new EInvoiceError(
        errorMessage(first, itemError ?? "MISA không trả mã tra cứu cho hóa đơn"),
        itemError ? "REJECTED" : "RESPONSE",
        itemError ?? undefined,
      );
    }
    return {
      refId: text(field(first, "RefID")) ?? String(orgInvoiceData["RefID"]),
      transactionId,
      invSeries: text(field(first, "InvSeries")),
      invNo: text(field(first, "InvNo")),
    };
  }

  /** Hỏi trạng thái cấp mã cơ quan thuế theo RefID. */
  async fetchStatuses(refIds: string[]): Promise<RemoteStatus[]> {
    if (refIds.length === 0) return [];
    const url = `${this.root}/integration/invoice/status?invoiceWithCode=true&invoiceCalcu=true&inputType=2`;
    const body = await this.call(url, refIds);
    const success = field(body, "Success");
    if (success === false) {
      throw new EInvoiceError(errorMessage(body, "Không hỏi được trạng thái hóa đơn"), "REMOTE");
    }
    return arrayOf(field(body, "Data")).map((item) => {
      const raw = field(item, "SendTaxStatus");
      return {
        refId: text(field(item, "RefID")),
        transactionId: text(field(item, "TransactionID")),
        taxAuthorityCode: text(field(item, "InvoiceCode")),
        sendTaxStatus: typeof raw === "number" ? raw : raw === undefined ? null : Number(raw),
      };
    });
  }
}
