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

/** Tên vai trò ngắn cho bảng; hồ sơ vẫn hiện tên đầy đủ. Vai trò lạ giữ nguyên tên. */
const ROLE_SHORT: Record<string, string> = {
  admin: "Quản lý",
  pharmacist: "Dược sĩ",
  warehouse_staff: "Kho",
  auditor: "Kiểm toán",
};

export function roleLabel(code: string, name?: string): string {
  return ROLE_SHORT[code] ?? name ?? code;
}
