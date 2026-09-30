import {
  CalendarOutlined,
  DownOutlined,
  ExclamationCircleFilled,
  KeyOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  SearchOutlined,
  ShopOutlined,
} from "@ant-design/icons";
import { Avatar, Button, Drawer, Dropdown, Grid, Layout, Menu, Select, Skeleton, Tooltip } from "antd";
import type { MenuProps } from "antd";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "../features/auth/AuthProvider.js";
import { ChangePasswordModal } from "../features/auth/ChangePasswordModal.js";
import { activeNav, visibleSidebar } from "./access.js";
import { CommandPalette } from "./CommandPalette.js";
import { confirmLeave } from "./leave-guard.js";
import { DEFAULT_MENU_PREFS, dropLegacyMenuPrefs, readMenuPrefs, sanitizeOpenGroup, writeMenuPrefs, type MenuPrefs } from "./menu-prefs.js";
import { NotificationBell } from "./NotificationBell.js";

function initialsOf(fullName: string): string {
  const words = fullName.trim().split(/\s+/);
  return (words.at(-1)?.[0] ?? "?").toUpperCase();
}

type MenuItem = NonNullable<MenuProps["items"]>[number];

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Nhóm vừa được mở trong danh sách antd trả về; đóng nhóm đang mở thì ra `null`. */
function newlyOpened(keys: string[], current: string | null): string | null {
  return keys.filter((key) => key !== current).at(-1) ?? null;
}

