import axios, { AxiosError, type AxiosRequestConfig } from "axios";

/**
 * Access token chỉ giữ trong bộ nhớ, không lưu localStorage (contract §3).
 * Mất khi tải lại trang là đúng thiết kế: lúc đó dùng cookie refresh để lấy
 * token mới, và một lỗi XSS cũng không đọc trộm được token dài hạn.
 */
let accessToken: string | null = null;
let currentStoreId: string | null = null;
let onSessionExpired: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function setCurrentStoreId(storeId: string | null): void {
  currentStoreId = storeId;
}

export function setOnSessionExpired(handler: (() => void) | null): void {
  onSessionExpired = handler;
}

export const http = axios.create({ baseURL: "/api/v1", withCredentials: true });

http.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  // Endpoint thuộc phạm vi cửa hàng cần header này (contract §2.8).
  if (currentStoreId) config.headers["X-Store-Id"] = currentStoreId;
  return config;
});

let refreshing: Promise<string> | null = null;

/**
 * Mọi lời gọi đồng thời dùng chung một request. Máy chủ xoay vòng refresh
 * token và coi token cũ gửi lại là bị đánh cắp (thu hồi cả chuỗi phiên), nên
 * hai request refresh song song cùng cookie — ví dụ effect khởi động chạy hai
 * lần dưới StrictMode — sẽ đăng xuất người dùng.
 */
export function refreshAccessToken(): Promise<string> {
  refreshing ??= axios
    .post<{ data: { accessToken: string } }>("/api/v1/auth/refresh", null, { withCredentials: true })
    .then((response) => response.data.data.accessToken)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

type RetriableConfig = AxiosRequestConfig & { _retried?: boolean };

/** Access token hết hạn thì tự lấy token mới một lần rồi gửi lại request. */
http.interceptors.response.use(undefined, async (error: AxiosError) => {
  const original = error.config as RetriableConfig | undefined;
  const isAuthCall =
    original?.url?.includes("/auth/login") || original?.url?.includes("/auth/refresh");

  if (error.response?.status === 401 && original && !original._retried && !isAuthCall) {
    original._retried = true;
    let token: string;
    try {
      token = await refreshAccessToken();
    } catch {
      setAccessToken(null);
      onSessionExpired?.();
      return Promise.reject(error);
    }
    setAccessToken(token);
    // Gửi lại ngoài try: lỗi nghiệp vụ của lần gửi lại (403, 422…) không được coi là hết phiên.
    return http(original);
  }

  return Promise.reject(error);
});

/** Lấy thông điệp lỗi tiếng Việt do backend trả về theo khung ở contract §2.6. */
/**
 * Chứng từ mà một yêu cầu trước đó đã ghi được (409 REQUEST_ALREADY_COMMITTED).
 *
 * Máy chủ trả về khi lần gửi trước đã commit nghiệp vụ nhưng máy khách không
 * nhận được kết quả. Máy khách phải mở đúng chứng từ đó thay vì hiểu nhầm là
 * giao dịch thất bại rồi làm lại.
 */
export function getCommittedResource(
  error: unknown,
): { resourceType: string | null; resourceId: string } | null {
  if (!(error instanceof AxiosError)) return null;
  const payload = error.response?.data as
    | { error?: { code?: string; details?: Array<{ resourceType?: string | null; resourceId?: string }> } }
    | undefined;
  if (payload?.error?.code !== "REQUEST_ALREADY_COMMITTED") return null;
  const first = payload.error.details?.[0];
  if (!first?.resourceId) return null;
  return { resourceType: first.resourceType ?? null, resourceId: first.resourceId };
}

export function getErrorMessage(error: unknown, fallback = "Đã xảy ra lỗi"): string {
  if (error instanceof AxiosError) {
    const payload = error.response?.data as
      | { error?: { message?: string; code?: string } }
      | undefined;
    return payload?.error?.message ?? error.message ?? fallback;
  }
  return fallback;
}
