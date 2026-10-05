import { AppstoreOutlined, ProfileOutlined, SettingOutlined, ShoppingOutlined, SolutionOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";
import type { PagePath } from "./pages.js";

/**
 * Cấu trúc sidebar: chỉ quyết định trang nào hiện ở đâu. Quyền mở trang nằm
 * ở `pages.tsx`; mục nào ở đây cũng phải là đường dẫn đã đăng ký (kiểu
 * `PagePath` chặn ngay lúc biên dịch).
 *
 * 8 điểm vào chính theo công việc hằng ngày, Quản trị gập ở cuối. Việc dùng
 * nhiều nhất (Quầy bán, Tổng quan, Khách hàng, Báo cáo) mở bằng một lần bấm;
 * phần còn lại tối đa hai lần: mở nhóm rồi chọn trang.
 */
export type SidebarEntry =
  | { kind: "page"; path: PagePath }
  | { kind: "group"; key: string; label: string; icon: ReactNode; paths: readonly PagePath[]; divided?: boolean };

export const SIDEBAR: readonly SidebarEntry[] = [
  { kind: "page", path: "/tai-khoan" },
  { kind: "page", path: "/ban-hang" },
  { kind: "group", key: "sales", label: "Giao dịch bán", icon: <ProfileOutlined />, paths: ["/hoa-don", "/hoa-don-dien-tu", "/tra-hang", "/don-thuoc"] },
  {
    kind: "group",
    key: "goods",
    label: "Hàng hóa",
    icon: <AppstoreOutlined />,
    paths: ["/san-pham", "/ton-kho", "/kiem-ke", "/dieu-chinh-ton", "/can-han"],
  },
  {
    kind: "group",
    key: "purchasing",
    label: "Mua hàng",
    icon: <ShoppingOutlined />,
    paths: ["/phieu-nhap", "/de-xuat-dat-hang", "/tra-hang-ncc", "/cong-no-ncc", "/nha-cung-cap"],
  },
  { kind: "page", path: "/khach-hang" },
  {
    kind: "group",
    key: "gpp",
    label: "Hồ sơ GPP",
    icon: <SolutionOutlined />,
    paths: ["/kiem-soat-dac-biet", "/so-nhiet-do", "/lien-thong-duoc"],
  },
  { kind: "page", path: "/bao-cao" },
  {
    kind: "group",
    key: "admin",
    label: "Quản trị",
    icon: <SettingOutlined />,
    paths: ["/nhan-vien", "/cua-hang", "/cai-dat", "/audit-log", "/excel"],
    // Tách khỏi các mục nghiệp vụ bằng một gạch ngăn: việc ít dùng nằm riêng ở cuối.
    divided: true,
  },
];
