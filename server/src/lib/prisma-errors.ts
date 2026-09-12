import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "./app-error.js";

/**
 * Dịch lỗi của Prisma sang mã lỗi trong bảng ở contract §2.7.
 * Nhờ vậy ràng buộc đặt ở CSDL vẫn trả về lỗi có nghĩa cho người dùng,
 * thay vì 500.
 */
export function toAppError(error: unknown, context: { conflictMessage?: string } = {}): unknown {
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
