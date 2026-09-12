import type { AuthContext } from "../modules/auth/auth.context.js";

declare global {
  namespace Express {
    interface Request {
      /** Gắn bởi middleware authenticate; chỉ có khi request đã đăng nhập. */
      auth?: AuthContext;
    }
  }
}

export {};
