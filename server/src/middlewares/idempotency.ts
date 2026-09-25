import { createHash } from "node:crypto";
import type { RequestHandler, Response } from "express";
import { prisma } from "../db/prisma.js";
import { AppError } from "../lib/app-error.js";
import { idempotencyStore } from "../lib/idempotency-context.js";

const KEY_TTL_HOURS = 24;

function hashRequest(method: string, path: string, storeId: string | null, body: unknown): string {
  return createHash("sha256")
    .update(`${method} ${path} ${storeId ?? "-"} ${JSON.stringify(body ?? {})}`)
    .digest("hex");
}

/**
 * Chốt chặn C1 ở tầng ứng dụng (contract §2.3).
 *
 * Mỗi thao tác đổi trạng thái phải mang Idempotency-Key. Khóa được ghi vào
 * CSDL với ràng buộc duy nhất theo (khóa, người dùng), nên hai request cùng
 * khóa chạy song song thì chỉ một request đi tiếp; request còn lại hoặc nhận
 * lại đúng kết quả cũ, hoặc bị chặn.
 *
 * Ba tình huống hỏng đã được xử lý ở đây:
 *
 * 1. **Nghiệp vụ đã commit nhưng response lỗi.** Service ghi id chứng từ vào
 *    chính khóa này trong cùng transaction (`markIdempotentResource`), nên
 *    khóa mang `resourceId` là bằng chứng "đã ghi rồi". Khóa đó không bao giờ
 *    bị xóa, và lần gửi lại nhận 409 kèm id chứng từ thay vì tạo bản thứ hai.
 * 2. **Tiến trình chết giữa chừng.** Khóa IN_PROGRESS chưa có chứng từ và đã
 *    quá hạn thì lần gửi lại được phép tiếp quản, không kẹt 24 giờ.
 * 3. **Cùng khóa nhưng khác cửa hàng.** X-Store-Id nằm trong chữ ký yêu cầu,
 *    nên không thể lấy nhầm kết quả của cửa hàng khác.
 */
export const idempotency: RequestHandler = async (req, res, next) => {
  const key = req.header("Idempotency-Key");
  if (!key) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Thao tác này cần header Idempotency-Key để tránh xử lý trùng",
    );
  }

  const auth = req.auth;
  if (!auth) throw new AppError(401, "UNAUTHENTICATED", "Cần đăng nhập để dùng chức năng này");

  const path = `${req.baseUrl}${req.path}`;
  const storeId = auth.storeId ?? null;
  const requestHash = hashRequest(req.method, path, storeId, req.body);

  const created = await claim(key, auth.userId, req.method, path, storeId, requestHash);
  if (!created) {
    const existing = await prisma.idempotencyKey.findUnique({
      where: { key_userId: { key, userId: auth.userId } },
    });
    if (!existing) throw new AppError(500, "INTERNAL_ERROR", "Không ghi được khóa idempotency");

    if (existing.requestHash !== requestHash) {
      throw new AppError(
        422,
        "IDEMPOTENCY_KEY_REUSED",
        "Khóa idempotency này đã dùng cho một nội dung khác",
      );
    }

    if (existing.status === "IN_PROGRESS") {
      if (existing.resourceId) {
        // Lần trước đã ghi xong chứng từ nhưng không trả được kết quả.
        throw new AppError(
          409,
          "REQUEST_ALREADY_COMMITTED",
          `Yêu cầu trước với khóa này đã ghi nhận chứng từ, mở lại chứng từ đó thay vì tạo mới`,
          [{ resourceType: existing.resourceType, resourceId: existing.resourceId }],
        );
      }
      if (existing.expiresAt.getTime() > Date.now()) {
        throw new AppError(
          409,
          "REQUEST_IN_PROGRESS",
          "Yêu cầu trước với cùng khóa đang được xử lý",
        );
      }
      // Khóa treo từ một tiến trình đã chết và chưa ghi chứng từ nào: dọn đi
      // rồi xử lý lại từ đầu.
      const cleaned = await prisma.idempotencyKey.deleteMany({
        where: { key, userId: auth.userId, status: "IN_PROGRESS", resourceId: null },
      });
      if (cleaned.count === 0) {
        throw new AppError(409, "REQUEST_IN_PROGRESS", "Yêu cầu trước với cùng khóa đang được xử lý");
      }
      const retook = await claim(key, auth.userId, req.method, path, storeId, requestHash);
      if (!retook) {
        throw new AppError(409, "REQUEST_IN_PROGRESS", "Yêu cầu trước với cùng khóa đang được xử lý");
      }
      captureResponse(res, key, auth.userId);
      idempotencyStore.run({ key, userId: auth.userId }, () => next());
      return;
    }

    // Đã xử lý xong: trả lại đúng kết quả cũ thay vì làm lại nghiệp vụ.
    res.status(existing.responseStatus ?? 200).json(existing.responseBody);
    return;
  }

  captureResponse(res, key, auth.userId);
  idempotencyStore.run({ key, userId: auth.userId }, () => next());
};

/** Giành khóa. Trả về false khi khóa đã tồn tại. */
async function claim(
  key: string,
  userId: string,
  method: string,
  path: string,
  storeId: string | null,
  requestHash: string,
): Promise<boolean> {
  try {
    await prisma.idempotencyKey.create({
      data: {
        key,
        userId,
        storeId,
        method,
        path,
        requestHash,
        status: "IN_PROGRESS",
        expiresAt: new Date(Date.now() + KEY_TTL_HOURS * 60 * 60 * 1000),
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ghi lại kết quả để lần gửi lại cùng khóa nhận đúng response cũ.
 *
 * Khi request thất bại, khóa **chỉ** bị xóa nếu chưa gắn với chứng từ nào —
 * tức là chắc chắn không có gì được ghi vào CSDL. Khóa đã gắn chứng từ thì
 * giữ nguyên để lần gửi lại không tạo bản thứ hai.
 */
function captureResponse(res: Response, key: string, userId: string): void {
  const sendJson = res.json.bind(res);

  res.json = (body: unknown): Response => {
    const status = res.statusCode;
    void (async () => {
      try {
        if (status >= 200 && status < 300) {
          await prisma.idempotencyKey.updateMany({
            where: { key, userId },
            data: {
              status: "COMPLETED",
              responseStatus: status,
              responseBody: body as never,
              completedAt: new Date(),
            },
          });
        } else {
          await prisma.idempotencyKey.deleteMany({
            where: { key, userId, status: "IN_PROGRESS", resourceId: null },
          });
        }
      } finally {
        sendJson(body);
      }
    })();
    return res;
  };
}
