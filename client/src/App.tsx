import { Button, Result, Spin } from "antd";
import type { ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router";
import { pageAccess, startPageFor } from "./app/access.js";
import { AppLayout } from "./app/AppLayout.js";
import { PAGE_ELEMENTS } from "./app/page-elements.js";
import { PAGES } from "./app/pages.js";
import { useAuth } from "./features/auth/AuthProvider.js";
import { LoginPage } from "./features/auth/LoginPage.js";

/**
 * Lớp kiểm quyền ở giao diện: vào thẳng URL của trang không có quyền thì báo
 * rõ, không để trang tự gọi API rồi mới lỗi 403. Máy chủ vẫn kiểm quyền riêng
 * cho từng API — lớp này không thay thế được lớp đó.
 *
 * Quyền lấy từ danh sách đăng ký trang, không phụ thuộc sidebar: đưa một công
 * cụ ra khỏi menu không làm trang đó mất kiểm quyền. Trang chưa đăng ký thì
 * **từ chối** thay vì cho qua.
 */
function Guard({ path, children }: { path: string; children: ReactNode }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const access = pageAccess(path, can);
  if (access === "allowed") return children;

  return (
    <Result
      status={access === "forbidden" ? "403" : "warning"}
      title={access === "forbidden" ? "Không có quyền truy cập" : "Trang chưa được đăng ký"}
      subTitle={
        access === "forbidden"
          ? "Vai trò của bạn tại cửa hàng này chưa được cấp quyền mở trang này. Liên hệ quản lý nếu cần."
          : "Trang này chưa có trong danh sách quyền truy cập nên tạm thời bị chặn. Hãy báo cho người quản trị phần mềm."
      }
      extra={
        <Button type="primary" onClick={() => void navigate("/")}>
          Về trang chính
        </Button>
      }
    />
  );
}

/** Trang bắt đầu theo vai trò tại cửa hàng đang chọn, luôn kiểm quyền trang đích. */
function HomeRedirect() {
  const { me, storeId, can } = useAuth();
  const target = startPageFor(me?.roles ?? [], storeId, can);
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
        {/* Route sinh từ danh sách đăng ký: không có trang nghiệp vụ nào nằm ngoài lớp kiểm quyền. */}
        {PAGES.map((page) => (
          <Route key={page.path} path={page.path} element={<Guard path={page.path}>{PAGE_ELEMENTS[page.path]}</Guard>} />
        ))}
        <Route path="*" element={<HomeRedirect />} />
      </Route>
    </Routes>
  );
}
