import { AppError } from "./app-error.js";

type UpdateManyResult = { count: number };

/**
 * Khóa lạc quan theo contract §2.5: chỉ cập nhật khi version khớp,
 * lệch phiên bản thì trả 409 VERSION_CONFLICT thay vì ghi đè người khác.
 */
export async function updateWithVersion(params: {
  update: () => Promise<UpdateManyResult>;
  exists: () => Promise<boolean>;
  notFoundMessage?: string;
}): Promise<void> {
  const result = await params.update();
  if (result.count > 0) return;

  if (await params.exists()) {
    throw new AppError(
      409,
      "VERSION_CONFLICT",
      "Bản ghi đã được người khác sửa, hãy tải lại rồi thử lại",
    );
  }
  throw AppError.notFound(params.notFoundMessage);
}
