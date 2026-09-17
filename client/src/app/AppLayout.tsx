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
import { CommandPalette } from "./CommandPalette.js";
import { confirmLeave } from "./leave-guard.js";
import { isAllowed, NAV_GROUPS, NAV_ITEMS } from "./navigation.js";
import { NotificationBell } from "./NotificationBell.js";

const COLLAPSED_KEY = "gpp.sider.collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function initialsOf(fullName: string): string {
  const words = fullName.trim().split(/\s+/);
  return (words.at(-1)?.[0] ?? "?").toUpperCase();
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function AppLayout() {
  const { me, storeId, selectStore, logout, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const screens = Grid.useBreakpoint();
  const isDesktop = screens.lg ?? true;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

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

  const menuItems = useMemo<MenuProps["items"]>(
    () =>
      NAV_GROUPS.flatMap((group) => {
        const visible = group.items.filter((item) => isAllowed(item, can));
        if (visible.length === 0) return [];
        return [
          {
            type: "group" as const,
            key: group.key,
            label: group.label,
            children: visible.map((item) => ({ key: item.path, icon: item.icon, label: item.label })),
          },
        ];
      }),
    [can],
  );

  if (!me) return null;

  const store = me.stores.find((item) => item.id === storeId);
  const selectedKey =
    NAV_ITEMS.filter((item) => location.pathname.startsWith(item.path)).sort((a, b) => b.path.length - a.path.length)[0]
      ?.path ?? "";
  const roleNames = me.roles.filter((role) => role.storeId === null || role.storeId === storeId).map((role) => role.name);
  const roleText = roleNames.length === 0 ? "Chưa được gán vai trò" : roleNames.join(" · ");

  function toggleCollapsed() {
    setCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // Trình duyệt chặn lưu trữ: vẫn thu gọn được trong phiên hiện tại.
      }
      return next;
    });
  }

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
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => {
            setDrawerOpen(false);
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
              onClick={() => (isDesktop ? toggleCollapsed() : setDrawerOpen(true))}
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
