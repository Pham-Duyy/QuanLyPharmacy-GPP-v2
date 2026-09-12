import type { Response } from "express";

/** Khung response thành công theo §2.6 của API contract. */
export function sendData<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({
    success: true,
    data,
    requestId: res.locals.requestId,
  });
}

/** Khung response lỗi theo §2.6. Chỉ errorHandler nên gọi hàm này. */
export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details: unknown[] = [],
): void {
  res.status(status).json({
    success: false,
    error: { code, message, details },
    requestId: res.locals.requestId,
  });
}
