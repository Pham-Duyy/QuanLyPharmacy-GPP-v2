import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/app-error.js";
import { verifyPassword } from "../../lib/password.js";
import { generateSecret, otpauthUrl, verifyTotp } from "../../lib/totp.js";
import { decryptSecret, encryptSecret } from "../national-sync/nds-crypto.js";
import type { AuthContext } from "./auth.context.js";

/**
 * Xác thực hai lớp bằng mã TOTP (Phase 7, D31).
 *
 * - Khóa bí mật lưu đã mã hóa; mã dự phòng chỉ lưu HMAC.
 * - Đăng nhập hai bước: đúng mật khẩu thì nhận một "vé" ngắn hạn (5 phút),
 *   đổi vé + mã 6 số lấy phiên đăng nhập. Vé ký bằng khóa riêng, không dùng
 *   thay access token được.
 * - "Bắt buộc với Quản lý" là cài đặt toàn chuỗi; người có vai trò Quản lý
 *   chưa bật MFA thì chỉ dùng được hồ sơ, đổi mật khẩu và màn bật MFA.
 */

export const MFA_ISSUER = "Pharmacy GPP";
const CHALLENGE_TTL_SECONDS = 5 * 60;
const RECOVERY_CODE_COUNT = 10;
/** Bỏ chữ dễ nhầm (0/O, 1/I/L) để đọc chép tay không sai. */
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const POLICY_KEY = "mfaRequiredForManagers";
const MANAGER_ROLE = "admin";

const CHALLENGE_KEY = createHash("sha256").update(`${env.JWT_SECRET}:mfa-challenge`).digest();
const RECOVERY_KEY = createHash("sha256").update(`${env.JWT_SECRET}:mfa-recovery`).digest();

function hashRecoveryCode(code: string): string {
  const clean = code.replace(/[\s-]/g, "").toUpperCase();
  return createHmac("sha256", RECOVERY_KEY).update(clean).digest("hex");
}

function newRecoveryCode(): string {
  let code = "";
  for (let i = 0; i < 10; i++) code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

async function audit(action: string, actorId: string | null, userId: string) {
  await prisma.auditLog.create({
    data: { actorId, action, resourceType: "user", resourceId: userId },
  });
}

// ---------------------------------------------------------------------------
// Chính sách "bắt buộc với Quản lý"
// ---------------------------------------------------------------------------

let policyCache: { value: boolean; at: number } | null = null;

/** Đọc mỗi request nên giữ 30 giây trong bộ nhớ; lưu cài đặt thì xóa ngay. */
export async function managersMustUseMfa(): Promise<boolean> {
  if (policyCache && Date.now() - policyCache.at < 30_000) return policyCache.value;
  const row = await prisma.setting.findFirst({ where: { key: POLICY_KEY, storeId: null } });
  const value = row?.value === true;
  policyCache = { value, at: Date.now() };
  return value;
}

export async function setManagersMustUseMfa(
  value: boolean,
  actorId: string,
  requestId: string | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.setting.findFirst({ where: { key: POLICY_KEY, storeId: null } });
    const saved = existing
      ? await tx.setting.update({ where: { id: existing.id }, data: { value, updatedBy: actorId } })
      : await tx.setting.create({ data: { key: POLICY_KEY, value, updatedBy: actorId } });
    await tx.auditLog.create({
      data: {
        actorId,
        action: "SETTING_UPDATE",
        resourceType: "setting",
        resourceId: saved.id,
        requestId,
        before: { key: POLICY_KEY, value: existing?.value ?? false },
        after: { key: POLICY_KEY, value },
      },
    });
  });
  policyCache = null;
}

export function isManager(roleCodes: readonly string[]): boolean {
  return roleCodes.includes(MANAGER_ROLE);
}

// ---------------------------------------------------------------------------
// Bật, tắt, mã dự phòng
// ---------------------------------------------------------------------------

