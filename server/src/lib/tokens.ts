import { createHash, randomBytes, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

/** Access token sống ngắn, Frontend chỉ giữ trong bộ nhớ (contract §3, P1). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Refresh token hết hạn sau 7 ngày không hoạt động. */
export const REFRESH_TOKEN_TTL_DAYS = 7;

export const REFRESH_COOKIE_NAME = "gpp_refresh";

export type AccessTokenPayload = {
  sub: string;
  sid: string;
};

export function signAccessToken(userId: string, sessionId: string): string {
  return jwt.sign({ sid: sessionId } satisfies Omit<AccessTokenPayload, "sub">, env.JWT_SECRET, {
    subject: userId,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    algorithm: "HS256",
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] });
  if (typeof decoded === "string" || typeof decoded.sub !== "string") {
    throw new Error("Access token không hợp lệ");
  }
  return { sub: decoded.sub, sid: String((decoded as { sid?: unknown }).sid ?? "") };
}

/**
 * Refresh token là chuỗi ngẫu nhiên, KHÔNG phải JWT.
 * CSDL chỉ lưu bản băm SHA-256, nên rò rỉ CSDL không dùng lại được token.
 */
export function createRefreshToken(): { token: string; tokenHash: string } {
  const token = randomBytes(48).toString("base64url");
  return { token, tokenHash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newFamilyId(): string {
  return randomUUID();
}

export function refreshExpiryDate(from = new Date()): Date {
  return new Date(from.getTime() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}
