import { Router } from "express";
import { AppError } from "../../lib/app-error.js";
import { parseOrThrow } from "../../lib/validate.js";
import { sendData } from "../../lib/respond.js";
import { isProduction } from "../../config/env.js";
import { REFRESH_COOKIE_NAME } from "../../lib/tokens.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { changePasswordSchema, loginSchema } from "./auth.schema.js";
import * as authService from "./auth.service.js";
import type { TokenPair } from "./auth.service.js";
import type { Response } from "express";

export const authRouter = Router();

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
  const tokens = await authService.login(input, {
    ip: req.ip,
    userAgent: req.header("User-Agent"),
  });

  setRefreshCookie(res, tokens);
  sendData(res, tokenResponse(tokens));
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

authRouter.post("/auth/logout", authenticate, async (req, res) => {
  await authService.logout(req.auth!.sessionId);
  res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/v1/auth" });
  sendData(res, { loggedOut: true });
});

authRouter.get("/auth/me", authenticate, async (req, res) => {
  sendData(res, await authService.describeMe(req.auth!));
});

authRouter.post("/auth/change-password", authenticate, async (req, res) => {
  const input = parseOrThrow(changePasswordSchema, req.body);
  await authService.changePassword(req.auth!, input);
  sendData(res, { changed: true });
});
