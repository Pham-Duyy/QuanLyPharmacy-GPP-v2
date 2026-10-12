import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "./app-error.js";

/**
 * Dịch lỗi của Prisma sang mã lỗi trong bảng ở contract §2.7.
 * Nhờ vậy ràng buộc đặt ở CSDL vẫn trả về lỗi có nghĩa cho người dùng,
 * thay vì 500.
 */
function toAppError(error: unknown, context: { conflictMessage?: string } = {}): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      const target = Array.isArray(error.meta?.["target"])
        ? (error.meta["target"] as string[]).join(", ")
        : String(error.meta?.["target"] ?? "");
      return new AppError(
        409,
        "DUPLICATE",
        context.conflictMessage ?? `Dữ liệu đã tồn tại${target ? ` (${target})` : ""}`,
      );
    }
    if (error.code === "P2003") {
      return new AppError(422, "VALIDATION_ERROR", "Dữ liệu tham chiếu không tồn tại");
    }
    if (error.code === "P2025") {
      return AppError.notFound();
    }
  }

  // Ràng buộc CHECK của PostgreSQL không có mã riêng của Prisma.
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    const message = String(error.message);
    const match = /violates check constraint "([^"]+)"/.exec(message);
    if (match) {
      return new AppError(422, "VALIDATION_ERROR", `Dữ liệu vi phạm ràng buộc ${match[1]}`);
    }
  }

  return error;
}

/**
 * CSDL tạm hết kết nối: bể kết nối đầy quá thời gian chờ (thông báo của `pg`)
 * hoặc Prisma không mở kịp giao dịch (P2028). Lỗi tạm thời, gửi lại là được.
 */
export function isDatabaseBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes("timeout exceeded when trying to connect")) return true;
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2028" &&
    error.message.includes("Unable to start a transaction")
  );
}

/**
 * Chuỗi không phải UUID đi tới CSDL, thường là mã sai định dạng trên đường dẫn
 * (`/invoices/abc`). PostgreSQL báo 22P02 trên kiểu uuid; Prisma gói lại thành
 * P2007 (truy vấn thường) hoặc P2010 (truy vấn raw), giữ mã gốc trong `meta`.
 */
export function isInvalidUuid(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const cause = (
    error.meta?.["driverAdapterError"] as
      { cause?: { originalCode?: string; originalMessage?: string } } | undefined
  )?.cause;
  return cause?.originalCode === "22P02" && /type uuid/.test(cause.originalMessage ?? "");
}

/** Bọc một thao tác ghi để lỗi CSDL được dịch sang AppError. */
export async function withMappedErrors<T>(
  run: () => Promise<T>,
  context?: { conflictMessage?: string },
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toAppError(error, context);
  }
}
