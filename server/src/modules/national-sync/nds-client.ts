import { env } from "../../config/env.js";
import {
  drugsPageSchema,
  loginResponseSchema,
  transactionAckSchema,
  transactionStatusSchema,
  unitsPageSchema,
  type NationalDrugDto,
  type NationalUnitDto,
} from "./nds-schemas.js";

/**
 * Máy khách gọi API Hệ thống Cơ sở dữ liệu về Dược.
 *
 * Ba điểm đặc thù của API này quyết định thiết kế ở đây:
 *   1. Không có refresh token. Hết hạn thì đăng nhập lại — token giữ trong
 *      bộ nhớ, hết hạn hoặc gặp 401 thì tự lấy token mới đúng một lần.
 *   2. Có giới hạn tần suất (429). Gặp 429 phải lùi lại, không thử ngay.
 *   3. Xử lý bất đồng bộ: gửi chứng từ chỉ nhận về transaction_id, kết quả
 *      thật phải hỏi lại ở API xem trạng thái.
 */

export const NDS_ENDPOINTS = {
  SANDBOX: "https://api-sandbox.csdlduoc.com.vn/v2",
  PRODUCTION: "https://api.csdlduoc.com.vn/v2",
} as const;

export type NdsEnvironment = keyof typeof NDS_ENDPOINTS;

export type NdsCredentials = {
  environment: NdsEnvironment;
  username: string;
  password: string;
};

/** Lỗi có phân loại để bên gọi biết nên thử lại hay dừng hẳn. */
export class NdsError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "AUTH" // sai tài khoản, mật khẩu hoặc thiếu quyền
      | "RATE_LIMIT" // 429, phải lùi lại
      | "REJECTED" // 4xx do dữ liệu gửi lên không hợp lệ
      | "REMOTE" // 5xx phía hệ thống quốc gia
      | "NETWORK" // không gọi được (mạng, DNS, hết giờ)
      | "RESPONSE", // gọi được nhưng phản hồi không đúng đặc tả
    readonly status?: number,
    readonly retryAfterSeconds?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "NdsError";
  }

  /** Lỗi tạm thời: thử lại sau thì có cơ hội thành công. */
  get retryable(): boolean {
    return this.kind === "RATE_LIMIT" || this.kind === "REMOTE" || this.kind === "NETWORK";
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
/** Lấy token mới sớm hơn hạn một chút để không gửi bằng token vừa hết hạn. */
const TOKEN_SAFETY_SECONDS = 60;
const DEFAULT_TOKEN_TTL_SECONDS = 3_600;

type Token = { value: string; expiresAt: number };

/** Biến môi trường đang trỏ API sang địa chỉ khác địa chỉ chính thức. */
export function baseUrlOverride(): string | null {
  // Đọc thẳng process.env chứ không dùng bản đã chốt lúc khởi động: test và
  // máy chủ mô phỏng cần đổi địa chỉ sau khi tiến trình đã chạy. `env` vẫn
  // kiểm tra biến này lúc khởi động nên cấu hình sai vẫn bị chặn sớm.
  return process.env["NDS_BASE_URL"] ?? env.NDS_BASE_URL ?? null;
}

/**
 * Địa chỉ API thực sự đang được gọi.
 *
 * Giao diện phải hiện đúng địa chỉ này chứ không phải địa chỉ suy ra từ môi
 * trường đã chọn: đang chạy với máy chủ mô phỏng mà màn hình ghi
 * "api-sandbox.csdlduoc.com.vn" là nói sai với người dùng.
 */
export function resolveBaseUrl(environment: NdsEnvironment): string {
  return baseUrlOverride() ?? NDS_ENDPOINTS[environment];
}

function baseUrlFor(environment: NdsEnvironment): string {
  return resolveBaseUrl(environment);
}

function describe(status: number, body: string): NdsError {
  const snippet = body.slice(0, 500);
  if (status === 401 || status === 403) {
    return new NdsError(
      status === 401
        ? "Tài khoản hoặc mật khẩu liên thông không đúng, hoặc token đã hết hạn"
        : "Tài khoản không có quyền thực hiện thao tác này",
      "AUTH",
      status,
      undefined,
      snippet,
    );
  }
  if (status === 429) {
    return new NdsError("Vượt giới hạn số lần gọi API", "RATE_LIMIT", status, undefined, snippet);
  }
  if (status >= 500) {
    return new NdsError("Hệ thống CSDL Dược đang lỗi", "REMOTE", status, undefined, snippet);
  }
  return new NdsError(
    `Hệ thống CSDL Dược từ chối dữ liệu (HTTP ${status})`,
    "REJECTED",
    status,
    undefined,
    snippet,
  );
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new NdsError(`Không kết nối được tới CSDL Dược: ${reason}`, "NETWORK");
  }
}

export class NdsClient {
  private token: Token | null = null;

  constructor(private readonly credentials: NdsCredentials) {}

  get baseUrl(): string {
    return baseUrlFor(this.credentials.environment);
  }

