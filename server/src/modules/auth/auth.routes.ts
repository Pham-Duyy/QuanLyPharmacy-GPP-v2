import { Router } from "express";
import { AppError } from "../../lib/app-error.js";
import { parseOrThrow } from "../../lib/validate.js";
import { sendData } from "../../lib/respond.js";
import { isProduction } from "../../config/env.js";
import { REFRESH_COOKIE_NAME } from "../../lib/tokens.js";
import { authenticate, authenticateAllowingTempPassword } from "../../middlewares/authenticate.js";
import {
  changePasswordSchema,
  loginSchema,
  mfaCodeSchema,
  mfaDisableSchema,
  mfaLoginSchema,
  mfaPolicySchema,
} from "./auth.schema.js";
import * as mfa from "./mfa.service.js";
import * as authService from "./auth.service.js";
import { createLoginGuard } from "./login-guard.js";
import type { TokenPair } from "./auth.service.js";
import type { Response } from "express";

export const authRouter = Router();
const loginGuard = createLoginGuard();

/** Refresh token nằm trong cookie HttpOnly, không bao giờ lộ ra JavaScript (contract §3). */
function setRefreshCookie(res: Response, tokens: TokenPair): void {
  res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    path: "/api/v1/auth",
    expires: tokens.refreshExpiresAt,
  });
}

function tokenResponse(tokens: TokenPair) {
  return { accessToken: tokens.accessToken, expiresInSeconds: tokens.expiresInSeconds };
}

authRouter.post("/auth/login", async (req, res) => {
  const input = parseOrThrow(loginSchema, req.body);
  const ip = req.ip ?? "unknown";
  loginGuard.assertAllowed(ip);
  let result: authService.LoginResult;
  try {
    result = await authService.login(input, { ip, userAgent: req.header("User-Agent") });
  } catch (error) {
    if (error instanceof AppError && error.status === 401) loginGuard.recordFailure(ip);
    throw error;
  }

  // Đã bật MFA: chưa cấp phiên, trả vé để nhập mã ở bước hai.
  if (result.kind === "mfa") {
    sendData(res, { mfaRequired: true, mfaToken: result.challenge });
    return;
  }
  setRefreshCookie(res, result.tokens);
  sendData(res, tokenResponse(result.tokens));
});

/** Bước hai khi đăng nhập có xác thực hai lớp (Phase 7, D31). */
authRouter.post("/auth/login/mfa", async (req, res) => {
  const input = parseOrThrow(mfaLoginSchema, req.body);
  const ip = req.ip ?? "unknown";
  loginGuard.assertAllowed(ip);
  let result;
  try {
    result = await authService.loginWithMfa(input, { ip, userAgent: req.header("User-Agent") });
  } catch (error) {
    if (error instanceof AppError && error.status === 401) loginGuard.recordFailure(ip);
    throw error;
  }
  setRefreshCookie(res, result.tokens);
  sendData(res, { ...tokenResponse(result.tokens), usedRecoveryCode: result.usedRecoveryCode });
});

// --- Xác thực hai lớp của chính mình. Dùng được cả khi đang bị bắt bật MFA. ---

authRouter.get("/auth/mfa", authenticateAllowingTempPassword, async (req, res) => {
  sendData(res, await mfa.status(req.auth!));
});

authRouter.post("/auth/mfa/setup", authenticateAllowingTempPassword, async (req, res) => {
  sendData(res, await mfa.beginSetup(req.auth!));
});

authRouter.post("/auth/mfa/enable", authenticateAllowingTempPassword, async (req, res) => {
  const { code } = parseOrThrow(mfaCodeSchema, req.body);
  sendData(res, await mfa.confirmSetup(req.auth!, code));
});

authRouter.post("/auth/mfa/disable", authenticateAllowingTempPassword, async (req, res) => {
  const input = parseOrThrow(mfaDisableSchema, req.body);
  await mfa.disable(req.auth!, input);
  sendData(res, { disabled: true });
});

authRouter.post("/auth/mfa/recovery-codes", authenticate, async (req, res) => {
  const { code } = parseOrThrow(mfaCodeSchema, req.body);
  sendData(res, await mfa.regenerateRecoveryCodes(req.auth!, code));
});

// --- Chính sách bắt buộc MFA với Quản lý: cài đặt toàn chuỗi. ---

authRouter.get("/security/mfa-policy", authenticate, async (_req, res) => {
  sendData(res, { requiredForManagers: await mfa.managersMustUseMfa() });
});

authRouter.put("/security/mfa-policy", authenticate, async (req, res) => {
  if (!req.auth!.chainPermissions.has("settings.manage"))
    throw new AppError(403, "FORBIDDEN", "Chỉ quản lý toàn chuỗi mới đổi được chính sách này");
  const input = parseOrThrow(mfaPolicySchema, req.body);
  await mfa.setManagersMustUseMfa(
    input.requiredForManagers,
    req.auth!.userId,
    (res.locals["requestId"] as string | undefined) ?? null,
  );
  sendData(res, { requiredForManagers: input.requiredForManagers });
});

authRouter.post("/auth/refresh", async (req, res) => {
  const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME];
  if (!raw) {
    throw new AppError(401, "UNAUTHENTICATED", "Không tìm thấy refresh token");
  }

  const tokens = await authService.refresh(raw, {
    ip: req.ip,
    userAgent: req.header("User-Agent"),
  });

  setRefreshCookie(res, tokens);
  sendData(res, tokenResponse(tokens));
});

authRouter.post("/auth/logout", authenticateAllowingTempPassword, async (req, res) => {
  await authService.logout(req.auth!.sessionId);
  res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/v1/auth" });
  sendData(res, { loggedOut: true });
});

authRouter.get("/auth/me", authenticateAllowingTempPassword, async (req, res) => {
  sendData(res, await authService.describeMe(req.auth!));
});

authRouter.post("/auth/change-password", authenticateAllowingTempPassword, async (req, res) => {
  const input = parseOrThrow(changePasswordSchema, req.body);
  await authService.changePassword(req.auth!, input);
  sendData(res, { changed: true });
});
