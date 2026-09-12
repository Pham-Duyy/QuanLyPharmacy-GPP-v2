import type { RequestHandler } from "express";
import { AppError } from "../lib/app-error.js";
import { prisma } from "../db/prisma.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Đọc header X-Store-Id và kiểm tra người dùng có quyền làm việc tại cửa hàng đó
 * (contract §2.8). Chạy sau authenticate, trước mọi middleware kiểm tra quyền.
 */
export const storeContext: RequestHandler = async (req, _res, next) => {
  const header = req.header("X-Store-Id");
  if (!header) {
    next();
    return;
  }

  if (!UUID_PATTERN.test(header)) {
    throw new AppError(400, "BAD_REQUEST", "X-Store-Id không đúng định dạng");
  }

  const auth = req.auth;
  if (!auth) {
    throw new AppError(401, "UNAUTHENTICATED", "Cần đăng nhập để dùng chức năng này");
  }

  if (!auth.canAccessStore(header)) {
    throw new AppError(403, "STORE_FORBIDDEN", "Bạn không có quyền làm việc tại cửa hàng này");
  }

  const store = await prisma.store.findUnique({ where: { id: header } });
  if (!store || !store.isActive) {
    throw new AppError(403, "STORE_FORBIDDEN", "Cửa hàng không tồn tại hoặc đã ngừng hoạt động");
  }

  auth.storeId = store.id;
  next();
};

/** Dùng cho endpoint thuộc phạm vi cửa hàng: bắt buộc phải có X-Store-Id. */
export const requireStore: RequestHandler = (req, _res, next) => {
  if (!req.auth?.storeId) {
    throw new AppError(
      400,
      "STORE_REQUIRED",
      "Thiếu header X-Store-Id cho chức năng thuộc phạm vi cửa hàng",
    );
  }
  next();
};