  /**
   * Đăng nhập. Đặc tả yêu cầu form-urlencoded và mật khẩu mã hóa base64
   * (đây là mã hóa truyền tải của họ, không phải biện pháp bảo mật).
   */
  async login(): Promise<Token> {
    const body = new URLSearchParams({
      username: this.credentials.username,
      password: Buffer.from(this.credentials.password, "utf8").toString("base64"),
    });

    const response = await send(`${this.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!response.ok) throw describe(response.status, await response.text().catch(() => ""));

    const parsed = loginResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new NdsError("Phản hồi đăng nhập không đúng đặc tả", "RESPONSE", response.status);
    }

    const ttl = parsed.data.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS;
    this.token = {
      value: parsed.data.access_token,
      expiresAt: Date.now() + Math.max(0, ttl - TOKEN_SAFETY_SECONDS) * 1000,
    };
    return this.token;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    return (await this.login()).value;
  }

  /** Quên token đang giữ; lần gọi sau sẽ đăng nhập lại. */
  forgetToken(): void {
    this.token = null;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const call = async (token: string): Promise<Response> =>
      send(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });

    let response = await call(await this.accessToken());

    // 401 giữa chừng: token hết hạn sớm hơn dự kiến. Đăng nhập lại đúng MỘT
    // lần — sai mật khẩu mà thử vòng lặp là dính khóa tài khoản.
    if (response.status === 401) {
      this.forgetToken();
      response = await call((await this.login()).value);
    }

    if (!response.ok) throw describe(response.status, await response.text().catch(() => ""));

    const text = await response.text();
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new NdsError(
        "Phản hồi không phải JSON hợp lệ",
        "RESPONSE",
        response.status,
        undefined,
        text.slice(0, 500),
      );
    }
  }

  // --- Danh mục -------------------------------------------------------------

  async fetchUnitsPage(
    page: number,
    pageSize = 50,
  ): Promise<{ items: NationalUnitDto[]; total: number }> {
    const raw = await this.request("GET", "/master/units", {
      query: { page, page_size: pageSize },
    });
    const parsed = unitsPageSchema.safeParse(raw);
    if (!parsed.success)
      throw new NdsError("Danh mục đơn vị tính trả về không đúng đặc tả", "RESPONSE");
    return { items: parsed.data.data, total: parsed.data.total ?? parsed.data.data.length };
  }

  async fetchDrugsPage(
    page: number,
    options: { pageSize?: number; updatedFrom?: string } = {},
  ): Promise<{ items: NationalDrugDto[]; total: number }> {
    const raw = await this.request("GET", "/master/drugs", {
      query: {
        page,
        page_size: options.pageSize ?? 50,
        last_update_from: options.updatedFrom,
      },
    });
    const parsed = drugsPageSchema.safeParse(raw);
    if (!parsed.success) throw new NdsError("Danh mục thuốc trả về không đúng đặc tả", "RESPONSE");
    return { items: parsed.data.data, total: parsed.data.total ?? parsed.data.data.length };
  }

  // --- Chứng từ -------------------------------------------------------------

  /** Gửi chứng từ; chỉ nhận về mã giao dịch, kết quả thật phải hỏi lại sau. */
  async submit(
    kind: "STOCK_IN" | "STOCK_OUT" | "STOCK_TAKING",
    payload: unknown,
  ): Promise<{ transactionId: string | null; status: string | null }> {
    const path = {
      STOCK_IN: "/transactions/stock-in",
      STOCK_OUT: "/transactions/stock-out",
      STOCK_TAKING: "/transactions/stock-taking",
    }[kind];

    const raw = await this.request("POST", path, { body: payload });
    const parsed = transactionAckSchema.safeParse(raw);
    if (!parsed.success) throw new NdsError("Phản hồi gửi chứng từ không đúng đặc tả", "RESPONSE");
    return {
      transactionId: parsed.data.transaction_id ?? null,
      status: parsed.data.status ?? null,
    };
  }

  async fetchStatus(
    kind: "STOCK_IN" | "STOCK_OUT" | "STOCK_TAKING",
    transactionId: string,
  ): Promise<{ status: string | null; messages: string[]; submittedAt: string | null }> {
    // Đặc tả ghi đường dẫn phiếu nhập ở dạng số ít ("/transaction/stock-in"),
    // khác hai loại còn lại. Giữ đúng từng đường dẫn như tài liệu.
    const path = {
      STOCK_IN: `/transaction/stock-in/${encodeURIComponent(transactionId)}/status`,
      STOCK_OUT: `/transactions/stock-out/${encodeURIComponent(transactionId)}/status`,
      STOCK_TAKING: `/transactions/stock-taking/${encodeURIComponent(transactionId)}/status`,
    }[kind];

    const raw = await this.request("GET", path);
    const parsed = transactionStatusSchema.safeParse(raw);
    if (!parsed.success) throw new NdsError("Phản hồi trạng thái không đúng đặc tả", "RESPONSE");
    return {
      status: parsed.data.status ?? null,
      messages: parsed.data.messages ?? [],
      submittedAt: parsed.data.submitted_at ?? null,
    };
  }
}
