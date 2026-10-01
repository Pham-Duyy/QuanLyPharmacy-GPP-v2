import { formatVnd } from "../../api/types.js";

/** Tiền dùng chung toàn phân mục: cùng định dạng với phần còn lại của ứng dụng. */
export const money = (value: number | null | undefined): string => formatVnd(value ?? null);

/** Phần trăm làm tròn số nguyên, "—" khi không có mẫu số. */
export function percent(part: number, whole: number): string {
  if (!whole) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

/** Hai chữ cái đầu của hai từ cuối trong họ tên Việt: "Trần Minh Anh" → "MA". */
export function initials(fullName: string): string {
  // Bỏ phần trong ngoặc ("(demo)") và từ không bắt đầu bằng chữ cái.
  const words = fullName
    .replace(/\([^)]*\)/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => /^\p{L}/u.test(word));
  if (words.length === 0) return "?";
  return words
    .slice(-2)
    .map((word) => word[0]!.toLocaleUpperCase("vi"))
    .join("");
}

const AVATAR_TONES = ["blue", "green", "purple", "orange", "cyan"] as const;
export type AvatarTone = (typeof AVATAR_TONES)[number];

/** Màu avatar cố định theo khóa (id), để cùng một người luôn cùng màu. */
export function avatarTone(key: string): AvatarTone {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length]!;
}
