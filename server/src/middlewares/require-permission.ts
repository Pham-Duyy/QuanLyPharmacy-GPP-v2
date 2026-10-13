import type { RequestHandler } from "express";
import { AppError } from "../lib/app-error.js";

/**
 * Kiểm tra permission theo đúng phạm vi của request (contract §4, §2.8).
 * Khi request có X-Store-Id, chỉ tính quyền hiệu lực tại cửa hàng đó.
 */
export function requirePermission(permission: string): RequestHandler {
  return requireAnyPermission(permission);
}

/** Có một trong các quyền là đủ (ví dụ chủ nhà thuốc hoặc dược sĩ cùng xem một màn). */
export function requireAnyPermission(...permissions: string[]): RequestHandler {
  return (req, _res, next) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "UNAUTHENTICATED", "Cần đăng nhập để dùng chức năng này");
    }
    if (!permissions.some((permission) => auth.can(permission))) {
      throw new AppError(403, "FORBIDDEN", `Bạn không có quyền ${permissions.join(" hoặc ")}`);
    }
    next();
  };
}
