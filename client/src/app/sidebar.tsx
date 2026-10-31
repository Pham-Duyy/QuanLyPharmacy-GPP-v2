import {
  AppstoreOutlined,
  FundOutlined,
  ProfileOutlined,
  SettingOutlined,
  ShoppingOutlined,
  SolutionOutlined,
} from "@ant-design/icons";
import type { ReactNode } from "react";
import type { PagePath } from "./pages.js";

/**
 * Cấu trúc sidebar: chỉ quyết định trang nào hiện ở đâu. Quyền mở trang nằm
 * ở `pages.tsx`; mục nào ở đây cũng phải là đường dẫn đã đăng ký (kiểu
 * `PagePath` chặn ngay lúc biên dịch).
 *
 * 8 điểm vào chính theo công việc hằng ngày, Quản trị gập ở cuối. Việc dùng
 * nhiều nhất (Tổng quan, Quầy bán, Khách hàng) đứng đầu, mở bằng một lần bấm;
 * phần còn lại tối đa hai lần: mở nhóm rồi chọn trang. Trong mỗi nhóm, trang
 * dùng thường xuyên đứng trước. Bảng điều hành nằm ngay trong Tổng quan.
 */
export type SidebarEntry =
  | { kind: "page"; path: PagePath }
  | {
      kind: "group";
      key: string;
      label: string;
      icon: ReactNode;
      paths: readonly PagePath[];
      divided?: boolean;
    };

export const SIDEBAR: readonly SidebarEntry[] = [
  { kind: "page", path: "/tai-khoan" },
  { kind: "page", path: "/ban-hang" },
  { kind: "page", path: "/khach-hang" },
  {
    kind: "group",
    key: "sales",
    label: "Giao dịch bán",
    icon: <ProfileOutlined />,
    paths: ["/hoa-don", "/tra-hang", "/don-thuoc", "/ca-thu-ngan", "/hoa-don-dien-tu"],
  },
  {
    kind: "group",
    key: "goods",
    label: "Hàng hóa",
    icon: <AppstoreOutlined />,
    paths: ["/san-pham", "/ton-kho", "/can-han", "/chuyen-hang", "/kiem-ke", "/dieu-chinh-ton"],
  },
  {
    kind: "group",
    key: "purchasing",
    label: "Mua hàng",
    icon: <ShoppingOutlined />,
    paths: ["/de-xuat-dat-hang", "/phieu-nhap", "/nha-cung-cap", "/tra-hang-ncc", "/cong-no-ncc"],
  },
  {
    kind: "group",
    key: "gpp",
    label: "Hồ sơ GPP",
    icon: <SolutionOutlined />,
    paths: ["/kiem-soat-dac-biet", "/so-nhiet-do", "/thu-hoi", "/khieu-nai", "/lien-thong-duoc"],
  },
  {
    kind: "group",
    key: "reports",
    label: "Báo cáo",
    icon: <FundOutlined />,
    paths: ["/bao-cao", "/tong-ket-thang", "/tro-ly-phan-tich"],
  },
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
