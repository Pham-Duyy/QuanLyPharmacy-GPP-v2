import { useState } from "react";
import { Alert, Button, Form, Input } from "antd";
import {
  AuditOutlined,
  ExperimentOutlined,
  LockOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router";
import { getErrorMessage } from "../../api/http.js";
import { useAuth } from "./AuthProvider.js";

type LoginForm = { username: string; password: string };

/** Chỉ liệt kê tính năng đã có thật trong hệ thống. */
const HIGHLIGHTS = [
  { icon: <SafetyCertificateOutlined />, title: "Bán đúng quy định", text: "Kiểm tra đơn thuốc, trùng hoạt chất và dị ứng trước khi thanh toán." },
  { icon: <ExperimentOutlined />, title: "Kiểm soát theo lô", text: "Xuất lô theo FEFO, biệt trữ và truy vết thu hồi đến từng hóa đơn." },
  { icon: <AuditOutlined />, title: "Sẵn sàng thanh tra GPP", text: "Sổ nhiệt độ – độ ẩm, thẻ kho và nhật ký thao tác đầy đủ." },
];

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(values: LoginForm) {
    setSubmitting(true);
    setError(null);
    try {
      await login(values.username.trim(), values.password);
      navigate("/", { replace: true });
    } catch (caught) {
      setError(getErrorMessage(caught, "Không đăng nhập được"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <aside className="login-hero">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden>
            <PlusOutlined />
          </span>
          <span className="brand-text">
            <span className="brand-name">Pharmacy GPP</span>
            <span className="brand-tagline">Quản lý nhà thuốc đạt chuẩn</span>
          </span>
        </div>
        <div className="login-hero-body">
          <h2>Vận hành nhà thuốc an toàn, minh bạch và đúng chuẩn GPP.</h2>
          <ul className="login-highlights">
            {HIGHLIGHTS.map((item) => (
              <li key={item.title}>
                <span className="login-highlight-icon" aria-hidden>
                  {item.icon}
                </span>
                <span>
                  <strong>{item.title}</strong>
                  <span>{item.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="login-hero-foot">© {new Date().getFullYear()} Pharmacy GPP</p>
      </aside>

      <main className="login-main">
        <div className="login-card">
          <div className="login-card-brand">
            <span className="brand-mark" aria-hidden>
              <PlusOutlined />
            </span>
            <span className="brand-name">Pharmacy GPP</span>
          </div>
          <h1>Đăng nhập</h1>
          <p className="login-subtitle">Dùng tài khoản do quản lý nhà thuốc cấp cho bạn.</p>

          {error ? <Alert type="error" title={error} showIcon className="login-error" /> : null}

          <Form<LoginForm> layout="vertical" onFinish={handleSubmit} disabled={submitting} requiredMark={false} size="large">
            <Form.Item label="Tên đăng nhập" name="username" rules={[{ required: true, message: "Nhập tên đăng nhập" }]}>
              <Input prefix={<UserOutlined />} placeholder="Ví dụ: duocsi01" autoFocus autoComplete="username" />
            </Form.Item>

            <Form.Item label="Mật khẩu" name="password" rules={[{ required: true, message: "Nhập mật khẩu" }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="Mật khẩu" autoComplete="current-password" />
            </Form.Item>

            <Button type="primary" htmlType="submit" block loading={submitting} className="login-submit">
              Đăng nhập
            </Button>
          </Form>

          <p className="login-help">Quên mật khẩu? Liên hệ quản lý nhà thuốc để được đặt lại mật khẩu tạm.</p>
        </div>
      </main>
    </div>
  );
}
