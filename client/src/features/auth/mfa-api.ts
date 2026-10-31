import { http } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";

/** Xác thực hai lớp (Phase 7, D31). */

export type MfaStatus = {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
  required: boolean;
};

export const mfaApi = {
  status: async () => (await http.get<Envelope<MfaStatus>>("/auth/mfa")).data.data,
  setup: async () =>
    (await http.post<Envelope<{ secret: string; otpauthUrl: string }>>("/auth/mfa/setup")).data
      .data,
  enable: async (code: string) =>
    (await http.post<Envelope<{ recoveryCodes: string[] }>>("/auth/mfa/enable", { code })).data.data
      .recoveryCodes,
  disable: async (password: string, code: string) => {
    await http.post("/auth/mfa/disable", { password, code });
  },
  regenerate: async (code: string) =>
    (await http.post<Envelope<{ recoveryCodes: string[] }>>("/auth/mfa/recovery-codes", { code }))
      .data.data.recoveryCodes,
  policy: async () =>
    (await http.get<Envelope<{ requiredForManagers: boolean }>>("/security/mfa-policy")).data.data
      .requiredForManagers,
  setPolicy: async (requiredForManagers: boolean) => {
    await http.put("/security/mfa-policy", { requiredForManagers });
  },
  resetForUser: async (userId: string) => {
    await http.post(`/users/${userId}/mfa/reset`);
  },
};

/** Khóa bí mật chia nhóm 4 ký tự để gõ tay vào ứng dụng xác thực cho dễ. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

/** Nội dung tệp lưu mã dự phòng. */
export function recoveryCodesText(username: string, codes: string[], at = new Date()): string {
  return [
    `Pharmacy GPP - Mã dự phòng xác thực hai lớp của ${username}`,
    `Tạo lúc: ${at.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`,
    "Mỗi mã dùng được một lần khi không có điện thoại. Cất nơi an toàn, không chụp gửi qua mạng.",
    "",
    ...codes.map((code, index) => `${String(index + 1).padStart(2, " ")}. ${code}`),
    "",
  ].join("\n");
}
