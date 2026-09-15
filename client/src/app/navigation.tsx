import {
  AppstoreOutlined,
  AuditOutlined,
  BarChartOutlined,
  BellOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FileProtectOutlined,
  FileTextOutlined,
  InboxOutlined,
  MedicineBoxOutlined,
  RollbackOutlined,
  ShopOutlined,
  ShoppingCartOutlined,
  SwapOutlined,
  TagsOutlined,
  TeamOutlined,
  TruckOutlined,
  UserSwitchOutlined,
} from "@ant-design/icons";
import type { ReactNode } from "react";

export type NavItem = {
  path: string;
  icon: ReactNode;
  label: string;
  /** Có ít nhất một quyền trong danh sách là thấy mục này. */
  permission: string | string[];
  /** Từ khóa phụ cho ô tìm kiếm nhanh (không dấu cũng được). */
  keywords?: string;
};

export type NavGroup = { key: string; label: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    key: "overview",
    label: "Tổng quan",
    items: [
      { path: "/tai-khoan", icon: <AppstoreOutlined />, label: "Tổng quan", permission: "catalog.read", keywords: "dashboard trang chu" },
      { path: "/bao-cao", icon: <BarChartOutlined />, label: "Báo cáo", permission: "report.sales", keywords: "doanh thu loi nhuan" },
    ],
  },
  {
    key: "sales",
    label: "Bán hàng",
    items: [
      { path: "/ban-hang", icon: <ShoppingCartOutlined />, label: "Bán thuốc", permission: "invoice.create", keywords: "pos quay ban le" },
      { path: "/hoa-don", icon: <FileTextOutlined />, label: "Hóa đơn", permission: "invoice.read" },
      { path: "/tra-hang", icon: <RollbackOutlined />, label: "Trả hàng", permission: "invoice.read", keywords: "hoan tien" },
      { path: "/don-thuoc", icon: <FileProtectOutlined />, label: "Đơn thuốc", permission: "prescription.read", keywords: "ke don" },
      { path: "/khach-hang", icon: <TeamOutlined />, label: "Khách hàng", permission: "customer.read" },
    ],
  },
  {
    key: "inventory",
    label: "Kho & GPP",
    items: [
      { path: "/phieu-nhap", icon: <InboxOutlined />, label: "Nhập hàng", permission: "goods_receipt.read", keywords: "phieu nhap kiem nhap" },
      { path: "/ton-kho", icon: <DatabaseOutlined />, label: "Tồn kho", permission: "stock.read", keywords: "lo han dung the kho biet tru" },
      { path: "/dieu-chinh-ton", icon: <SwapOutlined />, label: "Điều chỉnh tồn", permission: ["stock.adjust.create", "stock.adjust.approve"] },
      { path: "/so-nhiet-do", icon: <ExperimentOutlined />, label: "Nhiệt độ – độ ẩm", permission: "storage_log.read", keywords: "so nhiet do" },
      { path: "/canh-bao", icon: <BellOutlined />, label: "Cảnh báo", permission: "stock.read", keywords: "het han ton thap" },
    ],
  },
  {
    key: "catalog",
    label: "Danh mục",
    items: [
      { path: "/san-pham", icon: <MedicineBoxOutlined />, label: "Thuốc & sản phẩm", permission: "catalog.read", keywords: "quan ly thuoc gia ban" },
      { path: "/nha-cung-cap", icon: <TruckOutlined />, label: "Nhà cung cấp", permission: "catalog.read" },
      { path: "/danh-muc", icon: <TagsOutlined />, label: "Danh mục nền", permission: "catalog.read", keywords: "nhom hang hoat chat" },
    ],
  },
  {
    key: "admin",
    label: "Quản trị",
    items: [
      { path: "/nhan-vien", icon: <UserSwitchOutlined />, label: "Nhân viên", permission: "user.manage", keywords: "tai khoan vai tro" },
      { path: "/cua-hang", icon: <ShopOutlined />, label: "Cửa hàng", permission: "store.manage" },
      { path: "/audit-log", icon: <AuditOutlined />, label: "Nhật ký hệ thống", permission: "audit.read", keywords: "audit log" },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

export function isAllowed(item: Pick<NavItem, "permission">, can: (permission: string) => boolean): boolean {
  return Array.isArray(item.permission) ? item.permission.some(can) : can(item.permission);
}

/** Bỏ dấu tiếng Việt để so khớp "ton kho" với "Tồn kho". */
export function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}
