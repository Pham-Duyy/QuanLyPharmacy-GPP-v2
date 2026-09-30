import type { ReactNode } from "react";
import { PAGES, type PageDef, type PagePath } from "./pages.js";
import { SIDEBAR } from "./sidebar.js";

/**
 * Logic điều hướng không phụ thuộc giao diện: ai mở được trang nào, trang
 * đang mở thuộc mục sidebar nào, người dùng bắt đầu từ đâu. Tách riêng để
 * kiểm thử được mà không phải dựng cả ứng dụng.
 */

export type Can = (permission: string) => boolean;

const BY_PATH = new Map<string, PageDef>(PAGES.map((page) => [page.path, page]));

export function findPage(path: string): PageDef | undefined {
  return BY_PATH.get(path);
}

/**
 * Trang ứng với đường dẫn đang mở, kể cả đường dẫn con: khớp dài nhất thắng,
 * để "/san-pham/123" vẫn thuộc Sản phẩm. Khớp theo từng đoạn chứ không theo
 * tiền tố chuỗi, nên "/tra-hang-ncc" không bị nhận nhầm là "/tra-hang".
 */
export function pageForPathname(pathname: string): PageDef | undefined {
  let best: PageDef | undefined;
  for (const page of PAGES) {
    const matches = pathname === page.path || pathname.startsWith(`${page.path}/`);
    if (matches && (!best || page.path.length > best.path.length)) best = page;
  }
  return best;
}

export function isAllowed(page: Pick<PageDef, "permission">, can: Can): boolean {
  return typeof page.permission === "string" ? can(page.permission) : page.permission.some(can);
}

export type PageAccess = "allowed" | "forbidden" | "unregistered";

/**
 * Quyết định cho lớp Guard. Trang **chưa đăng ký thì từ chối**: lỡ thêm route
 * mà quên đăng ký là bị chặn ngay khi thử, chứ không âm thầm mở cho mọi người.
 */
export function pageAccess(path: string, can: Can): PageAccess {
  const page = findPage(path);
  if (!page) return "unregistered";
  return isAllowed(page, can) ? "allowed" : "forbidden";
}

/** Trang được phép mở, theo thứ tự đăng ký — dùng cho Ctrl+K. */
export function allowedPages(can: Can): PageDef[] {
  return PAGES.filter((page) => isAllowed(page, can));
}

export type VisibleEntry =
  | { kind: "page"; page: PageDef }
  | { kind: "group"; key: string; label: string; icon: ReactNode; pages: PageDef[]; divided: boolean };

/** Sidebar sau khi lọc quyền: bỏ trang không được mở, bỏ luôn nhóm không còn trang nào. */
export function visibleSidebar(can: Can): VisibleEntry[] {
  const out: VisibleEntry[] = [];
  for (const entry of SIDEBAR) {
    if (entry.kind === "page") {
      const page = findPage(entry.path);
      if (page && isAllowed(page, can)) out.push({ kind: "page", page });
      continue;
    }
    const pages = entry.paths
      .map((path) => findPage(path))
      .filter((page): page is PageDef => page !== undefined && isAllowed(page, can));
    if (pages.length > 0) {
      out.push({ kind: "group", key: entry.key, label: entry.label, icon: entry.icon, pages, divided: entry.divided ?? false });
    }
  }
  return out;
}

export type ActiveNav = {
  /** Mục sidebar được đánh dấu; trang công cụ thì là mục chủ của nó. */
  selectedPath: string | null;
  /** Nhóm chứa mục đó, `null` nếu mục nằm ở cấp đầu. */
  groupKey: string | null;
};

export function activeNav(pathname: string): ActiveNav {
  const page = pageForPathname(pathname);
  if (!page) return { selectedPath: null, groupKey: null };
  const target = page.navTarget ?? page.path;
  for (const entry of SIDEBAR) {
    if (entry.kind === "page" && entry.path === target) return { selectedPath: target, groupKey: null };
    if (entry.kind === "group" && (entry.paths as readonly string[]).includes(target)) {
      return { selectedPath: target, groupKey: entry.key };
    }
  }
  return { selectedPath: null, groupKey: null };
}

/**
 * Trang bắt đầu theo vai trò, xét theo thứ tự ưu tiên: người quản lý và kiểm
 * toán cần nhìn tổng thể trước; nhân viên kho làm việc với tồn; dược sĩ và
 * nhân viên bán hàng đứng quầy.
 */
const START_RULES: ReadonlyArray<{ roles: readonly string[]; path: PagePath }> = [
  { roles: ["admin", "auditor"], path: "/tai-khoan" },
  { roles: ["warehouse_staff"], path: "/ton-kho" },
  { roles: ["pharmacist"], path: "/ban-hang" },
];

export type RoleAssignment = { code: string; storeId: string | null };

export function startPageFor(roles: readonly RoleAssignment[], storeId: string | null, can: Can): string | null {
  // Chỉ vai trò toàn chuỗi hoặc tại cửa hàng đang chọn mới có hiệu lực.
  const active = new Set(roles.filter((role) => role.storeId === null || role.storeId === storeId).map((role) => role.code));

  for (const rule of START_RULES) {
    if (!rule.roles.some((code) => active.has(code))) continue;
    // Luôn kiểm quyền trang đích: vai trò có thể đã bị bớt quyền.
    if (pageAccess(rule.path, can) === "allowed") return rule.path;
  }

  // Dự phòng: mục sidebar đầu tiên được phép, rồi tới bất kỳ trang được phép nào.
  for (const entry of visibleSidebar(can)) {
    return entry.kind === "page" ? entry.page.path : entry.pages[0]!.path;
  }
  return allowedPages(can)[0]?.path ?? null;
}
