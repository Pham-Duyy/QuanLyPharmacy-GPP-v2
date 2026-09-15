import { LockOutlined } from "@ant-design/icons";
import { useMutation } from "@tanstack/react-query";
import { App, Form, Input, Modal } from "antd";
import { getErrorMessage, http } from "../../api/http.js";
import { useAuth } from "./AuthProvider.js";

type FormValues = { currentPassword: string; newPassword: string; confirmPassword: string };

/** Quy tắc giống changePasswordSchema ở backend để báo lỗi ngay khi gõ. */
const NEW_PASSWORD_RULES = [
  { required: true, message: "Nhập mật khẩu mới" },
  { min: 10, message: "Mật khẩu mới phải dài ít nhất 10 ký tự" },
  { pattern: /[a-zA-Z]/, message: "Mật khẩu mới phải có chữ" },
  { pattern: /[0-9]/, message: "Mật khẩu mới phải có số" },
];

export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm<FormValues>();
  const { message } = App.useApp();
  const { reloadMe } = useAuth();

  const change = useMutation({
    mutationFn: async (values: FormValues) => {
      await http.post("/auth/change-password", {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
    },
    onSuccess: async () => {
      message.success("Đã đổi mật khẩu. Các phiên đăng nhập khác đã bị đăng xuất.");
      form.resetFields();
      onClose();
      await reloadMe();
    },
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
      <Form<FormValues> form={form} layout="vertical" requiredMark={false} onFinish={(values) => change.mutate(values)}>
        {change.isError ? (
          <div className="form-error" role="alert">
            {getErrorMessage(change.error, "Không đổi được mật khẩu")}
          </div>
        ) : null}
        <Form.Item label="Mật khẩu hiện tại" name="currentPassword" rules={[{ required: true, message: "Nhập mật khẩu hiện tại" }]}>
          <Input.Password prefix={<LockOutlined />} autoComplete="current-password" autoFocus />
        </Form.Item>
        <Form.Item label="Mật khẩu mới" name="newPassword" rules={NEW_PASSWORD_RULES} extra="Ít nhất 10 ký tự, có cả chữ và số.">
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
      </Form>
    </Modal>
  );
}
