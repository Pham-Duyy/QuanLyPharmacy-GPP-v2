import type { CustomerSegment } from "../../api/types.js";

export const GENDER: Record<string, string> = { MALE: "Nam", FEMALE: "Nữ", OTHER: "Khác" };

export const SEGMENT: Record<CustomerSegment, { label: string; tone: string }> = {
  LOYAL: { label: "Thân thiết", tone: "green" },
  NEW: { label: "Khách mới", tone: "blue" },
  DORMANT: { label: "Lâu chưa quay lại", tone: "orange" },
  REGULAR: { label: "Khách thường", tone: "slate" },
};

/** Chữ viết tắt trên avatar: chữ đầu của hai từ cuối trong họ tên Việt ("Nguyễn Thị Mai" → "TM"). */
export function initials(fullName: string | null): string {
  const words = (fullName ?? "").trim().split(/\s+/).filter((word) => /^\p{L}/u.test(word));
  if (words.length === 0) return "?";
  const picked = words.length === 1 ? words : words.slice(-2);
  return picked.map((word) => word[0]!.toUpperCase()).join("");
}

const AVATAR_TONES = ["blue", "teal", "purple", "orange", "cyan", "green"];

/** Màu avatar cố định theo mã khách để cùng một khách luôn cùng màu. */
export function avatarTone(code: string): string {
  let hash = 0;
  for (const char of code) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length]!;
}

const vnd = new Intl.NumberFormat("vi-VN");
export const money = (value: number) => `${vnd.format(value)} đ`;
