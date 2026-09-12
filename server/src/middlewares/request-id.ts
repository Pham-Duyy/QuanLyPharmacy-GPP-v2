import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

/**
 * Gắn requestId cho mọi request để tra log (§2 API contract).
 * Nhận lại giá trị client gửi lên nếu hợp lệ, không thì tự sinh.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header("X-Request-Id");
  const id =
    incoming && incoming.length > 0 && incoming.length <= 100
      ? incoming
      : `req_${randomUUID()}`;

  res.locals.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
};
