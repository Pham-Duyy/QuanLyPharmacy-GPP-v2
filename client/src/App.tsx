import { Spin } from "antd";
import { Navigate, Route, Routes } from "react-router";
import { useAuth } from "./features/auth/AuthProvider.js";
import { LoginPage } from "./features/auth/LoginPage.js";
import { DashboardPage } from "./features/dashboard/DashboardPage.js";

export default function App() {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/dang-nhap"
        element={status === "authenticated" ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        path="/"
        element={
          status === "authenticated" ? <DashboardPage /> : <Navigate to="/dang-nhap" replace />
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