export function AppLayout() {
  const { me, storeId, selectStore, logout, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const screens = Grid.useBreakpoint();
  const isDesktop = screens.lg ?? true;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  /** Nhóm đang bung ra dạng khung nổi khi menu thu gọn; không ghi nhớ. */
  const [popupGroup, setPopupGroup] = useState<string | null>(null);

  // --- Tùy chọn menu theo từng tài khoản ------------------------------------
  // Đổi tài khoản trên cùng trình duyệt thì nạp lại tùy chọn của người mới
  // ngay trong lượt render, không để người sau thấy cách bày của người trước.
  const userId = me?.user.id ?? null;
  const [prefsOwner, setPrefsOwner] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<MenuPrefs>(DEFAULT_MENU_PREFS);
  /** Đường dẫn đã hiển thị gần nhất mà phần tự mở nhóm đã xét. */
  const [handledPath, setHandledPath] = useState<string | undefined>(undefined);
  /** Trang đang tới mà người dùng đã tự chọn nhóm trong lúc chờ nó tải. */
  const [userChoseFor, setUserChoseFor] = useState<string | null>(null);
  if (userId !== prefsOwner) {
    setPrefsOwner(userId);
    setPrefs(userId ? readMenuPrefs(userId) : DEFAULT_MENU_PREFS);
    setHandledPath(undefined);
    setUserChoseFor(null);
  }

  function updatePrefs(next: MenuPrefs): void {
    setPrefs(next);
    if (userId) writeMenuPrefs(userId, next);
  }

  // Hai khóa lưu chung của bản cũ: xóa một lần để không tài khoản nào nhận nhầm.
  useEffect(() => dropLegacyMenuPrefs(), []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // --- Nội dung sidebar -----------------------------------------------------
  // Tính lại theo `can`, nên đổi cửa hàng là menu đổi theo quyền tại cửa hàng mới.
  const visible = useMemo(() => visibleSidebar(can), [can]);
  const groupKeys = useMemo(() => visible.flatMap((entry) => (entry.kind === "group" ? [entry.key] : [])), [visible]);
  const nav = useMemo(() => activeNav(location.pathname), [location.pathname]);
  const activeGroup = nav.groupKey !== null && groupKeys.includes(nav.groupKey) ? nav.groupKey : null;
  /** Nhóm đang mở; nhóm đã lưu mà không còn quyền thấy thì coi như chưa mở. */
  const openGroup = sanitizeOpenGroup(prefs.openGroup, groupKeys);

  /**
   * Sang trang thuộc nhóm khác thì mở nhóm đó — và vì mỗi lúc chỉ một nhóm
   * mở, nhóm cũ tự gập. Mục đang chọn không bị giấu sau nhóm gập, kể cả khi
   * tới bằng Ctrl+K hay thông báo.
   *
   * Chỉ xét khi **đường dẫn đã hiển thị** thật sự đổi. React Router chuyển
   * trang trong một transition: URL đổi ngay nhưng giao diện giữ trang cũ tới
   * khi tải xong trang mới, và trong lúc đó vẫn có những lượt render mang
   * đường dẫn cũ. Lượt đó trùng với lần đã xét nên không làm gì.
   *
   * Không ghi nhớ bước này: tải lại trang thì nhóm của trang đó vẫn tự mở.
   */
  if (location.pathname !== handledPath) {
    setHandledPath(location.pathname);
    setUserChoseFor(null);
    const userChose = userChoseFor === location.pathname;
    // Cập nhật dạng hàm: cùng lượt render này có thể vừa nạp tùy chọn của tài
    // khoản ở trên, không được ghi đè mất trạng thái thu gọn đã lưu.
    if (activeGroup !== null && !userChose) {
      setPrefs((current) => (current.openGroup === activeGroup ? current : { ...current, openGroup: activeGroup }));
    }
  }

  /**
   * Người dùng tự mở/gập nhóm. Nếu lúc đó đang có trang mới chờ tải (URL đã
   * đổi mà giao diện chưa), lựa chọn này phải thắng: ghi nhận cho đúng trang
   * đang tới, để khi trang hiện ra không tự bung nhóm khác đè lên.
   */
  function changeOpenGroup(keys: string[]): void {
    if (window.location.pathname !== location.pathname) setUserChoseFor(window.location.pathname);
    updatePrefs({ ...prefs, openGroup: newlyOpened(keys, openGroup) });
  }

  /**
   * Cùng một cấu trúc cho menu mở rộng và thu gọn. Thu gọn chỉ còn biểu
   * tượng của các mục cấp đầu (tối đa 9), bấm vào nhóm thì hiện danh sách
   * trang trong khung nổi — không trải cả chục biểu tượng thành một cột dài.
   */
  const menuItems = useMemo<MenuProps["items"]>(
    () =>
      visible.flatMap((entry): MenuItem[] => {
        if (entry.kind === "page") return [{ key: entry.page.path, icon: entry.page.icon, label: entry.page.label }];
        const group = {
          key: entry.key,
          icon: entry.icon,
          label: entry.label,
          children: entry.pages.map((page) => ({ key: page.path, icon: page.icon, label: page.label })),
        };
        return entry.divided ? [{ type: "divider" as const, key: `divider-${entry.key}` }, group] : [group];
      }),
    [visible],
  );

  if (!me) return null;

  const collapsed = isDesktop && prefs.collapsed;
  const store = me.stores.find((item) => item.id === storeId);
  const roleNames = me.roles.filter((role) => role.storeId === null || role.storeId === storeId).map((role) => role.name);
  const roleText = roleNames.length === 0 ? "Chưa được gán vai trò" : roleNames.join(" · ");

  const sidebar = (compact: boolean) => (
    <div className="sider-inner">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          <PlusOutlined />
        </span>
        {compact ? null : (
          <span className="brand-text">
            <span className="brand-name">Pharmacy GPP</span>
            <span className="brand-tagline">Quản lý nhà thuốc đạt chuẩn</span>
          </span>
        )}
      </div>
      <nav className="sider-nav" aria-label="Điều hướng chính">
        <Menu
          theme="dark"
          mode="inline"
          inlineCollapsed={compact}
          // Mở nhóm bằng bấm, kể cả khi thu gọn: máy tính bảng ở quầy không rê chuột được.
          triggerSubMenuAction="click"
          selectedKeys={nav.selectedPath ? [nav.selectedPath] : []}
          openKeys={compact ? (popupGroup ? [popupGroup] : []) : openGroup ? [openGroup] : []}
          onOpenChange={(keys) => {
            if (compact) setPopupGroup(newlyOpened(keys, popupGroup));
            else changeOpenGroup(keys);
          }}
          items={menuItems}
          onClick={({ key }) => {
            setDrawerOpen(false);
            setPopupGroup(null);
            if (key !== location.pathname) confirmLeave(() => void navigate(key));
          }}
        />
      </nav>
    </div>
  );

  const userMenu: MenuProps = {
    items: [
      {
        key: "profile",
        type: "group",
        label: (
          <div className="user-menu-head">
            <strong>{me.user.fullName}</strong>
            <span>@{me.user.username}</span>
          </div>
        ),
      },
      { type: "divider" },
      { key: "password", icon: <KeyOutlined />, label: "Đổi mật khẩu" },
      { key: "logout", icon: <LogoutOutlined />, label: "Đăng xuất", danger: true },
    ],
    onClick: ({ key }) => {
      if (key === "password") setPasswordOpen(true);
      if (key === "logout") confirmLeave(() => void logout());
    },
  };

  return (
    <Layout hasSider className="app-shell">
      {isDesktop ? (
        <Layout.Sider width={248} collapsedWidth={72} collapsed={collapsed} trigger={null} className="app-sider">
          {sidebar(collapsed)}
        </Layout.Sider>
      ) : (
        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          placement="left"
          size={272}
          closable={false}
          className="app-drawer"
          styles={{ body: { padding: 0 } }}
        >
          {sidebar(false)}
        </Drawer>
      )}
      <Layout className="app-main">
        <Layout.Header className="app-header">
          <Tooltip title={isDesktop ? (collapsed ? "Mở rộng menu" : "Thu gọn menu") : null}>
            <Button
              type="text"
              className="header-icon-btn"
              icon={isDesktop ? collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined /> : <MenuOutlined />}
              onClick={() => {
                if (!isDesktop) return setDrawerOpen(true);
                setPopupGroup(null);
                updatePrefs({ ...prefs, collapsed: !prefs.collapsed });
              }}
              aria-label={isDesktop ? (collapsed ? "Mở rộng menu" : "Thu gọn menu") : "Mở menu"}
            />
          </Tooltip>
          <button type="button" className="search-trigger" onClick={() => setPaletteOpen(true)}>
            <SearchOutlined />
            <span className="search-trigger-text">Tìm thuốc, khách hàng, hóa đơn…</span>
            <kbd>{isMac ? "⌘ K" : "Ctrl K"}</kbd>
          </button>
          <div className="header-actions">
            {me.stores.length > 1 ? (
              <Select
                value={storeId ?? undefined}
                onChange={(next: string) => confirmLeave(() => selectStore(next))}
                className="store-select"
                popupMatchSelectWidth={false}
                suffixIcon={<DownOutlined />}
                options={me.stores.map((item) => ({
                  value: item.id,
                  label: (
                    <span className="store-option">
                      <ShopOutlined /> {item.code} · {item.name}
                    </span>
                  ),
                }))}
              />
            ) : store ? (
              <span className="store-chip" title={store.name}>
                <ShopOutlined /> <span>{store.name}</span>
              </span>
            ) : null}
            <span className="header-date">
              <CalendarOutlined /> {new Intl.DateTimeFormat("vi-VN", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date())}
            </span>
            <NotificationBell />
            <Dropdown menu={userMenu} trigger={["click"]} placement="bottomRight">
              <button type="button" className="user-trigger" aria-label="Tài khoản">
                <Avatar size={34} className="user-avatar">
                  {initialsOf(me.user.fullName)}
                </Avatar>
                <span className="user-trigger-text">
                  <strong>{me.user.fullName}</strong>
                  <span>{roleText}</span>
                </span>
                <DownOutlined className="user-trigger-caret" />
              </button>
            </Dropdown>
          </div>
        </Layout.Header>
        <Layout.Content className="app-content">
          {me.user.mustChangePassword ? (
            <div className="app-banner" role="status">
              <ExclamationCircleFilled />
              <span className="app-banner-text">
                <strong>Tài khoản đang dùng mật khẩu tạm.</strong> Hãy đổi mật khẩu trước khi làm việc với dữ liệu thật.
              </span>
              <Button size="small" type="primary" onClick={() => setPasswordOpen(true)}>
                Đổi mật khẩu
              </Button>
            </div>
          ) : null}
          <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} className="page-skeleton" />}>
            <Outlet />
          </Suspense>
        </Layout.Content>
      </Layout>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </Layout>
  );
}
