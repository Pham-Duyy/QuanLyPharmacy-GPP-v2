import { createHash } from "node:crypto";
import type { RequestHandler, Response } from "express";
import { prisma } from "../db/prisma.js";
import { AppError } from "../lib/app-error.js";

const KEY_TTL_HOURS = 24;

function hashRequest(method: string, path: string, body: unknown): string {
  return createHash("sha256")
    .update(`${method} ${path} ${JSON.stringify(body ?? {})}`)
    .digest("hex");
}

/**
 * Chốt chặn C1 ở tầng ứng dụng (contract §2.3).
 *
 * Mỗi thao tác đổi trạng thái phải mang Idempotency-Key. Khóa được ghi vào
 * CSDL với ràng buộc duy nhất theo (khóa, người dùng), nên hai request cùng
 * khóa chạy song song thì chỉ một request đi tiếp; request còn lại hoặc nhận
 * lại đúng kết quả cũ, hoặc bị chặn.
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
  const requestHash = hashRequest(req.method, path, req.body);

  try {
    await prisma.idempotencyKey.create({
      data: {
        key,
        userId: auth.userId,
        method: req.method,
        path,
        requestHash,
        status: "IN_PROGRESS",
        expiresAt: new Date(Date.now() + KEY_TTL_HOURS * 60 * 60 * 1000),
      },
    });
  } catch {
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
      throw new AppError(409, "REQUEST_IN_PROGRESS", "Yêu cầu trước với cùng khóa đang được xử lý");
    }

    // Đã xử lý xong: trả lại đúng kết quả cũ thay vì làm lại nghiệp vụ.
    res.status(existing.responseStatus ?? 200).json(existing.responseBody);
    return;
  }

  captureResponse(res, key, auth.userId);
  next();
};

/**
 * Ghi lại kết quả để lần gửi lại cùng khóa nhận đúng response cũ.
 * Nếu request thất bại thì xóa khóa, để client sửa dữ liệu rồi thử lại được.
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
          await prisma.idempotencyKey.deleteMany({ where: { key, userId, status: "IN_PROGRESS" } });
        }
      } finally {
        sendJson(body);
      }
    })();
    return res;
  };
}
