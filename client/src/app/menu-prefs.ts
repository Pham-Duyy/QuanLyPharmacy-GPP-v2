/**
 * Tùy chọn menu ghi nhớ **theo từng tài khoản**.
 *
 * Máy ở quầy thường dùng chung cho nhiều ca: lưu một khóa chung thì người sau
 * nhận luôn cách bày menu của người trước. Khóa gắn với mã người dùng, và
 * hai khóa dùng chung của bản cũ bị dọn đi.
 */
export type MenuPrefs = {
  collapsed: boolean;
  /** Nhóm đang mở; mỗi lúc tối đa một nhóm. */
  openGroup: string | null;
};

export const DEFAULT_MENU_PREFS: MenuPrefs = { collapsed: false, openGroup: null };

const PREFIX = "gpp.menu.";
const LEGACY_KEYS = ["gpp.sider.collapsed", "gpp.sider.groups"];

type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** localStorage có thể bị chặn (chế độ riêng tư, chính sách máy): khi đó menu vẫn chạy, chỉ không nhớ. */
function defaultStore(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function menuPrefsKey(userId: string): string {
  return `${PREFIX}${userId}`;
}

export function readMenuPrefs(userId: string, store: KeyValueStore | null = defaultStore()): MenuPrefs {
  if (!store) return DEFAULT_MENU_PREFS;
  try {
    const raw = store.getItem(menuPrefsKey(userId));
    if (!raw) return DEFAULT_MENU_PREFS;
    const parsed = JSON.parse(raw) as Partial<MenuPrefs> | null;
    return {
      collapsed: parsed?.collapsed === true,
      openGroup: typeof parsed?.openGroup === "string" ? parsed.openGroup : null,
    };
  } catch {
    return DEFAULT_MENU_PREFS;
  }
}

export function writeMenuPrefs(userId: string, prefs: MenuPrefs, store: KeyValueStore | null = defaultStore()): void {
  if (!store) return;
  try {
    store.setItem(menuPrefsKey(userId), JSON.stringify(prefs));
  } catch {
    // Hết dung lượng hoặc bị chặn: vẫn dùng được trong phiên hiện tại.
  }
}

/** Xóa hai khóa dùng chung của bản trước, để không tài khoản nào nhận nhầm. */
export function dropLegacyMenuPrefs(store: KeyValueStore | null = defaultStore()): void {
  if (!store) return;
  for (const key of LEGACY_KEYS) {
    try {
      store.removeItem(key);
    } catch {
      // Bỏ qua: không xóa được thì chỉ còn sót một khóa không ai đọc tới.
    }
  }
}

/** Nhóm đã lưu nhưng tài khoản không còn quyền thấy (đổi cửa hàng, bị bớt quyền) thì coi như chưa mở. */
export function sanitizeOpenGroup(openGroup: string | null, visibleGroupKeys: readonly string[]): string | null {
  return openGroup !== null && visibleGroupKeys.includes(openGroup) ? openGroup : null;
}
