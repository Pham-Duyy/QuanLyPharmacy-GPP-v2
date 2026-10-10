import type { IncomingMessage, ServerResponse } from "node:http";
import type { DestinationStream } from "pino";
import { pinoHttp } from "pino-http";

/**
 * Log mọi request HTTP. Không ghi token hay cookie phiên: ai đọc được log sẽ
 * đăng nhập thay được người khác (access token ở Authorization, refresh token
 * ở Cookie và Set-Cookie). `stream` chỉ dùng trong test để đọc lại dòng log.
 */
export function httpLogger(
  options: { level: string; pretty: boolean },
  stream?: DestinationStream,
) {
  return pinoHttp(
    {
      level: options.level,
      // Dùng lại requestId đã gắn ở middleware trước để log và response khớp nhau.
      genReqId: (_req: IncomingMessage, res: ServerResponse) =>
        String((res as { locals?: { requestId?: string } }).locals?.requestId ?? ""),
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
        censor: "[đã che]",
      },
      ...(options.pretty
        ? {
            transport: {
              target: "pino-pretty",
              options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
            },
          }
        : {}),
    },
    stream,
  );
}
