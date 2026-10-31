import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.js";
import { AppError } from "./app-error.js";

/**
 * Gửi email qua máy chủ thư SMTP của nhà thuốc (Phase 7, D32). Chưa cấu hình
 * SMTP_HOST thì chức năng gửi email tắt, phần mềm vẫn in / tải Excel được.
 */

export type MailAttachment = { filename: string; content: Buffer; contentType?: string };
export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: MailAttachment[];
};

let transporter: Transporter | null = null;
/** Test thay bằng transport giả để không gửi thư thật. */
let override: Transporter | null = null;

export function setMailTransportForTests(fake: Transporter | null): void {
  override = fake;
}

export function isMailConfigured(): boolean {
  return override !== null || Boolean(env.SMTP_HOST);
}

export function mailFrom(): string | null {
  return env.SMTP_FROM ?? env.SMTP_USER ?? (override ? "test@example.com" : null);
}

function transport(): Transporter {
  if (override) return override;
  if (!env.SMTP_HOST)
    throw new AppError(
      409,
      "MAIL_NOT_CONFIGURED",
      "Chưa cấu hình máy chủ thư (SMTP) nên chưa gửi email được; hãy in hoặc tải Excel để tự gửi",
    );
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" } : undefined,
    // Nội dung do phần mềm dựng; không cho thư viện tự đọc tệp hay tải URL.
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return transporter;
}

export async function sendMail(message: MailMessage): Promise<{ messageId: string }> {
  const sender = transport();
  try {
    const info = await sender.sendMail({
      from: mailFrom() ?? undefined,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments,
    });
    return { messageId: String(info.messageId ?? "") };
  } catch (error) {
    throw new AppError(
      502,
      "MAIL_SEND_FAILED",
      `Không gửi được email: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
