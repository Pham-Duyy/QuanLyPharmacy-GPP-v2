/**
 * Lỗi nghiệp vụ có mã ổn định, khớp bảng mã lỗi ở §2.7 của API contract.
 * Tầng service ném lỗi này, errorHandler dịch thành response chuẩn.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown[];

  constructor(status: number, code: string, message: string, details: unknown[] = []) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static notFound(message = "Không tìm thấy tài nguyên"): AppError {
    return new AppError(404, "NOT_FOUND", message);
  }

  static invalidState(message: string, details: unknown[] = []): AppError {
    return new AppError(409, "INVALID_STATE", message, details);
  }

  static validation(message: string, details: unknown[] = []): AppError {
    return new AppError(422, "VALIDATION_ERROR", message, details);
  }
}
