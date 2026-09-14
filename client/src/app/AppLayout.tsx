import { AppstoreOutlined, AuditOutlined, BellOutlined, CalendarOutlined, DatabaseOutlined, ExperimentOutlined, FileProtectOutlined, FileTextOutlined, MedicineBoxOutlined, MenuFoldOutlined, MenuUnfoldOutlined, PlusOutlined, RollbackOutlined, SearchOutlined, SettingOutlined, ShopOutlined, ShoppingCartOutlined, SwapOutlined, TeamOutlined, TruckOutlined, UserSwitchOutlined } from "@ant-design/icons";
import { Avatar, Badge, Button, Input, Layout, Menu, Select } from "antd";
import type { ReactNode } from "react";
import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "../features/auth/AuthProvider.js";

const ITEMS: Array<{ key: string; icon: ReactNode; label: string; permission: string | string[] }> = [
  { key: "/tai-khoan", icon: <AppstoreOutlined />, label: "Tổng quan", permission: "catalog.read" },
  { key: "/ban-hang", icon: <ShoppingCartOutlined />, label: "Bán thuốc", permission: "invoice.create" },
  { key: "/phieu-nhap", icon: <TruckOutlined />, label: "Nhập hàng", permission: "goods_receipt.read" },
  { key: "/ton-kho", icon: <DatabaseOutlined />, label: "Quản lý kho", permission: "stock.read" },
  { key: "/san-pham", icon: <MedicineBoxOutlined />, label: "Quản lý thuốc", permission: "catalog.read" },
  { key: "/khach-hang", icon: <TeamOutlined />, label: "Khách hàng", permission: "customer.read" },
  { key: "/hoa-don", icon: <FileTextOutlined />, label: "Hóa đơn", permission: "invoice.read" },
  { key: "/tra-hang", icon: <RollbackOutlined />, label: "Trả hàng", permission: "invoice.read" },
  { key: "/don-thuoc", icon: <FileProtectOutlined />, label: "Đơn thuốc", permission: "prescription.read" },
  { key: "/nha-cung-cap", icon: <TruckOutlined />, label: "Nhà cung cấp", permission: "catalog.read" },
  { key: "/danh-muc", icon: <AppstoreOutlined />, label: "Danh mục nền", permission: "catalog.read" },
  { key: "/dieu-chinh-ton", icon: <SwapOutlined />, label: "Điều chỉnh tồn", permission: ["stock.adjust.create", "stock.adjust.approve"] },
  { key: "/so-nhiet-do", icon: <ExperimentOutlined />, label: "Sổ nhiệt độ", permission: "storage_log.read" },
  { key: "/canh-bao", icon: <BellOutlined />, label: "Cảnh báo", permission: "stock.read" },
  { key: "/nhan-vien", icon: <UserSwitchOutlined />, label: "Nhân viên", permission: "user.manage" },
  { key: "/cua-hang", icon: <ShopOutlined />, label: "Cửa hàng", permission: "store.manage" },
  { key: "/audit-log", icon: <AuditOutlined />, label: "Audit log", permission: "audit.read" },
];

export function AppLayout() {
  const { me, storeId, selectStore, logout, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarHidden, setSidebarHidden] = useState(false);
  if (!me) return null;
  const visible = ITEMS.filter((item) => Array.isArray(item.permission) ? item.permission.some(can) : can(item.permission));
  const store = me.stores.find((item) => item.id === storeId);
  return <Layout className="pharmacy-app"><Layout.Sider width={300} className="pharmacy-sider" collapsed={sidebarHidden} collapsedWidth={0} trigger={null}><div className="brand"><div className="brand-mark"><PlusOutlined /></div><div><div className="brand-name">Pharmacy GPP</div><div className="brand-tagline">An toàn · Hiệu quả · Vì sức khỏe cộng đồng</div></div></div><Menu className="sidebar-menu" theme="dark" mode="inline" selectedKeys={[visible.find((item) => location.pathname.startsWith(item.key))?.key ?? ""]} onClick={({ key }) => void navigate(key)} items={visible.map((item) => ({ key: item.key, icon: item.icon, label: item.label }))} /><div className="sidebar-bottom"><div className="ai-promo"><strong>AI Trợ lý nhà thuốc</strong><p>Hỗ trợ tìm thuốc, tư vấn và tra cứu thông tin nhanh chóng.</p><Button size="small" type="primary">Chat với AI →</Button></div><div className="sidebar-footer"><strong>Thông tin nhà thuốc</strong><p>{store?.name ?? "Chưa chọn cửa hàng"}</p><p>Hệ thống quản lý nhà thuốc GPP</p></div></div></Layout.Sider><Layout><Layout.Header className="topbar"><Button className="sidebar-toggle" type="text" icon={sidebarHidden ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setSidebarHidden((value) => !value)} aria-label={sidebarHidden ? "Mở thanh điều hướng" : "Ẩn thanh điều hướng"} /><Input className="global-search" prefix={<SearchOutlined />} suffix={<span style={{ color: "#7993bd", fontSize: 12 }}>Ctrl + K</span>} placeholder="Tìm kiếm thuốc, mã vạch, hóa đơn, khách hàng..." /><div className="header-actions"><Badge count={0} size="small"><BellOutlined className="header-icon" /></Badge><div className="header-date"><CalendarOutlined /> &nbsp; Hôm nay<strong>{new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium" }).format(new Date())}</strong></div><Select value={storeId ?? undefined} onChange={selectStore} variant="borderless" style={{ minWidth: 100 }} options={me.stores.map((item) => ({ value: item.id, label: item.code }))} /><div className="user-panel"><Avatar style={{ background: "#0876eb" }}>{me.user.fullName.slice(0, 1).toUpperCase()}</Avatar><div><div className="name">{me.user.fullName}</div><div className="role">Quản lý nhà thuốc</div></div><Button type="text" icon={<SettingOutlined />} onClick={() => void logout()} aria-label="Đăng xuất" /></div></div></Layout.Header><Layout.Content className="app-content"><Outlet /></Layout.Content></Layout></Layout>;
}
