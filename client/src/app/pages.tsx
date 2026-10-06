import {
  ApiOutlined,
  AuditOutlined,
  BarcodeOutlined,
  BarChartOutlined,
  BellOutlined,
  BulbOutlined,
  CarOutlined,
  ContainerOutlined,
  ControlOutlined,
  CreditCardOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FieldTimeOutlined,
  FileDoneOutlined,
  FileExcelOutlined,
  FileProtectOutlined,
  FileTextOutlined,
  InboxOutlined,
  MedicineBoxOutlined,
  NotificationOutlined,
  PictureOutlined,
  RollbackOutlined,
  SafetyCertificateOutlined,
  ShopOutlined,
  ShoppingCartOutlined,
  SwapOutlined,
  TagsOutlined,
  TeamOutlined,
  TruckOutlined,
  UndoOutlined,
  UserSwitchOutlined,
} from "@ant-design/icons";
import type { ReactNode } from "react";

/**
 * Danh sách đăng ký trang: nguồn duy nhất cho **đường dẫn và quyền truy cập**.
 *
 * Tách khỏi cấu trúc sidebar (`sidebar.tsx`) có chủ đích. Sidebar chỉ quyết
 * định trang nào hiện ở đâu; quyền mở trang nằm ở đây. Nhờ vậy đưa một công
 * cụ ra khỏi sidebar (ví dụ In tem về màn Sản phẩm) không làm mất lớp kiểm
 * quyền của trang đó, và Ctrl+K vẫn tìm thấy nó.
 *
 * Route của ứng dụng được sinh từ danh sách này (xem `page-elements.tsx`),
 * nên không thể có trang nghiệp vụ nào tồn tại mà chưa đăng ký.
 */
export type PageDef = {
  path: string;
  label: string;
  icon: ReactNode;
  /** Có ít nhất một quyền trong danh sách là mở được trang. */
  permission: string | readonly string[];
  /** Từ khóa cho tìm nhanh, gồm cả tên cũ để người quen tay vẫn tìm ra. */
  keywords?: string;
  /**
   * Trang không nằm trên sidebar thì chỉ ra mục sidebar được đánh dấu khi
   * đang mở trang này — In tem thì sáng mục Sản phẩm.
   */
  navTarget?: string;
  /**
   * Chỉ hiện trên sidebar khi cửa hàng đã bật chức năng này, hoặc với người
   * có quyền cấu hình (để còn bật lên). Đường dẫn vẫn mở được như thường.
   */
  onlyWhenEnabled?: { feature: StoreFeature; managePermission: string };
};

export type StoreFeature = "einvoice" | "nationalSync";