export async function status(auth: AuthContext) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: auth.userId },
    select: { mfaEnabledAt: true },
  });
  const left = await prisma.mfaRecoveryCode.count({
    where: { userId: auth.userId, usedAt: null },
  });
  return {
    enabled: user.mfaEnabledAt !== null,
    enabledAt: user.mfaEnabledAt,
    recoveryCodesLeft: user.mfaEnabledAt ? left : 0,
    required: auth.mfaRequired,
  };
}

/** Bước 1 khi bật: sinh khóa mới (chưa có hiệu lực) để quét mã QR. */
export async function beginSetup(auth: AuthContext) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
  if (user.mfaEnabledAt) throw AppError.invalidState("Xác thực hai lớp đang bật");
  const secret = generateSecret();
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaPendingSecretEnc: encryptSecret(secret) },
  });
  return { secret, otpauthUrl: otpauthUrl(secret, user.username, MFA_ISSUER) };
}

async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await prisma.$transaction([
    prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
    prisma.mfaRecoveryCode.createMany({
      data: codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })),
    }),
  ]);
  return codes;
}

/** Bước 2 khi bật: nhập đúng mã từ ứng dụng mới có hiệu lực; trả 10 mã dự phòng một lần duy nhất. */
export async function confirmSetup(auth: AuthContext, code: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
  if (user.mfaEnabledAt) throw AppError.invalidState("Xác thực hai lớp đang bật");
  const secret = user.mfaPendingSecretEnc ? decryptSecret(user.mfaPendingSecretEnc) : null;
  if (!secret) throw AppError.invalidState("Bấm bật xác thực hai lớp lại từ đầu để lấy mã QR mới");
  const step = verifyTotp(secret, code);
  if (step === null)
    throw AppError.validation(
      "Mã không đúng. Kiểm tra giờ trên điện thoại đã đúng chưa rồi nhập mã mới",
      [{ field: "code", message: "Mã không đúng" }],
    );
  await prisma.user.update({
    where: { id: user.id },
    data: {
      mfaSecretEnc: user.mfaPendingSecretEnc,
      mfaPendingSecretEnc: null,
      mfaEnabledAt: new Date(),
      mfaLastStep: BigInt(step),
    },
  });
  const recoveryCodes = await replaceRecoveryCodes(user.id);
  // Phiên khác (máy khác) đăng nhập khi chưa có MFA: bắt đăng nhập lại.
  await prisma.refreshSession.updateMany({
    where: { userId: user.id, revokedAt: null, id: { not: auth.sessionId } },
    data: { revokedAt: new Date(), revokedReason: "MFA_ENABLED" },
  });
  await audit("MFA_ENABLE", user.id, user.id);
  return { recoveryCodes };
}

/** Kiểm tra mã 6 số hoặc mã dự phòng; mã đúng thì đánh dấu đã dùng. */
async function consumeCode(
  user: { id: string; mfaSecretEnc: string | null; mfaLastStep: bigint | null },
  code: string,
): Promise<"totp" | "recovery" | null> {
  const clean = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(clean)) {
    const secret = user.mfaSecretEnc ? decryptSecret(user.mfaSecretEnc) : null;
    if (!secret) return null;
    const step = verifyTotp(secret, clean, {
      afterStep: user.mfaLastStep === null ? null : Number(user.mfaLastStep),
    });
    if (step === null) return null;
    // Điều kiện trên mfa_last_step: hai yêu cầu cùng mã gửi đồng thời chỉ một cái qua.
    const updated = await prisma.user.updateMany({
      where: {
        id: user.id,
        OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: BigInt(step) } }],
      },
      data: { mfaLastStep: BigInt(step) },
    });
    return updated.count === 1 ? "totp" : null;
  }
  const hash = hashRecoveryCode(clean);
  const candidates = await prisma.mfaRecoveryCode.findMany({
    where: { userId: user.id, usedAt: null },
  });
  const match = candidates.find((item) =>
    timingSafeEqual(Buffer.from(item.codeHash), Buffer.from(hash)),
  );
  if (!match) return null;
  const used = await prisma.mfaRecoveryCode.updateMany({
    where: { id: match.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  return used.count === 1 ? "recovery" : null;
}

async function requireValidCode(userId: string, code: string): Promise<"totp" | "recovery"> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.mfaEnabledAt) throw AppError.invalidState("Xác thực hai lớp chưa bật");
  const kind = await consumeCode(user, code);
  if (!kind)
    throw AppError.validation("Mã xác thực không đúng", [
      { field: "code", message: "Mã xác thực không đúng" },
    ]);
  return kind;
}

