import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError } from "../lib/app-error.js";
import { sendError } from "../lib/respond.js";
import { isProduction } from "../config/env.js";

/** Đường dẫn không khớp route nào. */
export const notFoundHandler: RequestHandler = (req, res) => {
  sendError(res, 404, "NOT_FOUND", `Không có endpoint ${req.method} ${req.originalUrl}`);
};

/**
 * Nơi duy nhất biến lỗi thành response.
 * Express 5 tự chuyển lỗi từ handler async vào đây, không cần try/catch ở route.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    req.log?.warn({ err, code: err.code }, "Lỗi nghiệp vụ");
    sendError(res, err.status, err.code, err.message, err.details);
    return;
  }

  if (err instanceof SyntaxError && "body" in err) {
    req.log?.warn({ err }, "JSON gửi lên không hợp lệ");
    sendError(res, 400, "BAD_REQUEST", "Nội dung JSON không hợp lệ");
    return;
  }

  req.log?.error({ err }, "Lỗi không mong muốn");
  sendError(
    res,
    500,
    "INTERNAL_ERROR",
    isProduction
      ? "Đã xảy ra lỗi, vui lòng thử lại"
      : err instanceof Error
        ? err.message
        : String(err),
  );
};
