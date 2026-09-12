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
};

const AuthContext = createContext<AuthState | null>(null);

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
    const preferred =
      data.user.defaultStoreId ?? (data.stores.length > 0 ? data.stores[0]!.id : null);
    setStoreId(preferred);
    setCurrentStoreId(preferred);
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

  const selectStore = useCallback((next: string) => {
    setStoreId(next);
    setCurrentStoreId(next);
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
    () => ({ status, me, storeId, login, logout, selectStore, can }),
    [status, me, storeId, login, logout, selectStore, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
