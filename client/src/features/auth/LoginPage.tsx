import { useState } from "react";
import { Alert, App, Button, Form, Input } from "antd";
import {
  AuditOutlined,
  ExperimentOutlined,
  LockOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  SafetyOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router";
import { getErrorMessage } from "../../api/http.js";
import { useAuth } from "./auth-context.js";

type LoginForm = { username: string; password: string };

/** Chỉ liệt kê tính năng đã có thật trong hệ thống. */
const HIGHLIGHTS = [
  {
    icon: <SafetyCertificateOutlined />,
    title: "Bán đúng quy định",
    text: "Kiểm tra đơn thuốc, trùng hoạt chất và dị ứng trước khi thanh toán.",
  },
  {
    icon: <ExperimentOutlined />,
    title: "Kiểm soát theo lô",
    text: "Xuất lô theo FEFO, biệt trữ và truy vết thu hồi đến từng hóa đơn.",
  },
  {
    icon: <AuditOutlined />,
    title: "Sẵn sàng thanh tra GPP",
    text: "Sổ nhiệt độ – độ ẩm, thẻ kho và nhật ký thao tác đầy đủ.",
  },
];

export function LoginPage() {
  const { login, loginWithMfa } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Vé bước hai khi tài khoản đã bật xác thực hai lớp (Phase 7, D31). */
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);

  async function handleSubmit(values: LoginForm) {
    setSubmitting(true);
    setError(null);
    try {
      const challenge = await login(values.username.trim(), values.password);
      if (challenge) {
        setMfaToken(challenge.mfaToken);
        return;
      }
      navigate("/", { replace: true });
    } catch (caught) {
      setError(getErrorMessage(caught, "Không đăng nhập được"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCode(values: { code: string }) {
    if (!mfaToken) return;
    setSubmitting(true);
    setError(null);
    try {
      const usedRecovery = await loginWithMfa(mfaToken, values.code.trim());
      if (usedRecovery)
        message.warning(
          "Bạn vừa dùng một mã dự phòng. Mỗi mã chỉ dùng một lần; vào Xác thực hai lớp để xem còn bao nhiêu mã.",
          8,
        );
      navigate("/", { replace: true });
    } catch (caught) {
      const text = getErrorMessage(caught, "Không đăng nhập được");
      setError(text);
      // Vé hết hạn (5 phút): quay lại bước mật khẩu.
      if (/hết hạn/.test(text)) setMfaToken(null);
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
          {mfaToken ? (
            <>
              <h1>Xác thực hai lớp</h1>
              <p className="login-subtitle">
                {useRecovery
                  ? "Nhập một mã dự phòng (dạng XXXXX-XXXXX) đã lưu khi bật xác thực hai lớp."
                  : "Mở ứng dụng Google Authenticator hoặc Microsoft Authenticator, nhập mã 6 số của Pharmacy GPP."}
              </p>
              {error ? <Alert type="error" title={error} showIcon className="login-error" /> : null}
              <Form<{ code: string }>
                key={useRecovery ? "recovery" : "totp"}
                layout="vertical"
                onFinish={handleCode}
                disabled={submitting}
                requiredMark={false}
                size="large"
              >
                <Form.Item
                  label={useRecovery ? "Mã dự phòng" : "Mã xác thực"}
                  name="code"
                  rules={[
                    useRecovery
                      ? { required: true, message: "Nhập mã dự phòng" }
                      : { required: true, pattern: /^\s*\d{6}\s*$/, message: "Nhập đủ 6 số" },
                  ]}
                >
                  <Input
                    prefix={<SafetyOutlined />}
                    placeholder={useRecovery ? "XXXXX-XXXXX" : "123456"}
                    inputMode={useRecovery ? "text" : "numeric"}
                    autoComplete="one-time-code"
                    maxLength={useRecovery ? 20 : 6}
                    autoFocus
                  />
                </Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  block
                  loading={submitting}
                  className="login-submit"
                >
                  Xác nhận
                </Button>
              </Form>
              <Button type="link" block onClick={() => setUseRecovery((value) => !value)}>
                {useRecovery ? "Dùng mã 6 số trong ứng dụng" : "Mất điện thoại? Dùng mã dự phòng"}
              </Button>
              <Button
                type="link"
                block
                onClick={() => {
                  setMfaToken(null);
                  setUseRecovery(false);
                  setError(null);
                }}
              >
                Đăng nhập bằng tài khoản khác
              </Button>
            </>
          ) : (
            <>
              <h1>Đăng nhập</h1>
              <p className="login-subtitle">Dùng tài khoản do quản lý nhà thuốc cấp cho bạn.</p>

              {error ? <Alert type="error" title={error} showIcon className="login-error" /> : null}

              <Form<LoginForm>
                layout="vertical"
                onFinish={handleSubmit}
                disabled={submitting}
                requiredMark={false}
                size="large"
              >
                <Form.Item
                  label="Tên đăng nhập"
                  name="username"
                  rules={[{ required: true, message: "Nhập tên đăng nhập" }]}
                >
                  <Input
                    prefix={<UserOutlined />}
                    placeholder="Ví dụ: duocsi01"
                    autoFocus
                    autoComplete="username"
                  />
                </Form.Item>

                <Form.Item
                  label="Mật khẩu"
                  name="password"
                  rules={[{ required: true, message: "Nhập mật khẩu" }]}
                >
                  <Input.Password
                    prefix={<LockOutlined />}
                    placeholder="Mật khẩu"
                    autoComplete="current-password"
                  />
                </Form.Item>

                <Button
                  type="primary"
                  htmlType="submit"
                  block
                  loading={submitting}
                  className="login-submit"
                >
                  Đăng nhập
                </Button>
              </Form>
            </>
          )}

          <p className="login-help">
            Quên mật khẩu hoặc mất cả điện thoại lẫn mã dự phòng? Liên hệ quản lý nhà thuốc để được
            đặt lại.
          </p>
        </div>
      </main>
    </div>
  );
}
