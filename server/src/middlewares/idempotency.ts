import { createHash, randomUUID } from "node:crypto";
import type { RequestHandler, Response } from "express";
import { prisma } from "../db/prisma.js";
import { AppError } from "../lib/app-error.js";
import { idempotencyStore } from "../lib/idempotency-context.js";

const KEY_TTL_HOURS = 24;

/**
 * Chữ ký của một yêu cầu. Xuất ra ngoài để kiểm thử dựng được đúng khóa mà
 * một lần gửi thật sẽ tạo ra.
 */
export function idempotencyRequestHash(
  method: string,
  path: string,
  storeId: string | null,
  body: unknown,
): string {
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
 * Bốn tình huống hỏng đã được xử lý ở đây:
 *
 * 1. **Nghiệp vụ đã commit nhưng response lỗi.** Service ghi id chứng từ vào
 *    chính khóa này trong cùng transaction (`markIdempotentResource`), nên
 *    khóa mang `resourceId` là bằng chứng "đã ghi rồi". Khóa đó không bao giờ
 *    bị xóa, và lần gửi lại nhận 409 kèm id chứng từ thay vì tạo bản thứ hai.
 * 2. **Tiến trình chết giữa chừng.** Khóa IN_PROGRESS chưa có chứng từ và đã
 *    quá hạn thì lần gửi lại được phép tiếp quản, không kẹt 24 giờ.
 * 3. **Hai request cùng tiếp quản một khóa treo.** Việc tiếp quản là một lệnh
 *    UPDATE có điều kiện trên (id, owner_token) — so sánh rồi đổi trong một
 *    bước — nên chỉ một request nhận được khóa. Mọi lệnh ghi lên khóa về sau
 *    đều kèm `owner_token`, nên request đã mất quyền sở hữu không thể xóa hay
 *    ghi đè khóa của request đang chạy.
 * 4. **Cùng khóa nhưng khác cửa hàng.** X-Store-Id nằm trong chữ ký yêu cầu,
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
  const requestHash = idempotencyRequestHash(req.method, path, storeId, req.body);

  const owned = await claim(key, auth.userId, req.method, path, storeId, requestHash);
  if (owned) {
    run(res, next, key, auth.userId, owned);
    return;
  }

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

  if (existing.status !== "IN_PROGRESS") {
    // Đã xử lý xong: trả lại đúng kết quả cũ thay vì làm lại nghiệp vụ.
    res.status(existing.responseStatus ?? 200).json(existing.responseBody);
    return;
  }

  if (existing.resourceId) {
    // Lần trước đã ghi xong chứng từ nhưng không trả được kết quả.
    throw new AppError(
      409,
      "REQUEST_ALREADY_COMMITTED",
      "Yêu cầu trước với khóa này đã ghi nhận chứng từ, mở lại chứng từ đó thay vì tạo mới",
      [{ resourceType: existing.resourceType, resourceId: existing.resourceId }],
    );
  }

  if (existing.expiresAt.getTime() > Date.now()) {
    throw new AppError(409, "REQUEST_IN_PROGRESS", "Yêu cầu trước với cùng khóa đang được xử lý");
  }

  // Khóa treo từ một tiến trình đã chết và chưa ghi chứng từ nào: tiếp quản
  // bằng một lệnh so-sánh-rồi-đổi trên (id, owner_token). Hai request cùng
  // tới đây thì chỉ một request thấy `count = 1`; request kia bị chặn 409 và
  // không đụng được vào khóa đã đổi chủ.
  const token = await takeOverStaleKey(existing, {
    storeId,
    method: req.method,
    path,
    requestHash,
  });
  if (!token) {
    throw new AppError(409, "REQUEST_IN_PROGRESS", "Yêu cầu trước với cùng khóa đang được xử lý");
  }

  run(res, next, key, auth.userId, token);
};

