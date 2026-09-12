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

export async function refreshAccessToken(): Promise<string> {
  const response = await axios.post<{ data: { accessToken: string } }>(
    "/api/v1/auth/refresh",
    null,
    { withCredentials: true },
  );
  return response.data.data.accessToken;
}

let refreshing: Promise<string> | null = null;

type RetriableConfig = AxiosRequestConfig & { _retried?: boolean };

/** Access token hết hạn thì tự lấy token mới một lần rồi gửi lại request. */
http.interceptors.response.use(undefined, async (error: AxiosError) => {
  const original = error.config as RetriableConfig | undefined;
  const isAuthCall =
    original?.url?.includes("/auth/login") || original?.url?.includes("/auth/refresh");

  if (error.response?.status === 401 && original && !original._retried && !isAuthCall) {
    original._retried = true;
    try {
      refreshing ??= refreshAccessToken();
      const token = await refreshing;
      refreshing = null;
      setAccessToken(token);
      return await http(original);
    } catch {
      refreshing = null;
      setAccessToken(null);
      onSessionExpired?.();
    }
  }

  return Promise.reject(error);
});

/** Lấy thông điệp lỗi tiếng Việt do backend trả về theo khung ở contract §2.6. */
export function getErrorMessage(error: unknown, fallback = "Đã xảy ra lỗi"): string {
  if (error instanceof AxiosError) {
    const payload = error.response?.data as
      | { error?: { message?: string; code?: string } }
      | undefined;
    return payload?.error?.message ?? error.message ?? fallback;
  }
  return fallback;
}
