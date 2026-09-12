import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  createRefreshToken,
  hashRefreshToken,
  newFamilyId,
  refreshExpiryDate,
  signAccessToken,
} from "../../lib/tokens.js";
import type { AuthContext } from "./auth.context.js";
import type { ChangePasswordInput, LoginInput } from "./auth.schema.js";

export type SessionInfo = { ip?: string | undefined; userAgent?: string | undefined };

export type TokenPair = {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string;
  refreshExpiresAt: Date;
};

const MAX_FAILED_BEFORE_DELAY = 5;

/** Tăng dần thời gian chờ theo số lần sai, không khóa cứng tài khoản (contract §3). */
function requiredDelaySeconds(failedCount: number): number {
  if (failedCount < MAX_FAILED_BEFORE_DELAY) return 0;
  return Math.min(2 ** (failedCount - MAX_FAILED_BEFORE_DELAY + 1), 300);
}

async function issueSession(
  userId: string,
  familyId: string,
  info: SessionInfo,
): Promise<TokenPair> {
  const { token, tokenHash } = createRefreshToken();
  const expiresAt = refreshExpiryDate();

  const session = await prisma.refreshSession.create({
    data: {
      userId,
      tokenHash,
      familyId,
      expiresAt,
      userAgent: info.userAgent ?? null,
      ip: info.ip ?? null,
    },
  });

  return {
    accessToken: signAccessToken(userId, session.id),
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: token,
    refreshExpiresAt: expiresAt,
  };
}

export async function login(input: LoginInput, info: SessionInfo): Promise<TokenPair> {
  const username = input.username.toLowerCase();
  const user = await prisma.user.findUnique({ where: { username } });

  // Cùng một thông báo cho sai tên và sai mật khẩu, để không lộ tài khoản nào có thật.
  const invalid = new AppError(401, "UNAUTHENTICATED", "Tên đăng nhập hoặc mật khẩu không đúng");

  if (!user || !user.isActive) throw invalid;

  const delay = requiredDelaySeconds(user.failedLoginCount);
  if (delay > 0 && user.lastFailedLoginAt) {
    const waitedMs = Date.now() - user.lastFailedLoginAt.getTime();
    const remaining = Math.ceil((delay * 1000 - waitedMs) / 1000);
    if (remaining > 0) {
      throw new AppError(
        429,
        "RATE_LIMITED",
        `Đăng nhập sai nhiều lần, vui lòng thử lại sau ${remaining} giây`,
      );
    }
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 }, lastFailedLoginAt: new Date() },
    });
    throw invalid;
  }

  if (user.failedLoginCount > 0) {
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lastFailedLoginAt: null },
    });
  }

  return issueSession(user.id, newFamilyId(), info);
}

/**
 * Xoay vòng refresh token. Nếu một token đã dùng rồi bị gửi lại thì coi như
 * bị đánh cắp: thu hồi cả chuỗi phiên đó (contract §3).
 */
export async function refresh(rawToken: string, info: SessionInfo): Promise<TokenPair> {
  const session = await prisma.refreshSession.findUnique({
    where: { tokenHash: hashRefreshToken(rawToken) },
  });

  const invalid = new AppError(401, "UNAUTHENTICATED", "Phiên đăng nhập không hợp lệ");
  if (!session) throw invalid;

  if (session.revokedAt !== null) {
    await prisma.refreshSession.updateMany({
      where: { familyId: session.familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "REUSE_DETECTED" },
    });
    throw new AppError(
      401,
      "UNAUTHENTICATED",
      "Phiên đăng nhập đã bị thu hồi vì phát hiện token dùng lại",
    );
  }

  if (session.expiresAt.getTime() <= Date.now()) throw invalid;

  await prisma.refreshSession.update({
    where: { id: session.id },
    data: { revokedAt: new Date(), revokedReason: "ROTATED", lastUsedAt: new Date() },
  });

  return issueSession(session.userId, session.familyId, info);
}

export async function logout(sessionId: string): Promise<void> {
  await prisma.refreshSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: "LOGOUT" },
  });
}

export async function changePassword(
  auth: AuthContext,
  input: ChangePasswordInput,
): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw new AppError(422, "VALIDATION_ERROR", "Mật khẩu hiện tại không đúng", [
      { field: "currentPassword", message: "Mật khẩu hiện tại không đúng" },
    ]);
  }

  if (await verifyPassword(input.newPassword, user.passwordHash)) {
    throw new AppError(422, "VALIDATION_ERROR", "Mật khẩu mới phải khác mật khẩu cũ", [
      { field: "newPassword", message: "Mật khẩu mới phải khác mật khẩu cũ" },
    ]);
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(input.newPassword), mustChangePassword: false },
    }),
    // Thu hồi mọi phiên khác, giữ lại phiên đang dùng để người dùng không bị đá ra.
    prisma.refreshSession.updateMany({
      where: { userId: user.id, revokedAt: null, id: { not: auth.sessionId } },
      data: { revokedAt: new Date(), revokedReason: "PASSWORD_CHANGED" },
    }),
  ]);
}

/** Dữ liệu cho GET /auth/me: người dùng, cửa hàng vào được, quyền từng nơi. */
export async function describeMe(auth: AuthContext) {
  const stores = auth.hasChainRole
    ? await prisma.store.findMany({ where: { isActive: true }, orderBy: { code: "asc" } })
    : await prisma.store.findMany({
        where: { isActive: true, id: { in: auth.assignedStoreIds } },
        orderBy: { code: "asc" },
      });

  return {
    user: {
      id: auth.userId,
      username: auth.username,
      fullName: auth.fullName,
      mustChangePassword: auth.mustChangePassword,
      defaultStoreId: auth.defaultStoreId,
    },
    chainPermissions: [...auth.chainPermissions].sort(),
    stores: stores.map((store) => ({
      id: store.id,
      code: store.code,
      name: store.name,
      permissions: [...auth.permissionsForStore(store.id)].sort(),
    })),
  };
}