/**
 * Tiếp quản một khóa treo bằng **một lệnh so sánh rồi đổi** trên
 * (id, owner_token): chỉ transaction nào thấy đúng chủ cũ mới đổi được chủ.
 *
 * Tuyệt đối không dùng "xóa rồi tạo lại": hai request cùng cầm bản đọc cũ
 * thì request thứ hai sẽ xóa mất khóa mà request thứ nhất vừa tạo, và cả hai
 * cùng chạy nghiệp vụ.
 *
 * Trả về token sở hữu mới, hoặc null nếu khóa đã đổi chủ / đã có chứng từ /
 * đã được gia hạn.
 */
export async function takeOverStaleKey(
  existing: { id: bigint; ownerToken: string },
  patch: { storeId: string | null; method: string; path: string; requestHash: string },
): Promise<string | null> {
  const token = randomUUID();
  const taken = await prisma.idempotencyKey.updateMany({
    where: {
      id: existing.id,
      ownerToken: existing.ownerToken,
      status: "IN_PROGRESS",
      resourceId: null,
      expiresAt: { lt: new Date() },
    },
    data: {
      ownerToken: token,
      storeId: patch.storeId,
      method: patch.method,
      path: patch.path,
      requestHash: patch.requestHash,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + KEY_TTL_HOURS * 60 * 60 * 1000),
    },
  });
  return taken.count === 1 ? token : null;
}

/** Chạy tiếp chuỗi xử lý với quyền sở hữu khóa đã cầm trong tay. */
function run(
  res: Response,
  next: () => void,
  key: string,
  userId: string,
  ownerToken: string,
): void {
  captureResponse(res, key, userId, ownerToken);
  idempotencyStore.run({ key, userId, ownerToken }, () => next());
}

/** Giành khóa lần đầu. Trả về token sở hữu, hoặc null khi khóa đã tồn tại. */
async function claim(
  key: string,
  userId: string,
  method: string,
  path: string,
  storeId: string | null,
  requestHash: string,
): Promise<string | null> {
  const ownerToken = randomUUID();
  try {
    await prisma.idempotencyKey.create({
      data: {
        key,
        userId,
        storeId,
        ownerToken,
        method,
        path,
        requestHash,
        status: "IN_PROGRESS",
        expiresAt: new Date(Date.now() + KEY_TTL_HOURS * 60 * 60 * 1000),
      },
    });
    return ownerToken;
  } catch (error) {
    // Trùng (khóa, người dùng) là tình huống bình thường, lỗi khác phải nổi lên.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      return null;
    }
    throw error;
  }
}

/**
 * Ghi lại kết quả để lần gửi lại cùng khóa nhận đúng response cũ.
 *
 * Mọi lệnh ghi đều kèm `ownerToken`: request đã mất quyền sở hữu (bị tiếp
 * quản) không đụng được vào khóa của request đang giữ.
 *
 * Khi request thất bại, khóa **chỉ** bị xóa nếu chưa gắn với chứng từ nào —
 * tức là chắc chắn không có gì được ghi vào CSDL.
 */
function captureResponse(res: Response, key: string, userId: string, ownerToken: string): void {
  const sendJson = res.json.bind(res);

  res.json = (body: unknown): Response => {
    const status = res.statusCode;
    void (async () => {
      try {
        if (status >= 200 && status < 300) {
          await prisma.idempotencyKey.updateMany({
            where: { key, userId, ownerToken, status: "IN_PROGRESS" },
            data: {
              status: "COMPLETED",
              responseStatus: status,
              responseBody: body as never,
              completedAt: new Date(),
            },
          });
        } else {
          await prisma.idempotencyKey.deleteMany({
            where: { key, userId, ownerToken, status: "IN_PROGRESS", resourceId: null },
          });
        }
      } catch (error) {
        // Không để lỗi dọn khóa biến thành unhandled rejection làm sập tiến
        // trình: response cho người dùng vẫn phải đi, khóa sẽ hết hạn rồi
        // được tiếp quản như mọi khóa treo khác.
        console.error("Không lưu được kết quả idempotency:", error);
      } finally {
        sendJson(body);
      }
    })();
    return res;
  };
}