export const PAGES = [
  // --- Truy cập trực tiếp ---------------------------------------------------
  { path: "/tai-khoan", label: "Tổng quan", icon: <DashboardOutlined />, permission: "catalog.read", keywords: "dashboard trang chu bang dieu khien viec can xu ly" },
  { path: "/ban-hang", label: "Quầy bán", icon: <ShoppingCartOutlined />, permission: "invoice.create", keywords: "ban thuoc pos quay ban le thanh toan" },
  { path: "/khach-hang", label: "Khách hàng", icon: <TeamOutlined />, permission: "customer.read", keywords: "khach hang tich diem the thanh vien lich su mua" },
  { path: "/bao-cao", label: "Báo cáo", icon: <BarChartOutlined />, permission: "report.sales", keywords: "doanh thu loi nhuan lai gop" },

  // --- Giao dịch bán --------------------------------------------------------
  { path: "/hoa-don", label: "Hóa đơn", icon: <FileTextOutlined />, permission: "invoice.read", keywords: "hoa don da ban huy hoa don nhan tra hang" },
  { path: "/tra-hang", label: "Khách trả hàng", icon: <RollbackOutlined />, permission: "invoice.read", keywords: "tra hang hoan tien phieu tra" },
  { path: "/hoa-don-dien-tu", label: "Hóa đơn điện tử", icon: <FileDoneOutlined />, permission: "invoice.read", keywords: "hoa don dien tu may tinh tien ma co quan thue misa meinvoice", onlyWhenEnabled: { feature: "einvoice", managePermission: "einvoice.manage" } },
  { path: "/don-thuoc", label: "Đơn thuốc", icon: <FileProtectOutlined />, permission: "prescription.read", keywords: "ke don duyet don bac si" },

  // --- Hàng hóa -------------------------------------------------------------
  { path: "/san-pham", label: "Sản phẩm", icon: <MedicineBoxOutlined />, permission: "catalog.read", keywords: "thuoc va san pham quan ly thuoc gia ban mat hang danh muc" },
  { path: "/ton-kho", label: "Tồn kho", icon: <DatabaseOutlined />, permission: "stock.read", keywords: "lo han dung the kho biet tru ton dau ky" },
  { path: "/kiem-ke", label: "Kiểm kê", icon: <ContainerOutlined />, permission: "stock.read", keywords: "kiem ke kho dem hang thuc te chenh lech" },
  { path: "/dieu-chinh-ton", label: "Điều chỉnh tồn", icon: <SwapOutlined />, permission: ["stock.adjust.create", "stock.adjust.approve"], keywords: "dieu chinh ton hao hut vo hong duyet" },
  { path: "/chuyen-hang", label: "Chuyển hàng", icon: <CarOutlined />, permission: "stock.read", keywords: "chuyen hang chuyen kho dieu chuyen giua cua hang chi nhanh nhan hang" },
  { path: "/can-han", label: "Hàng cận hạn", icon: <FieldTimeOutlined />, permission: "stock.read", keywords: "can han het han xu ly ke hoach tra nha cung cap huy" },
  // Công cụ của Hàng hóa, không đặt trên sidebar.
  { path: "/canh-bao", label: "Cảnh báo", icon: <BellOutlined />, permission: "stock.read", keywords: "canh bao kho het han ton thap", navTarget: "/ton-kho" },
  { path: "/anh-san-pham", label: "Quản lý ảnh hàng loạt", icon: <PictureOutlined />, permission: "catalog.manage", keywords: "anh san pham hinh anh thuoc tai anh hang loat image", navTarget: "/san-pham" },
  { path: "/in-tem", label: "In tem mã vạch", icon: <BarcodeOutlined />, permission: "catalog.read", keywords: "in tem ma vach nhan ke gia barcode", navTarget: "/san-pham" },
  { path: "/danh-muc", label: "Nhóm hàng – hoạt chất", icon: <TagsOutlined />, permission: "catalog.read", keywords: "danh muc nen nhom hang hoat chat", navTarget: "/san-pham" },

  // --- Mua hàng -------------------------------------------------------------
  { path: "/phieu-nhap", label: "Phiếu nhập", icon: <InboxOutlined />, permission: "goods_receipt.read", keywords: "nhap hang kiem nhap phieu nhap" },
  { path: "/de-xuat-dat-hang", label: "Đề xuất đặt hàng", icon: <BulbOutlined />, permission: "stock.read", keywords: "dat hang goi hang bo sung ton toi thieu" },
  { path: "/tra-hang-ncc", label: "Trả nhà cung cấp", icon: <UndoOutlined />, permission: "goods_receipt.read", keywords: "tra hang nha cung cap ncc hang loi can han doi hang" },
  { path: "/cong-no-ncc", label: "Công nợ phải trả", icon: <CreditCardOutlined />, permission: "supplier_debt.read", keywords: "cong no nha cung cap tra tien thanh toan" },
  { path: "/nha-cung-cap", label: "Nhà cung cấp", icon: <TruckOutlined />, permission: "catalog.read", keywords: "nha cung cap doi tac ncc" },

  // --- Hồ sơ GPP ------------------------------------------------------------
  { path: "/kiem-soat-dac-biet", label: "Thuốc kiểm soát đặc biệt", icon: <SafetyCertificateOutlined />, permission: "controlled.read", keywords: "gay nghien huong than tien chat so theo doi" },
  { path: "/so-nhiet-do", label: "Nhiệt độ – độ ẩm", icon: <ExperimentOutlined />, permission: "storage_log.read", keywords: "so nhiet do do am bao quan" },
  { path: "/thu-hoi", label: "Thu hồi thuốc", icon: <NotificationOutlined />, permission: "recall.manage", keywords: "thu hoi thuoc so lo cong van khach da mua" },
  { path: "/lien-thong-duoc", label: "Liên thông CSDL Dược", icon: <ApiOutlined />, permission: "national_sync.read", keywords: "lien thong csdl duoc quoc gia bo y te csdlduoc api", onlyWhenEnabled: { feature: "nationalSync", managePermission: "national_sync.manage" } },

  // --- Quản trị -------------------------------------------------------------
  { path: "/nhan-vien", label: "Nhân viên", icon: <UserSwitchOutlined />, permission: "user.manage", keywords: "tai khoan vai tro phan quyen" },
  { path: "/cua-hang", label: "Cửa hàng", icon: <ShopOutlined />, permission: "store.manage", keywords: "cua hang chi nhanh" },
  { path: "/cai-dat", label: "Cài đặt", icon: <ControlOutlined />, permission: "settings.manage", keywords: "thiet lap mau in hoa don phieu nhap tra hang dieu chinh kho giay logo" },
  { path: "/audit-log", label: "Nhật ký hệ thống", icon: <AuditOutlined />, permission: "audit.read", keywords: "audit log lich su thao tac nhat ky" },
  {
    path: "/excel",
    label: "Nhập / xuất Excel",
    icon: <FileExcelOutlined />,
    permission: ["catalog.read", "customer.manage", "invoice.read", "stock.read"],
    keywords: "import export xlsx ton dau ky so ban thuoc ke don gpp mau nhap cong cu du lieu",
  },
] as const satisfies readonly PageDef[];

export type PagePath = (typeof PAGES)[number]["path"];
