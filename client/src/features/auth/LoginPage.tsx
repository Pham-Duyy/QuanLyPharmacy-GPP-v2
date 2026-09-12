import { useState } from "react";
import { Alert, Button, Card, Form, Input, Typography } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router";
import { getErrorMessage } from "../../api/http.js";
import { useAuth } from "./AuthProvider.js";

type LoginForm = { username: string; password: string };

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
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f0f4f3",
        padding: 16,
      }}
    >
      <Card style={{ width: 380, boxShadow: "0 4px 24px rgba(0,0,0,0.08)" }}>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          Nhà thuốc GPP
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 24 }}>
          Đăng nhập để vào hệ thống quản lý
        </Typography.Paragraph>

        {error ? (
          <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />
        ) : null}

        <Form<LoginForm> layout="vertical" onFinish={handleSubmit} disabled={submitting}>
          <Form.Item
            label="Tên đăng nhập"
            name="username"
            rules={[{ required: true, message: "Nhập tên đăng nhập" }]}
          >
            <Input prefix={<UserOutlined />} placeholder="admin" autoFocus autoComplete="username" />
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

          <Button type="primary" htmlType="submit" block loading={submitting}>
            Đăng nhập
          </Button>
        </Form>
      </Card>
    </div>
  );
}
