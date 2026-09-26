import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  http,
  refreshAccessToken,
  setAccessToken,
  setCurrentStoreId,
  setOnSessionExpired,
} from "../../api/http.js";
import type { Me } from "./auth-types.js";

type AuthState = {
  status: "loading" | "anonymous" | "authenticated";
  me: Me | null;
  storeId: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  selectStore: (storeId: string) => void;
  can: (permission: string) => boolean;
  reloadMe: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

/**
 * Cửa hàng đang làm việc được nhớ lại giữa các lần tải trang. Không nhớ thì
 * mỗi lần bấm F5 người dùng bị đưa về cửa hàng mặc định trong khi vẫn tưởng
 * mình đang ở cửa hàng vừa chọn — rất dễ bán nhầm kho.
 */
const STORE_KEY = "gpp.store";

function rememberedStore(): string | null {
  try {
    return window.localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

function rememberStore(storeId: string | null): void {
  try {
    if (storeId) window.localStorage.setItem(STORE_KEY, storeId);
    else window.localStorage.removeItem(STORE_KEY);
  } catch {
    // Trình duyệt chặn localStorage thì chỉ mất tiện ích nhớ cửa hàng.
  }
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth phải nằm trong AuthProvider");
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [storeId, setStoreId] = useState<string | null>(null);

  const applyMe = useCallback((data: Me) => {
    setMe(data);
    // Ưu tiên cửa hàng đang làm dở, nhưng chỉ khi người dùng còn quyền ở đó.
    const remembered = rememberedStore();
    const preferred =
      (remembered && data.stores.some((item) => item.id === remembered) ? remembered : null) ??
      data.user.defaultStoreId ??
      (data.stores.length > 0 ? data.stores[0]!.id : null);
    setStoreId(preferred);
    setCurrentStoreId(preferred);
    rememberStore(preferred);
    setStatus("authenticated");
  }, []);

  const clear = useCallback(() => {
    setAccessToken(null);
    setCurrentStoreId(null);
    setMe(null);
    setStoreId(null);
    setStatus("anonymous");
  }, []);

  // Tải lại trang thì access token mất, nhưng cookie refresh vẫn còn:
  // thử lấy token mới để người dùng không phải đăng nhập lại.
  useEffect(() => {
    let cancelled = false;
    setOnSessionExpired(() => clear());

    (async () => {
      try {
        const token = await refreshAccessToken();
        if (cancelled) return;
        setAccessToken(token);
        const response = await http.get<{ data: Me }>("/auth/me");
        if (!cancelled) applyMe(response.data.data);
      } catch {
        if (!cancelled) clear();
      }
    })();

    return () => {
      cancelled = true;
      setOnSessionExpired(null);
    };
  }, [applyMe, clear]);

  const login = useCallback(
    async (username: string, password: string) => {
      const response = await http.post<{ data: { accessToken: string } }>("/auth/login", {
        username,
        password,
      });
      setAccessToken(response.data.data.accessToken);
      const profile = await http.get<{ data: Me }>("/auth/me");
      applyMe(profile.data.data);
    },
    [applyMe],
  );

  const logout = useCallback(async () => {
    try {
      await http.post("/auth/logout");
    } finally {
      clear();
    }
  }, [clear]);

  const queryClient = useQueryClient();

  const selectStore = useCallback(
    (next: string) => {
      setStoreId(next);
      setCurrentStoreId(next);
      rememberStore(next);
      // Dữ liệu đã tải thuộc về cửa hàng cũ: xóa sạch bộ nhớ đệm để mọi màn
      // hình nạp lại theo cửa hàng mới. Không làm bước này thì người dùng vẫn
      // thấy hóa đơn, tồn kho, báo cáo của cửa hàng vừa rời đi.
      queryClient.clear();
    },
    [queryClient],
  );

  // Chỉ làm mới hồ sơ, giữ nguyên cửa hàng đang chọn.
  const reloadMe = useCallback(async () => {
    const response = await http.get<{ data: Me }>("/auth/me");
    setMe(response.data.data);
  }, []);

  const can = useCallback(
    (permission: string) => {
      if (!me) return false;
      const store = me.stores.find((item) => item.id === storeId);
      const scoped = store ? store.permissions : me.chainPermissions;
      return scoped.includes(permission);
    },
    [me, storeId],
  );

  const value = useMemo<AuthState>(
    () => ({ status, me, storeId, login, logout, selectStore, can, reloadMe }),
    [status, me, storeId, login, logout, selectStore, can, reloadMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
