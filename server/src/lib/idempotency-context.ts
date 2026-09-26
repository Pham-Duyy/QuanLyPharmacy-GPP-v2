import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "./app-error.js";

type Tx = Prisma.TransactionClient;

export type IdempotencyContext = { key: string; userId: string; ownerToken: string };

/**
 * Khóa idempotency của request đang chạy, đi theo suốt chuỗi await nhờ
 * AsyncLocalStorage. Nhờ vậy service ghi được "khóa này đã tạo ra chứng từ
 * nào" mà không phải truyền thêm tham số qua mọi lớp.
 */
export const idempotencyStore = new AsyncLocalStorage<IdempotencyContext>();

/**
 * Gắn chứng từ vừa ghi vào khóa idempotency, **trong cùng transaction** với
 * nghiệp vụ.
 *
 * Đây là điểm mấu chốt: transaction commit thì khóa cũng mang sẵn id chứng
 * từ. Nếu sau đó việc dựng response mới lỗi, middleware nhìn vào `resourceId`
 * là biết nghiệp vụ đã ghi rồi nên không xóa khóa, và lần gửi lại không tạo
 * ra chứng từ thứ hai. Transaction rollback thì bản ghi này cũng mất theo,
 * khóa sạch sẽ và client gửi lại được bình thường.
 *
 * **Không gắn được khóa thì phải ném lỗi.** Nếu chỉ ghi 0 dòng rồi đi tiếp,
 * transaction nghiệp vụ vẫn commit trong khi khóa đã đổi chủ hoặc đã hoàn
 * tất — đúng tình huống một request cũ (đã bị tiếp quản) vẫn lưu được chứng
 * từ mà không ai biết, và lần gửi lại sẽ tạo chứng từ thứ hai. Ném lỗi ở đây
 * làm cả transaction quay đầu, nên không có gì được lưu.
 */
export async function markIdempotentResource(
  tx: Tx,
  resourceType: string,
  resourceId: string,
): Promise<void> {
  const context = idempotencyStore.getStore();
  if (!context) return;

  // Kèm owner_token và trạng thái: request đã bị tiếp quản, hoặc khóa đã
  // chuyển sang COMPLETED, thì không ghi được gì lên khóa của người khác.
  const marked = await tx.idempotencyKey.updateMany({
    where: {
      key: context.key,
      userId: context.userId,
      ownerToken: context.ownerToken,
      status: "IN_PROGRESS",
    },
    data: { resourceType, resourceId },
  });

  if (marked.count !== 1) {
    throw new AppError(
      409,
      "IDEMPOTENCY_OWNERSHIP_LOST",
      "Khóa idempotency của yêu cầu này đã đổi chủ hoặc đã kết thúc, không ghi nhận chứng từ được",
    );
  }
}
