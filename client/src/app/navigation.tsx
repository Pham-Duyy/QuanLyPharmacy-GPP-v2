import {
  AppstoreOutlined,
  AuditOutlined,
  BarChartOutlined,
  BellOutlined,
  CloudServerOutlined,
  CreditCardOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FieldTimeOutlined,
  FileExcelOutlined,
  FileProtectOutlined,
  FileTextOutlined,
  InboxOutlined,
  MedicineBoxOutlined,
  RollbackOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ShopOutlined,
  ShoppingOutlined,
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
      { path: "/de-xuat-dat-hang", icon: <ShoppingOutlined />, label: "Đề xuất đặt hàng", permission: "stock.read", keywords: "dat hang goi hang bo sung ton toi thieu" },
      { path: "/phieu-nhap", icon: <InboxOutlined />, label: "Nhập hàng", permission: "goods_receipt.read", keywords: "phieu nhap kiem nhap" },
      { path: "/ton-kho", icon: <DatabaseOutlined />, label: "Tồn kho", permission: "stock.read", keywords: "lo han dung the kho biet tru" },
      { path: "/kiem-ke", icon: <AuditOutlined />, label: "Kiểm kê kho", permission: "stock.read", keywords: "kiem ke dem hang thuc te chenh lech" },
      { path: "/dieu-chinh-ton", icon: <SwapOutlined />, label: "Điều chỉnh tồn", permission: ["stock.adjust.create", "stock.adjust.approve"] },
      { path: "/kiem-soat-dac-biet", icon: <SafetyCertificateOutlined />, label: "Thuốc kiểm soát đặc biệt", permission: "controlled.read", keywords: "gay nghien huong than tien chat so theo doi" },
      { path: "/so-nhiet-do", icon: <ExperimentOutlined />, label: "Nhiệt độ – độ ẩm", permission: "storage_log.read", keywords: "so nhiet do" },
      { path: "/can-han", icon: <FieldTimeOutlined />, label: "Hàng cận hạn", permission: "stock.read", keywords: "can han het han xu ly tra nha cung cap huy" },
      { path: "/canh-bao", icon: <BellOutlined />, label: "Cảnh báo", permission: "stock.read", keywords: "het han ton thap" },
    ],
  },
  {
    key: "catalog",
    label: "Danh mục",
    items: [
      { path: "/san-pham", icon: <MedicineBoxOutlined />, label: "Thuốc & sản phẩm", permission: "catalog.read", keywords: "quan ly thuoc gia ban" },
      { path: "/nha-cung-cap", icon: <TruckOutlined />, label: "Nhà cung cấp", permission: "catalog.read" },
      { path: "/tra-hang-ncc", icon: <RollbackOutlined />, label: "Trả hàng nhà cung cấp", permission: "goods_receipt.read", keywords: "tra hang ncc hang loi can han doi hang" },
      { path: "/cong-no-ncc", icon: <CreditCardOutlined />, label: "Công nợ nhà cung cấp", permission: "supplier_debt.read", keywords: "cong no tra tien nha cung cap thanh toan" },
      { path: "/danh-muc", icon: <TagsOutlined />, label: "Danh mục nền", permission: "catalog.read", keywords: "nhom hang hoat chat" },
      {
        path: "/excel",
        icon: <FileExcelOutlined />,
        label: "Nhập / xuất Excel",
        permission: ["catalog.read", "customer.manage", "invoice.read", "stock.read"],
        keywords: "import export xlsx ton dau ky so ban thuoc ke don gpp mau nhap",
      },
    ],
  },
  {
    key: "admin",
    label: "Quản trị",
    items: [
      { path: "/nhan-vien", icon: <UserSwitchOutlined />, label: "Nhân viên", permission: "user.manage", keywords: "tai khoan vai tro" },
      { path: "/cua-hang", icon: <ShopOutlined />, label: "Cửa hàng", permission: "store.manage" },
      { path: "/audit-log", icon: <AuditOutlined />, label: "Nhật ký hệ thống", permission: "audit.read", keywords: "audit log" },
      { path: "/sao-luu", icon: <CloudServerOutlined />, label: "Sao lưu dữ liệu", permission: "backup.manage", keywords: "backup phuc hoi du lieu an toan" },
      { path: "/cai-dat", icon: <SettingOutlined />, label: "Cài đặt", permission: "settings.manage", keywords: "thiet lap mau in hoa don phieu nhap tra hang dieu chinh kho giay logo" },
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
