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
  /** Đã bật MFA thì trả vé để nhập mã ở bước hai; không thì đăng nhập xong luôn và trả null. */
  login: (username: string, password: string) => Promise<{ mfaToken: string } | null>;
  /** Bước hai: vé + mã 6 số hoặc mã dự phòng. Trả true khi đã dùng mã dự phòng. */
  loginWithMfa: (mfaToken: string, code: string) => Promise<boolean>;
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
