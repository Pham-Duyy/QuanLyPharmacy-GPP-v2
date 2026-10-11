import { createContext, useContext } from "react";
import type { Me } from "./auth-types.js";

/**
 * Ngữ cảnh đăng nhập dùng chung. Tách khỏi AuthProvider.tsx để file đó chỉ
 * xuất component — Vite mới cập nhật nóng (Fast Refresh) được khi sửa nó.
 */
export type AuthState = {
  status: "loading" | "anonymous" | "authenticated";
  me: Me | null;
  storeId: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  selectStore: (storeId: string) => void;
  can: (permission: string) => boolean;
  reloadMe: () => Promise<void>;
};

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth phải nằm trong AuthProvider");
  return value;
}