export async function disable(auth: AuthContext, input: { password: string; code: string }) {
  if (auth.mfaRequired && isManager(auth.roleCodes))
    throw AppError.invalidState(
      "Chủ nhà thuốc đang bắt buộc xác thực hai lớp với Quản lý, nên không tắt được",
    );
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
  if (!(await verifyPassword(input.password, user.passwordHash)))
    throw AppError.validation("Mật khẩu không đúng", [
      { field: "password", message: "Mật khẩu không đúng" },
    ]);
  await requireValidCode(user.id, input.code);
  await clearMfa(user.id);
  await audit("MFA_DISABLE", user.id, user.id);
}

export async function regenerateRecoveryCodes(auth: AuthContext, code: string) {
  await requireValidCode(auth.userId, code);
  const recoveryCodes = await replaceRecoveryCodes(auth.userId);
  await audit("MFA_RECOVERY_REGENERATE", auth.userId, auth.userId);
  return { recoveryCodes };
}

async function clearMfa(userId: string) {
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        mfaSecretEnc: null,
        mfaPendingSecretEnc: null,
        mfaEnabledAt: null,
        mfaLastStep: null,
      },
    }),
    prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
  ]);
}

/**
 * Quản lý đặt lại MFA cho nhân viên mất điện thoại và hết mã dự phòng. Thu hồi
 * mọi phiên của người đó; lần đăng nhập sau họ bật lại (bắt buộc nếu là Quản lý
 * và chính sách đang bật).
 */
export async function resetForUser(actorId: string, targetUserId: string): Promise<void> {
  if (actorId === targetUserId)
    throw AppError.validation(
      "Không tự đặt lại xác thực hai lớp của chính mình; dùng mã dự phòng hoặc nhờ quản lý khác",
    );
  await clearMfa(targetUserId);
  await prisma.refreshSession.updateMany({
    where: { userId: targetUserId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: "MFA_RESET" },
  });
  await audit("MFA_RESET", actorId, targetUserId);
}

// ---------------------------------------------------------------------------
// Đăng nhập hai bước
// ---------------------------------------------------------------------------

export function issueChallenge(userId: string): string {
  return jwt.sign({ purpose: "mfa" }, CHALLENGE_KEY, {
    subject: userId,
    expiresIn: CHALLENGE_TTL_SECONDS,
    algorithm: "HS256",
  });
}

export function readChallenge(token: string): string {
  try {
    const decoded = jwt.verify(token, CHALLENGE_KEY, { algorithms: ["HS256"] });
    if (typeof decoded === "string" || decoded["purpose"] !== "mfa" || !decoded.sub)
      throw new Error("sai loại vé");
    return decoded.sub;
  } catch {
    throw new AppError(
      401,
      "MFA_CHALLENGE_EXPIRED",
      "Phiên xác thực đã hết hạn, hãy đăng nhập lại từ đầu",
    );
  }
}

/** Bước 2 khi đăng nhập. Sai mã tính như sai mật khẩu (cùng bộ đếm, cùng thời gian chờ). */
export async function verifyLoginCode(userId: string, code: string): Promise<"totp" | "recovery"> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.isActive || !user.mfaEnabledAt)
    throw new AppError(401, "UNAUTHENTICATED", "Phiên xác thực không hợp lệ");
  const kind = await consumeCode(user, code);
  if (!kind) {
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 }, lastFailedLoginAt: new Date() },
    });
    throw new AppError(401, "MFA_INVALID_CODE", "Mã xác thực không đúng");
  }
  if (kind === "recovery") await audit("MFA_RECOVERY_USED", user.id, user.id);
  return kind;
}
