import { Spin } from "antd";
import { Navigate, Route, Routes } from "react-router";
import { AppLayout } from "./app/AppLayout.js";
import { useAuth } from "./features/auth/AuthProvider.js";
import { LoginPage } from "./features/auth/LoginPage.js";
import { ProductsPage } from "./features/catalog/ProductsPage.js";
import { CatalogDataPage } from "./features/catalog/CatalogDataPage.js";
import { SuppliersPage } from "./features/catalog/SuppliersPage.js";
import { CustomersPage } from "./features/customers/CustomersPage.js";
import { DashboardPage } from "./features/dashboard/DashboardPage.js";
import { GoodsReceiptsPage } from "./features/inventory/GoodsReceiptsPage.js";
import { BatchesPage } from "./features/inventory/BatchesPage.js";
import { AlertsPage } from "./features/inventory/AlertsPage.js";
import { StockAdjustmentsPage } from "./features/inventory/StockAdjustmentsPage.js";
import { StorageLogsPage } from "./features/inventory/StorageLogsPage.js";
import { PrescriptionsPage } from "./features/prescriptions/PrescriptionsPage.js";
import { InvoicesPage } from "./features/sales/InvoicesPage.js";
import { ReturnsPage } from "./features/sales/ReturnsPage.js";
import { SalePage } from "./features/sales/SalePage.js";

export default function App() {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
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
      <Route path="/dang-nhap" element={<Navigate to="/ban-hang" replace />} />
      <Route element={<AppLayout />}>
        <Route path="/ban-hang" element={<SalePage />} />
        <Route path="/hoa-don" element={<InvoicesPage />} />
        <Route path="/tra-hang" element={<ReturnsPage />} />
        <Route path="/don-thuoc" element={<PrescriptionsPage />} />
        <Route path="/khach-hang" element={<CustomersPage />} />
        <Route path="/san-pham" element={<ProductsPage />} />
        <Route path="/danh-muc" element={<CatalogDataPage />} />
        <Route path="/nha-cung-cap" element={<SuppliersPage />} />
        <Route path="/phieu-nhap" element={<GoodsReceiptsPage />} />
        <Route path="/ton-kho" element={<BatchesPage />} />
        <Route path="/canh-bao" element={<AlertsPage />} />
        <Route path="/dieu-chinh-ton" element={<StockAdjustmentsPage />} />
        <Route path="/so-nhiet-do" element={<StorageLogsPage />} />
        <Route path="/tai-khoan" element={<DashboardPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/ban-hang" replace />} />
    </Routes>
  );
}
