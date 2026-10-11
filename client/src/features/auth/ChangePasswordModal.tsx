import { LockOutlined, LogoutOutlined, PlusOutlined } from "@ant-design/icons";
import { useMutation } from "@tanstack/react-query";
import { App, Button, Form, Input, Modal, type FormInstance } from "antd";
import type { ReactNode } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { useAuth } from "./auth-context.js";

type FormValues = { currentPassword: string; newPassword: string; confirmPassword: string };

/** Quy tắc giống changePasswordSchema ở backend để báo lỗi ngay khi gõ. */
const NEW_PASSWORD_RULES = [
  { required: true, message: "Nhập mật khẩu mới" },
  { min: 10, message: "Mật khẩu mới phải dài ít nhất 10 ký tự" },
  { pattern: /[a-zA-Z]/, message: "Mật khẩu mới phải có chữ" },
  { pattern: /[0-9]/, message: "Mật khẩu mới phải có số" },
];

/** Gửi đổi mật khẩu rồi nạp lại hồ sơ; dùng chung cho hộp thoại và trang bắt đổi mật khẩu tạm. */
function useChangePassword(onChanged: () => void) {
  const { message } = App.useApp();
  const { reloadMe } = useAuth();
  return useMutation({
    mutationFn: async (values: FormValues) => {
      await http.post("/auth/change-password", {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
    },
    onSuccess: async () => {
      message.success("Đã đổi mật khẩu. Các phiên đăng nhập khác đã bị đăng xuất.");
      onChanged();
      await reloadMe();
    },
  });
}

function PasswordFields({
  form,
  change,
  children,
}: {
  form: FormInstance<FormValues>;
  change: ReturnType<typeof useChangePassword>;
  children?: ReactNode;
}) {
  return (
    <Form<FormValues>
      form={form}
      layout="vertical"
      requiredMark={false}
      onFinish={(values) => change.mutate(values)}
    >
      {change.isError ? (
        <div className="form-error" role="alert">
          {getErrorMessage(change.error, "Không đổi được mật khẩu")}
        </div>
      ) : null}
      <Form.Item
        label="Mật khẩu hiện tại"
        name="currentPassword"
        rules={[{ required: true, message: "Nhập mật khẩu hiện tại" }]}
      >
        <Input.Password prefix={<LockOutlined />} autoComplete="current-password" autoFocus />
      </Form.Item>
      <Form.Item
        label="Mật khẩu mới"
        name="newPassword"
        rules={NEW_PASSWORD_RULES}
        extra="Ít nhất 10 ký tự, có cả chữ và số."
      >
        <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
      </Form.Item>
      <Form.Item
        label="Nhập lại mật khẩu mới"
        name="confirmPassword"
        dependencies={["newPassword"]}
        rules={[
          { required: true, message: "Nhập lại mật khẩu mới" },
          ({ getFieldValue }) => ({
            validator: (_, value) =>
              !value || getFieldValue("newPassword") === value
                ? Promise.resolve()
                : Promise.reject(new Error("Hai lần nhập không khớp")),
          }),
        ]}
      >
        <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
      </Form.Item>
      {children}
    </Form>
  );
}

export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm<FormValues>();
  const change = useChangePassword(() => {
    form.resetFields();
    onClose();
  });

  return (
    <Modal
      open={open}
      title="Đổi mật khẩu"
      okText="Đổi mật khẩu"
      cancelText="Hủy"
      confirmLoading={change.isPending}
      onOk={() => form.submit()}
      onCancel={() => {
        form.resetFields();
        change.reset();
        onClose();
      }}
      destroyOnHidden
    >
      <PasswordFields form={form} change={change} />
    </Modal>
  );
}

/**
 * Hiện thay cho cả phần mềm khi tài khoản còn dùng mật khẩu tạm (vừa được cấp
 * hoặc vừa được đặt lại): máy chủ chặn mọi thao tác khác tới khi đổi xong.
 */
export function PasswordChangeGate() {
  const { me, logout } = useAuth();
  const [form] = Form.useForm<FormValues>();
  const change = useChangePassword(() => undefined);

  return (
    <main className="login-main password-gate">
      <div className="login-card">
        <div className="login-card-brand">
          <span className="brand-mark" aria-hidden>
            <PlusOutlined />
          </span>
          <span className="brand-name">Pharmacy GPP</span>
        </div>
        <h1>Đổi mật khẩu</h1>
        <p className="login-subtitle">
          {me ? `Chào ${me.user.fullName}. ` : null}Bạn đang dùng mật khẩu tạm, hãy đặt mật khẩu
          riêng để bắt đầu làm việc.
        </p>
        <PasswordFields form={form} change={change}>
          <Button
            type="primary"
            htmlType="submit"
            size="large"
            block
            className="login-submit"
            loading={change.isPending}
          >
            Đổi mật khẩu
          </Button>
        </PasswordFields>
        <Button
          type="link"
          block
          icon={<LogoutOutlined />}
          className="password-gate-logout"
          onClick={() => void logout()}
        >
          Đăng xuất
        </Button>
      </div>
    </main>
  );
}
