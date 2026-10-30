import { env } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";

/**
 * Gọi Analytics API của analytics-service (Python). Chỉ có GET: dịch vụ đó
 * chỉ đọc, cổng này cũng không mở đường ghi nào.
 */

const REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_URL = "http://127.0.0.1:8000";

/** Đọc lúc gọi (không phải lúc nạp module) để test trỏ được sang máy chủ giả. */
function baseUrl(): string {
  return (process.env["ANALYTICS_SERVICE_URL"] ?? env.ANALYTICS_SERVICE_URL ?? DEFAULT_URL).replace(
    /\/+$/,
    "",
  );
}

export type AnalyticsQuery = Record<string, string | number | undefined>;

/** FastAPI trả lỗi dạng {detail: "..."} hoặc {detail: [{msg}]} khi tham số sai. */
function detailOf(body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map((item) => (item as { msg?: string }).msg ?? String(item)).join("; ");
  }
  return "";
}

export async function fetchAnalytics<T = Record<string, unknown>>(
  path: string,
  query: AnalyticsQuery = {},
): Promise<T> {
  const url = new URL(`${baseUrl()}/api/analytics/${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new AppError(
      502,
      "ANALYTICS_UNAVAILABLE",
      "Dịch vụ phân tích chưa chạy. Mở thư mục analytics-service và chạy: python main.py serve",
    );
  }

  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return body as T;

  const detail = detailOf(body);
  if (response.status === 503) {
    throw new AppError(503, "ANALYTICS_NO_DATA", detail || "Dịch vụ phân tích chưa có số liệu");
  }
  if (response.status === 422) {
    throw AppError.validation(detail || "Tham số không hợp lệ");
  }
  if (response.status === 404) {
    // Thông báo gốc liệt kê mọi cửa hàng có trong tệp; không chuyển nguyên văn
    // cho người chỉ được xem một cửa hàng.
    throw AppError.notFound("Tệp dữ liệu chưa có số liệu của cửa hàng này");
  }
  throw new AppError(502, "ANALYTICS_UNAVAILABLE", `Dịch vụ phân tích trả lỗi ${response.status}`);
}
