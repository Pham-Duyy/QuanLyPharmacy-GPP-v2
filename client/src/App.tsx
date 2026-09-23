import { Button, Result, Spin } from "antd";
import { lazy } from "react";
import type { ComponentType, ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router";
import { AppLayout } from "./app/AppLayout.js";
import { isAllowed, NAV_ITEMS } from "./app/navigation.js";
import { useAuth } from "./features/auth/AuthProvider.js";
import { LoginPage } from "./features/auth/LoginPage.js";

/** Tải từng trang khi cần để lần mở đầu tiên nhẹ hơn. */
function page<K extends string>(loader: () => Promise<Record<K, ComponentType>>, name: K) {
  return lazy(async () => ({ default: (await loader())[name] }));
}

const DashboardPage = page(() => import("./features/dashboard/DashboardPage.js"), "DashboardPage");
const SalePage = page(() => import("./features/sales/SalePage.js"), "SalePage");
const InvoicesPage = page(() => import("./features/sales/InvoicesPage.js"), "InvoicesPage");
const ReturnsPage = page(() => import("./features/sales/ReturnsPage.js"), "ReturnsPage");
const PrescriptionsPage = page(() => import("./features/prescriptions/PrescriptionsPage.js"), "PrescriptionsPage");
const CustomersPage = page(() => import("./features/customers/CustomersPage.js"), "CustomersPage");
const ProductsPage = page(() => import("./features/catalog/ProductsPage.js"), "ProductsPage");
const CatalogDataPage = page(() => import("./features/catalog/CatalogDataPage.js"), "CatalogDataPage");
const SuppliersPage = page(() => import("./features/catalog/SuppliersPage.js"), "SuppliersPage");
const GoodsReceiptsPage = page(() => import("./features/inventory/GoodsReceiptsPage.js"), "GoodsReceiptsPage");
const BatchesPage = page(() => import("./features/inventory/BatchesPage.js"), "BatchesPage");
const AlertsPage = page(() => import("./features/inventory/AlertsPage.js"), "AlertsPage");
const StockAdjustmentsPage = page(() => import("./features/inventory/StockAdjustmentsPage.js"), "StockAdjustmentsPage");
const StorageLogsPage = page(() => import("./features/inventory/StorageLogsPage.js"), "StorageLogsPage");
const UsersPage = page(() => import("./features/users/UsersPage.js"), "UsersPage");
const StoresPage = page(() => import("./features/stores/StoresPage.js"), "StoresPage");
const AuditLogPage = page(() => import("./features/audit/AuditLogPage.js"), "AuditLogPage");
const SettingsPage = page(() => import("./features/settings/SettingsPage.js"), "SettingsPage");
const ControlledDrugsPage = page(() => import("./features/controlled/ControlledDrugsPage.js"), "ControlledDrugsPage");
const ExpiryAlertsPage = page(() => import("./features/inventory/ExpiryAlertsPage.js"), "ExpiryAlertsPage");
const PurchaseSuggestionsPage = page(() => import("./features/inventory/PurchaseSuggestionsPage.js"), "PurchaseSuggestionsPage");
const StockCountsPage = page(() => import("./features/inventory/stock-counts/StockCountsPage.js"), "StockCountsPage");
const BackupPage = page(() => import("./features/backup/BackupPage.js"), "BackupPage");
const ExcelHubPage = page(() => import("./features/excel/ExcelHubPage.js"), "ExcelHubPage");
const ReportsPage = page(() => import("./features/reports/ReportsPage.js"), "ReportsPage");

const ROUTES: Array<{ path: string; element: ReactNode }> = [
  { path: "/tai-khoan", element: <DashboardPage /> },
  { path: "/bao-cao", element: <ReportsPage /> },
  { path: "/ban-hang", element: <SalePage /> },
  { path: "/hoa-don", element: <InvoicesPage /> },
  { path: "/tra-hang", element: <ReturnsPage /> },
  { path: "/don-thuoc", element: <PrescriptionsPage /> },
  { path: "/khach-hang", element: <CustomersPage /> },
  { path: "/phieu-nhap", element: <GoodsReceiptsPage /> },
  { path: "/ton-kho", element: <BatchesPage /> },
  { path: "/dieu-chinh-ton", element: <StockAdjustmentsPage /> },
  { path: "/kiem-ke", element: <StockCountsPage /> },
  { path: "/de-xuat-dat-hang", element: <PurchaseSuggestionsPage /> },
  { path: "/kiem-soat-dac-biet", element: <ControlledDrugsPage /> },
  { path: "/so-nhiet-do", element: <StorageLogsPage /> },
  { path: "/canh-bao", element: <AlertsPage /> },
  { path: "/can-han", element: <ExpiryAlertsPage /> },
  { path: "/san-pham", element: <ProductsPage /> },
  { path: "/nha-cung-cap", element: <SuppliersPage /> },
  { path: "/danh-muc", element: <CatalogDataPage /> },
  { path: "/excel", element: <ExcelHubPage /> },
  { path: "/nhan-vien", element: <UsersPage /> },
  { path: "/cua-hang", element: <StoresPage /> },
  { path: "/audit-log", element: <AuditLogPage /> },
  { path: "/sao-luu", element: <BackupPage /> },
  { path: "/cai-dat", element: <SettingsPage /> },
];

/** Vào thẳng URL của trang không có quyền thì báo rõ, không để trang tự gọi API rồi lỗi 403. */
function Guard({ path, children }: { path: string; children: ReactNode }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const item = NAV_ITEMS.find((entry) => entry.path === path);
  if (item && !isAllowed(item, can)) {
    return (
      <Result
        status="403"
        title="Không có quyền truy cập"
        subTitle="Vai trò của bạn tại cửa hàng này chưa được cấp quyền mở trang này. Liên hệ quản lý nếu cần."
        extra={
          <Button type="primary" onClick={() => void navigate("/")}>
            Về trang chính
          </Button>
        }
      />
    );
  }
  return children;
}

/** Quầy bán hàng là trang chính của người được bán; vai trò khác vào trang đầu tiên được phép. */
function HomeRedirect() {
  const { can } = useAuth();
  const target = can("invoice.create") ? "/ban-hang" : NAV_ITEMS.find((item) => isAllowed(item, can))?.path;
  if (!target) {
    return <Result status="403" title="Tài khoản chưa được gán vai trò" subTitle="Liên hệ quản lý để được cấp quyền sử dụng hệ thống." />;
  }
  return <Navigate to={target} replace />;
}

export default function App() {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <div className="app-boot">
        <Spin size="large" />
      </div>
    );
  }

  if (status !== "authenticated") {
    return (
      <Routes>
        <Route path="/dang-nhap" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/dang-nhap" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/dang-nhap" element={<HomeRedirect />} />
      <Route element={<AppLayout />}>
        {ROUTES.map((route) => (
          <Route key={route.path} path={route.path} element={<Guard path={route.path}>{route.element}</Guard>} />
        ))}
        <Route path="*" element={<HomeRedirect />} />
      </Route>
    </Routes>
  );
}
