import { Spin } from "antd";
import { Navigate, Route, Routes } from "react-router";
import { AppLayout } from "./app/AppLayout.js";
import { useAuth } from "./features/auth/AuthProvider.js";
import { LoginPage } from "./features/auth/LoginPage.js";
import { ProductsPage } from "./features/catalog/ProductsPage.js";
import { DashboardPage } from "./features/dashboard/DashboardPage.js";
import { GoodsReceiptsPage } from "./features/inventory/GoodsReceiptsPage.js";
import { InvoicesPage } from "./features/sales/InvoicesPage.js";
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
        <Route path="/san-pham" element={<ProductsPage />} />
        <Route path="/phieu-nhap" element={<GoodsReceiptsPage />} />
        <Route path="/tai-khoan" element={<DashboardPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/ban-hang" replace />} />
    </Routes>
  );
}
