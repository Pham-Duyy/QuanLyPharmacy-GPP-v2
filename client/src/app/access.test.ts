import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
// Ma trận vai trò → quyền THẬT của server, không chép tay: đổi quyền ở server
// mà quên tính lại trang bắt đầu hay menu thì test này đỏ.
import { ROLES } from "../../../server/src/config/permissions.js";
import { activeNav, allowedPages, findPage, pageAccess, startPageFor, visibleSidebar, type Can } from "./access.js";
import { DEFAULT_MENU_PREFS, dropLegacyMenuPrefs, menuPrefsKey, readMenuPrefs, sanitizeOpenGroup, writeMenuPrefs } from "./menu-prefs.js";
import { PAGE_ELEMENTS } from "./page-elements.js";
import { PAGES } from "./pages.js";
import { SIDEBAR } from "./sidebar.js";

function canFor(...roleCodes: string[]): Can {
  const granted = new Set(ROLES.filter((role) => roleCodes.includes(role.code)).flatMap((role) => role.permissions));
  return (permission) => granted.has(permission);
}

const ALL: Can = () => true;
const NONE: Can = () => false;

function iconType(node: unknown): unknown {
  return isValidElement(node) ? node.type : node;
}

describe("danh sách đăng ký trang", () => {
  it("mỗi đường dẫn chỉ đăng ký một lần", () => {
    const paths = PAGES.map((page) => page.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("route của ứng dụng khớp đúng danh sách đăng ký, không thiếu không thừa", () => {
    expect(Object.keys(PAGE_ELEMENTS).sort()).toEqual(PAGES.map((page) => page.path).sort());
  });

  it("mọi mục trên sidebar đều là trang đã đăng ký", () => {
    const sidebarPaths = SIDEBAR.flatMap((entry) => (entry.kind === "page" ? [entry.path] : [...entry.paths]));
    for (const path of sidebarPaths) expect(findPage(path), path).toBeDefined();
  });

  it("trang không nằm trên sidebar vẫn chỉ tới một mục sidebar để đánh dấu", () => {
    const sidebarPaths = new Set(SIDEBAR.flatMap((entry) => (entry.kind === "page" ? [entry.path] : [...entry.paths])));
    for (const page of PAGES) {
      const target = "navTarget" in page ? page.navTarget : page.path;
      expect(sidebarPaths.has(target), `${page.path} → ${target}`).toBe(true);
    }
  });

  it("mỗi trang một biểu tượng riêng, nhóm không mượn biểu tượng của trang", () => {
    const pageIcons = PAGES.map((page) => iconType(page.icon));
    expect(new Set(pageIcons).size).toBe(pageIcons.length);
    for (const entry of SIDEBAR) {
      if (entry.kind === "group") expect(pageIcons).not.toContain(iconType(entry.icon));
    }
  });

  it("cấp đầu tối đa 9 mục, mỗi nhóm tối đa 6 trang", () => {
    expect(SIDEBAR.length).toBeLessThanOrEqual(9);
    for (const entry of SIDEBAR) if (entry.kind === "group") expect(entry.paths.length).toBeLessThanOrEqual(6);
  });

  it("Quầy bán ở cấp đầu: mở bằng một lần bấm", () => {
    expect(SIDEBAR).toContainEqual({ kind: "page", path: "/ban-hang" });
  });
});

describe("quyền mở trang", () => {
  it("quản lý thuần không vào quầy, quản lý kiêm dược sĩ được vào", () => {
    expect(pageAccess("/ban-hang", canFor("admin"))).toBe("forbidden");
    expect(pageAccess("/ban-hang", canFor("admin", "pharmacist"))).toBe("allowed");
    expect(
      visibleSidebar(canFor("admin")).some(
        (entry) => entry.kind === "page" && entry.page.path === "/ban-hang",
      ),
    ).toBe(false);
  });

  it("chỉ còn bốn vai trò và vai trò bán hàng cũ không được cấp quyền", () => {
    expect(ROLES.map((role) => role.code).sort()).toEqual([
      "admin",
      "auditor",
      "pharmacist",
      "warehouse_staff",
    ]);
    expect(allowedPages(canFor("sales_staff"))).toEqual([]);
  });

  it("trang chưa đăng ký bị từ chối, kể cả với người có mọi quyền", () => {
    expect(pageAccess("/trang-khong-ton-tai", ALL)).toBe("unregistered");
  });

  it("thiếu quyền thì từ chối, đủ quyền thì cho mở", () => {
    expect(pageAccess("/nhan-vien", canFor("pharmacist"))).toBe("forbidden");
    expect(pageAccess("/nhan-vien", canFor("admin"))).toBe("allowed");
  });

  it("trang nhận nhiều quyền thì có một trong số đó là đủ", () => {
    // Điều chỉnh tồn: người lập hoặc người duyệt đều mở được.
    expect(pageAccess("/dieu-chinh-ton", canFor("warehouse_staff"))).toBe("allowed");
    expect(pageAccess("/dieu-chinh-ton", canFor("auditor"))).toBe("forbidden");
  });

  it("công cụ đã rời sidebar vẫn giữ quyền riêng", () => {
    // Quản lý ảnh cần catalog.manage: dược sĩ có, nhân viên kho chỉ có catalog.read.
    expect(pageAccess("/anh-san-pham", canFor("warehouse_staff"))).toBe("forbidden");
    expect(pageAccess("/anh-san-pham", canFor("pharmacist"))).toBe("allowed");
    expect(pageAccess("/in-tem", canFor("pharmacist"))).toBe("allowed");
  });

  it("Ctrl+K tìm được công cụ không nằm trên sidebar nếu có quyền", () => {
    const paths = allowedPages(canFor("pharmacist")).map((page) => page.path);
    expect(paths).toContain("/anh-san-pham");
    expect(paths).toContain("/danh-muc");
    expect(allowedPages(canFor("warehouse_staff")).map((page) => page.path)).not.toContain("/anh-san-pham");
  });

  it("không có quyền nào thì không thấy trang nào", () => {
    expect(allowedPages(NONE)).toEqual([]);
    expect(visibleSidebar(NONE)).toEqual([]);
  });
});

describe("sidebar theo quyền", () => {
  it("nhóm không còn trang nào thì ẩn hẳn, nhóm còn trang thì chỉ hiện trang được phép", () => {
    const entries = visibleSidebar(canFor("pharmacist"));
    const keys = entries.map((entry) => (entry.kind === "page" ? entry.page.path : entry.key));
    // Dược sĩ thấy hồ sơ GPP nhưng không có report.sales.
    expect(keys).toContain("gpp");
    expect(keys).not.toContain("/bao-cao");
    expect(keys).toContain("/ban-hang");

    const purchasing = entries.find((entry) => entry.kind === "group" && entry.key === "purchasing");
    const purchasingPaths = purchasing?.kind === "group" ? purchasing.pages.map((page) => page.path) : [];
    // Có stock.read và catalog.read nên thấy Đề xuất đặt hàng và Nhà cung cấp, dược sĩ còn xem được Phiếu nhập và Trả nhà cung cấp.
    expect(purchasingPaths).toEqual(["/phieu-nhap", "/de-xuat-dat-hang", "/tra-hang-ncc", "/nha-cung-cap"]);
  });

  it("nhóm Quản trị của dược sĩ chỉ còn Nhập / xuất Excel", () => {
    // Hệ quả của việc giữ nguyên quyền trang Excel (ai có catalog.read cũng mở được).
    const admin = visibleSidebar(canFor("pharmacist")).find((entry) => entry.kind === "group" && entry.key === "admin");
    expect(admin?.kind === "group" ? admin.pages.map((page) => page.path) : []).toEqual(["/excel"]);
  });

  it("người đủ quyền thấy 9 mục cấp đầu", () => {
    expect(visibleSidebar(ALL)).toHaveLength(9);
  });
});

describe("đánh dấu mục đang mở", () => {
  it.each([
    ["/ban-hang", "/ban-hang", null],
    ["/san-pham", "/san-pham", "goods"],
    ["/san-pham/abc", "/san-pham", "goods"],
    // Công cụ không nằm trên sidebar: sáng mục chủ, mở đúng nhóm.
    ["/in-tem", "/san-pham", "goods"],
    ["/anh-san-pham", "/san-pham", "goods"],
    ["/danh-muc", "/san-pham", "goods"],
    ["/canh-bao", "/ton-kho", "goods"],
    ["/excel", "/excel", "admin"],
    // "/tra-hang-ncc" bắt đầu bằng "/tra-hang" nhưng là trang khác, thuộc nhóm khác.
    ["/tra-hang-ncc", "/tra-hang-ncc", "purchasing"],
    ["/tra-hang", "/tra-hang", "sales"],
  ])("%s → mục %s, nhóm %s", (pathname, selectedPath, groupKey) => {
    expect(activeNav(pathname)).toEqual({ selectedPath, groupKey });
  });

  it("đường dẫn lạ không đánh dấu gì", () => {
    expect(activeNav("/khong-co")).toEqual({ selectedPath: null, groupKey: null });
  });
});

describe("trang bắt đầu theo vai trò", () => {
  const NT01 = "store-1";
  const NT02 = "store-2";

  it.each([
    ["admin", "/tai-khoan"],
    ["auditor", "/tai-khoan"],
    ["warehouse_staff", "/ton-kho"],
    ["pharmacist", "/ban-hang"],
  ])("%s → %s", (role, expected) => {
    expect(startPageFor([{ code: role, storeId: NT01 }], NT01, canFor(role))).toBe(expected);
  });

  it("nhiều vai trò thì theo thứ tự ưu tiên: kho đứng trước quầy bán", () => {
    const roles = [
      { code: "pharmacist", storeId: NT01 },
      { code: "warehouse_staff", storeId: NT01 },
    ];
    expect(startPageFor(roles, NT01, canFor("pharmacist", "warehouse_staff"))).toBe("/ton-kho");
  });

  it("chỉ xét vai trò toàn chuỗi hoặc tại cửa hàng đang chọn", () => {
    const roles = [
      { code: "warehouse_staff", storeId: NT01 },
      { code: "pharmacist", storeId: NT02 },
    ];
    expect(startPageFor(roles, NT01, canFor("warehouse_staff"))).toBe("/ton-kho");
    expect(startPageFor(roles, NT02, canFor("pharmacist"))).toBe("/ban-hang");
  });

  it("vai trò toàn chuỗi có hiệu lực ở mọi cửa hàng", () => {
    expect(startPageFor([{ code: "admin", storeId: null }], NT02, canFor("admin"))).toBe("/tai-khoan");
  });

  it("không đủ quyền trang đích thì chuyển sang trang dự phòng hợp lệ", () => {
    // Vai trò "admin" nhưng quyền thực tế bị bớt, không còn catalog.read để mở Tổng quan.
    const granted = new Set(["invoice.create", "invoice.read"]);
    const can: Can = (permission) => granted.has(permission);
    expect(pageAccess("/tai-khoan", can)).toBe("forbidden");

    const start = startPageFor([{ code: "admin", storeId: null }], NT01, can);
    expect(start).toBe("/ban-hang");
    expect(pageAccess(start!, can)).toBe("allowed");
  });

  it("không có quyền nào thì không có trang bắt đầu", () => {
    expect(startPageFor([{ code: "pharmacist", storeId: NT01 }], NT01, NONE)).toBeNull();
  });
});

describe("ghi nhớ menu theo tài khoản", () => {
  function memoryStore() {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
  }

  it("mỗi tài khoản một khóa, không đọc nhầm của người khác", () => {
    const store = memoryStore();
    writeMenuPrefs("user-a", { collapsed: true, openGroup: "goods" }, store);
    expect(readMenuPrefs("user-a", store)).toEqual({ collapsed: true, openGroup: "goods" });
    expect(readMenuPrefs("user-b", store)).toEqual(DEFAULT_MENU_PREFS);
    expect(store.data.has(menuPrefsKey("user-a"))).toBe(true);
  });

  it("dữ liệu hỏng thì quay về mặc định, không làm sập menu", () => {
    const store = memoryStore();
    store.setItem(menuPrefsKey("user-a"), "{không phải json");
    expect(readMenuPrefs("user-a", store)).toEqual(DEFAULT_MENU_PREFS);
  });

  it("không có bộ nhớ trình duyệt thì vẫn chạy với mặc định", () => {
    expect(readMenuPrefs("user-a", null)).toEqual(DEFAULT_MENU_PREFS);
    expect(() => writeMenuPrefs("user-a", DEFAULT_MENU_PREFS, null)).not.toThrow();
  });

  it("xóa hai khóa dùng chung của bản cũ", () => {
    const store = memoryStore();
    store.setItem("gpp.sider.collapsed", "1");
    store.setItem("gpp.sider.groups", "[]");
    dropLegacyMenuPrefs(store);
    expect(store.data.size).toBe(0);
  });

  it("nhóm đã lưu mà không còn quyền thấy thì coi như chưa mở", () => {
    expect(sanitizeOpenGroup("admin", ["sales", "goods"])).toBeNull();
    expect(sanitizeOpenGroup("goods", ["sales", "goods"])).toBe("goods");
  });
});
