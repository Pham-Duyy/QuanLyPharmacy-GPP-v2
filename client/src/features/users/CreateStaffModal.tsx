import {
  BankOutlined,
  CheckCircleFilled,
  DeleteOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  UserAddOutlined,
  UserOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { isAxiosError } from "axios";
import { Alert, App, Button, Checkbox, Form, Input, Modal, Select, Space } from "antd";
import { useState } from "react";
import { getErrorMessage } from "../../api/http.js";
import type { RoleItem, UserDetail } from "../../api/types.js";
import { PREVIEW_TODAY } from "./preview/preview-fixtures.js";
import { usePreview } from "./preview/preview-context.js";
import { useCreateStaff, useRoles } from "./staff-api.js";
import { generatePassword, passwordProblem, USERNAME_PATTERN } from "./staff-password.js";
import { CHAIN_SCOPE, scopeToStoreId, useManagedScopes } from "./staff-scope.js";

type Assignment = { scope?: string; roleCode?: string; qualificationReference?: string };

type Values = {
  fullName: string;
  phone?: string;
  practiceCertificateNumber?: string;
  username: string;
  password: string;
  confirm: string;
  mustChangePassword: boolean;
  assignments: Assignment[];
};

const INITIAL: Partial<Values> = { mustChangePassword: true, assignments: [{}] };

type Props = {
  open: boolean;
  /** live: tạo tài khoản thật qua API. preview: chỉ thêm dòng mẫu vào bản xem trước. */
  mode: "live" | "preview";
  onClose: () => void;
  onCreated: (result: { mode: "live"; user: UserDetail } | { mode: "preview"; id: string }) => void;
};

export function CreateStaffModal({ open, mode, onClose, onCreated }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<Values>();
  const [serverError, setServerError] = useState<string | null>(null);
  const roles = useRoles(open);
  const scopes = useManagedScopes();
  const preview = usePreview();
  const create = useCreateStaff();
  const assignments = Form.useWatch("assignments", form) ?? [];
  const password = Form.useWatch("password", form) ?? "";

  const busy = create.isPending;
  const roleByCode = new Map((roles.data ?? []).map((role) => [role.code, role]));

  const scopeOptions =
    mode === "live"
      ? [
          ...(scopes.canChain ? [{ value: CHAIN_SCOPE, label: "Toàn chuỗi (mọi cửa hàng)" }] : []),
          ...scopes.stores.map((store) => ({ value: store.id, label: store.name })),
        ]
      : preview.state.stores.map((store) => ({ value: store.id, label: store.name }));
  const scopeLabel = (scope?: string) =>
    scopeOptions.find((option) => option.value === scope)?.label ?? "";

  function close(): void {
    if (busy) return;
    // Không giữ mật khẩu trong state khi đóng.
    form.resetFields();
    setServerError(null);
    onClose();
  }

  async function submit(values: Values): Promise<void> {
    if (busy) return;
    setServerError(null);
    const rows = values.assignments.filter((row) => row.scope && row.roleCode);

    if (mode === "preview") {
      if (
        preview.state.employees.some(
          (employee) => employee.username === values.username.toLowerCase(),
        )
      ) {
        form.setFields([{ name: "username", errors: ["Tên đăng nhập đã có trong bản xem trước"] }]);
        return;
      }
      const id = crypto.randomUUID();
      const first = rows[0]!;
      preview.dispatch({
        type: "addEmployee",
        employee: {
          id,
          code: `NV${String(preview.state.employees.length + 1).padStart(3, "0")}`,
          fullName: values.fullName.trim(),
          username: values.username.toLowerCase(),
          title: "Chưa cập nhật",
          storeId: first.scope === CHAIN_SCOPE ? preview.state.stores[0]!.id : first.scope!,
          accessRole: rows
            .map((row) => roleByCode.get(row.roleCode!)?.name ?? row.roleCode)
            .join(", "),
          workStatus: "probation",
          accountActive: true,
          joinedAt: PREVIEW_TODAY,
          phone: values.phone?.trim() || null,
          certificate: values.practiceCertificateNumber?.trim() || null,
          monthlyBase: 0,
          allowance: 0,
          deduction: 0,
        },
      });
      form.resetFields();
      void message.success(
        "Đã thêm nhân viên mẫu vào bản xem trước. Không có tài khoản thật nào được tạo.",
      );
      onCreated({ mode: "preview", id });
      return;
    }

    try {
      const user = await create.mutateAsync({
        username: values.username.trim(),
        fullName: values.fullName.trim(),
        phone: values.phone?.trim() || null,
        practiceCertificateNumber: values.practiceCertificateNumber?.trim() || null,
        defaultStoreId:
          rows.map((row) => scopeToStoreId(row.scope!)).find((id) => id !== null) ?? null,
        password: values.password,
        mustChangePassword: values.mustChangePassword,
        roles: rows.map((row) => ({
          roleCode: row.roleCode!,
          storeId: scopeToStoreId(row.scope!),
          qualificationReference:
            row.roleCode === "pharmacist" ? row.qualificationReference?.trim() || null : null,
        })),
      });
      form.resetFields();
      void message.success(`Đã tạo nhân viên ${user.fullName} và phân quyền.`);
      onCreated({ mode: "live", user });
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 409) {
        form.setFields([{ name: "username", errors: ["Tên đăng nhập đã tồn tại"] }]);
        return;
      }
      // Lỗi ở bất kỳ bước nào: máy chủ đã hủy cả giao dịch, không có tài khoản dở dang.
      setServerError(
        getErrorMessage(error, "Không tạo được nhân viên. Chưa có tài khoản nào được tạo."),
      );
    }
  }

  const selectedRoles = [
    ...new Map(
      assignments.filter((row) => row?.roleCode).map((row) => [row.roleCode!, row]),
    ).values(),
  ];

  return (
    <Modal
      open={open}
      onCancel={close}
      width={1000}
      footer={null}
      destroyOnHidden
      maskClosable={!busy}
      closable={!busy}
      afterClose={() => form.resetFields()}
      className="staff-create-modal"
      title={
        <div className="staff-modal-title">
          <span className="staff-modal-icon" aria-hidden>
            <UserAddOutlined />
          </span>
          <div>
            <h2>Thêm nhân viên</h2>
            <p>
              {mode === "live"
                ? "Tạo tài khoản đăng nhập và phân quyền làm việc"
                : "Bản xem trước — chỉ thêm dòng mẫu, không tạo tài khoản thật"}
            </p>
          </div>
        </div>
      }
    >
      <Form<Values>
        form={form}
        layout="vertical"
        initialValues={INITIAL}
        onFinish={(values) => void submit(values)}
        disabled={busy}
        requiredMark={(label, { required }) =>
          required ? (
            <>
              {label} <span className="staff-required">*</span>
            </>
          ) : (
            label
          )
        }
      >
        <div className="staff-create-grid">
          <section aria-labelledby="staff-create-info">
            <h3 id="staff-create-info">
              <UserOutlined aria-hidden /> Thông tin nhân viên
            </h3>
            <Form.Item
              name="fullName"
              label="Họ và tên"
              rules={[
                { required: true, whitespace: true, message: "Nhập họ và tên" },
                { max: 200, message: "Tối đa 200 ký tự" },
              ]}
            >
              <Input placeholder="Nhập họ và tên" autoComplete="off" />
            </Form.Item>
            <div className="staff-two">
              <Form.Item
                name="phone"
                label="Số điện thoại"
                rules={[{ max: 20, message: "Tối đa 20 ký tự" }]}
              >
                <Input inputMode="tel" placeholder="Ví dụ: 090 123 4567" autoComplete="off" />
              </Form.Item>
              <Form.Item
                name="practiceCertificateNumber"
                label="Chứng chỉ hành nghề"
                rules={[{ max: 100, message: "Tối đa 100 ký tự" }]}
              >
                <Input placeholder="Nhập nếu có" autoComplete="off" />
              </Form.Item>
            </div>

            <h3 id="staff-create-account" className="staff-create-sub">
              <LockOutlined aria-hidden /> Tài khoản đăng nhập
            </h3>
            <Form.Item
              name="username"
              label="Tên đăng nhập"
              normalize={(value: string) => value?.trim()}
              rules={[
                { required: true, message: "Nhập tên đăng nhập" },
                {
                  pattern: USERNAME_PATTERN,
                  message: "3–50 ký tự: chữ không dấu, số, dấu chấm, gạch dưới hoặc gạch ngang",
                },
              ]}
            >
              <Input placeholder="Ví dụ: minhanh" autoComplete="off" spellCheck={false} />
            </Form.Item>
            <div className="staff-password-head">
              <label htmlFor="staff-new-password">
                Mật khẩu <span className="staff-required">*</span>
              </label>
              <Button
                type="link"
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => {
                  const value = generatePassword();
                  form.setFieldsValue({ password: value, confirm: value });
                  void form.validateFields(["password", "confirm"]);
                }}
              >
                Tạo ngẫu nhiên
              </Button>
            </div>
            <Form.Item
              name="password"
              rules={[
                { required: true, message: "Nhập mật khẩu" },
                {
                  validator: async (_, value: string) => {
                    const problem = value ? passwordProblem(value) : null;
                    if (problem) throw new Error(problem);
                  },
                },
              ]}
              extra={
                password && !passwordProblem(password) ? (
                  <span className="staff-ok">
                    <CheckCircleFilled aria-hidden /> Mật khẩu đạt yêu cầu
                  </span>
                ) : (
                  "Tối thiểu 10 ký tự, có chữ và số."
                )
              }
            >
              <Input.Password
                id="staff-new-password"
                autoComplete="new-password"
                aria-label="Mật khẩu"
              />
            </Form.Item>
            <Form.Item
              name="confirm"
              label="Xác nhận mật khẩu"
              dependencies={["password"]}
              rules={[
                { required: true, message: "Nhập lại mật khẩu" },
                ({ getFieldValue }) => ({
                  validator: async (_, value: string) => {
                    if (value && value !== getFieldValue("password"))
                      throw new Error("Mật khẩu xác nhận không khớp");
                  },
                }),
              ]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Form.Item
              name="mustChangePassword"
              valuePropName="checked"
              className="staff-checkbox-item"
            >
              <Checkbox>Yêu cầu đổi mật khẩu khi đăng nhập lần đầu</Checkbox>
            </Form.Item>
          </section>

          <section aria-labelledby="staff-create-roles">
            <h3 id="staff-create-roles">
              <BankOutlined aria-hidden /> Vai trò &amp; phạm vi
            </h3>
            <Form.List
              name="assignments"
              rules={[
                {
                  validator: async (_, rows: Assignment[] = []) => {
                    if (!rows.some((row) => row?.scope && row?.roleCode))
                      throw new Error("Cần ít nhất một cặp cửa hàng – vai trò");
                  },
                },
              ]}
            >
              {(fields, { add, remove }, { errors }) => (
                <>
                  {fields.map((field, index) => {
                    const row = assignments[index] ?? {};
                    return (
                      <div key={field.key} className="staff-assignment">
                        <div className="staff-assignment-head">
                          <span>Phân quyền {index + 1}</span>
                          {fields.length > 1 ? (
                            <Button
                              type="text"
                              size="small"
                              danger
                              icon={<DeleteOutlined />}
                              aria-label={`Xóa phân quyền ${index + 1}`}
                              onClick={() => remove(field.name)}
                            />
                          ) : null}
                        </div>
                        <Form.Item
                          name={[field.name, "scope"]}
                          label="Cửa hàng làm việc"
                          rules={[{ required: true, message: "Chọn cửa hàng hoặc toàn chuỗi" }]}
                        >
                          <Select
                            placeholder="Chọn cửa hàng"
                            options={scopeOptions}
                            notFoundContent="Bạn chưa quản lý nhân sự ở cửa hàng nào"
                          />
                        </Form.Item>
                        <Form.Item
                          name={[field.name, "roleCode"]}
                          label="Vai trò"
                          dependencies={assignments.map((_, other) => [
                            "assignments",
                            other,
                            "scope",
                          ])}
                          rules={[
                            { required: true, message: "Chọn vai trò" },
                            {
                              validator: async (_, roleCode: string) => {
                                const scope = form.getFieldValue([
                                  "assignments",
                                  field.name,
                                  "scope",
                                ]);
                                const all: Assignment[] = form.getFieldValue("assignments") ?? [];
                                if (
                                  roleCode &&
                                  scope &&
                                  all.some(
                                    (other, otherIndex) =>
                                      otherIndex !== field.name &&
                                      other?.roleCode === roleCode &&
                                      other?.scope === scope,
                                  )
                                )
                                  throw new Error("Cặp cửa hàng – vai trò này đã có ở dòng khác");
                              },
                            },
                          ]}
                        >
                          <Select
                            placeholder="Chọn vai trò"
                            loading={roles.isLoading}
                            options={(roles.data ?? []).map((role) => ({
                              value: role.code,
                              label: role.name,
                            }))}
                          />
                        </Form.Item>
                        {row.roleCode === "pharmacist" ? (
                          <Form.Item
                            name={[field.name, "qualificationReference"]}
                            label="Căn cứ đã kiểm tra bằng cấp chuyên môn"
                            extra="Trình độ, số văn bằng hoặc mã hồ sơ đã đối chiếu. Bắt buộc khi giao vai trò Dược sĩ."
                            rules={[
                              {
                                required: true,
                                whitespace: true,
                                message: "Ghi căn cứ đã kiểm tra chuyên môn",
                              },
                              { max: 500, message: "Tối đa 500 ký tự" },
                            ]}
                          >
                            <Input />
                          </Form.Item>
                        ) : null}
                      </div>
                    );
                  })}
                  <Button
                    icon={<PlusOutlined />}
                    onClick={() => add({})}
                    className="staff-add-assignment"
                  >
                    Thêm cửa hàng / vai trò
                  </Button>
                  <Form.ErrorList errors={errors} />
                </>
              )}
            </Form.List>

            {selectedRoles.map((row) => {
              const role = roleByCode.get(row.roleCode!);
              return role ? (
                <RoleSummary key={role.code} role={role} scopeLabel={scopeLabel(row.scope)} />
              ) : null;
            })}

            <div className="staff-check-box" role="note">
              <WarningOutlined aria-hidden /> Kiểm tra đúng cửa hàng và vai trò trước khi tạo.
            </div>
            {serverError ? (
              <Alert type="error" showIcon title={serverError} className="staff-server-error" />
            ) : null}
          </section>
        </div>

        <div className="staff-form-footer">
          <span>
            <span className="staff-required">*</span> Thông tin bắt buộc
          </span>
          <Space>
            <Button onClick={close} disabled={busy}>
              Hủy
            </Button>
            <Button type="primary" htmlType="submit" loading={busy} disabled={false}>
              {mode === "live" ? "Tạo nhân viên" : "Tạo nhân viên mẫu"}
            </Button>
          </Space>
        </div>
      </Form>
    </Modal>
  );
}

const SUMMARY_LIMIT = 6;

/** Tóm tắt quyền lấy từ dữ liệu vai trò của máy chủ — không có danh sách viết cứng. */
function RoleSummary({ role, scopeLabel }: { role: RoleItem; scopeLabel: string }) {
  const [expanded, setExpanded] = useState(false);
  const details = role.permissionDetails ?? [];
  const shown = expanded ? details : details.slice(0, SUMMARY_LIMIT);
  return (
    <div className="staff-permissions">
      <h4>
        <SafetyCertificateOutlined aria-hidden /> Quyền theo vai trò {role.name}
      </h4>
      {scopeLabel ? <p className="staff-permissions-scope">Áp dụng tại {scopeLabel}</p> : null}
      <ul>
        {shown.map((permission) => (
          <li key={permission.code}>
            <CheckCircleFilled aria-hidden /> {permission.description}
          </li>
        ))}
      </ul>
      {details.length > SUMMARY_LIMIT ? (
        <Button type="link" size="small" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Thu gọn" : `Xem tất cả ${details.length} quyền`}
        </Button>
      ) : null}
      <small>Danh sách lấy từ cấu hình vai trò trên máy chủ.</small>
    </div>
  );
}
