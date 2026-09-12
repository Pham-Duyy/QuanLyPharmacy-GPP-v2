import type { RequestHandler } from "express";
import { AppError } from "../lib/app-error.js";
import { prisma } from "../db/prisma.js";
import { verifyAccessToken } from "../lib/tokens.js";
import { loadAuthContext } from "../modules/auth/auth.context.js";

/**
 * Xác thực access token và nạp quyền của người dùng.
 * Phiên bị thu hồi (đăng xuất, đổi mật khẩu, vô hiệu hóa tài khoản) thì
 * access token còn hạn cũng không dùng được nữa, vì có kiểm tra phiên trong CSDL.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new AppError(401, "UNAUTHENTICATED", "Cần đăng nhập để dùng chức năng này");
  }

  let payload;
  try {
    payload = verifyAccessToken(header.slice("Bearer ".length).trim());
  } catch {
    throw new AppError(401, "TOKEN_EXPIRED", "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại");
  }

  const session = await prisma.refreshSession.findUnique({ where: { id: payload.sid } });
  if (!session || session.revokedAt !== null || session.userId !== payload.sub) {
    throw new AppError(401, "UNAUTHENTICATED", "Phiên đăng nhập đã bị thu hồi");
  }

  const auth = await loadAuthContext(payload.sub, payload.sid);
  if (!auth) {
    throw new AppError(401, "UNAUTHENTICATED", "Tài khoản không còn hoạt động");
  }

  req.auth = auth;
  next();
};
