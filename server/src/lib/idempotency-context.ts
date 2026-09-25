import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "../generated/prisma/client.js";

type Tx = Prisma.TransactionClient;

export type IdempotencyContext = { key: string; userId: string };

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
 */
export async function markIdempotentResource(
  tx: Tx,
  resourceType: string,
  resourceId: string,
): Promise<void> {
  const context = idempotencyStore.getStore();
  if (!context) return;
  await tx.idempotencyKey.updateMany({
    where: { key: context.key, userId: context.userId },
    data: { resourceType, resourceId },
  });
}
