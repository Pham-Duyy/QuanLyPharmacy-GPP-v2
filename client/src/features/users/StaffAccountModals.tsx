import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { useMutation } from "@tanstack/react-query";
import { Alert, App, Button, Checkbox, Form, Input, Modal, Select, Typography } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import type { UserDetail } from "../../api/types.js";
import { useRoles } from "./staff-api.js";
import { CHAIN_SCOPE, scopeToStoreId, storeIdToScope, useManagedScopes } from "./staff-scope.js";

/** Mật khẩu tạm do máy chủ sinh khi đặt lại — hiện đúng một lần. */
export function TempPasswordAlert({
  username,
  tempPassword,
  onDismiss,
}: {
  username: string;
  tempPassword: string;
  onDismiss: () => void;
}) {
  return (
    <Alert
      type="success"
      showIcon
      closable={{ onClose: onDismiss, "aria-label": "Đóng thông báo mật khẩu tạm" }}
      title={`Mật khẩu tạm cho “${username}”`}
      description={
        <div className="staff-temp-password">
          <span>
            Chỉ hiển thị một lần — chép lại ngay để gửi cho nhân viên. Nhân viên phải đổi mật khẩu
            khi đăng nhập.
          </span>
          <Typography.Text code copyable>
            {tempPassword}
          </Typography.Text>
        </div>
      }
    />
  );
}

type EditUserValues = { fullName: string; phone?: string; practiceCertificateNumber?: string };

export function EditUserModal({
  open,
  user,
  onClose,
  onSaved,
}: {
  open: boolean;
  user: UserDetail;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<EditUserValues>();

  const save = useMutation({
    mutationFn: (values: EditUserValues) =>
      http.patch(`/users/${user.id}`, { ...values, version: user.version }),
    onSuccess: async () => {
      void message.success("Đã lưu thông tin nhân viên");
      await onSaved();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được thông tin")),
  });

  return (
    <Modal
      open={open}
      title="Sửa thông tin nhân viên"
      okText="Lưu"
      cancelText="Hủy"
      onCancel={onClose}
      onOk={() => void form.validateFields().then((values) => save.mutate(values))}
      okButtonProps={{ loading: save.isPending }}
      cancelButtonProps={{ disabled: save.isPending }}
      afterOpenChange={(visible) => {
        if (visible)
          form.setFieldsValue({
            fullName: user.fullName,
            phone: user.phone ?? "",
            practiceCertificateNumber: user.practiceCertificateNumber ?? "",
          });
      }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" disabled={save.isPending}>
        <Form.Item
          name="fullName"
          label="Họ và tên"
          rules={[{ required: true, whitespace: true, message: "Nhập họ và tên" }]}
        >
          <Input />
        </Form.Item>
        <Form.Item
          name="phone"
          label="Số điện thoại"
          rules={[{ max: 20, message: "Tối đa 20 ký tự" }]}
        >
          <Input inputMode="tel" />
        </Form.Item>
        <Form.Item name="practiceCertificateNumber" label="Số chứng chỉ hành nghề">
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}

type RoleRow = {
  key: string;
  roleCode: string;
  /** Mã cửa hàng, CHAIN_SCOPE, hoặc rỗng khi chưa chọn — không ngầm hiểu là toàn chuỗi. */
  scope: string;
  additionalPermissions: string[];
  qualificationReference: string;
  responsibleProfessional: boolean;
};

const rowKey = (row: Pick<RoleRow, "roleCode" | "scope">) => `${row.roleCode}:${row.scope}`;

export function ChangeRolesModal({
  open,
  user,
  onClose,
  onSaved,
}: {
  open: boolean;
  user: UserDetail;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { message } = App.useApp();
  // Hộp thoại được mount khi mở (xem StaffProfile), nên khởi tạo một lần từ vai trò hiện có.
  const [rows, setRows] = useState<RoleRow[]>(() =>
    user.roles.map((role, index) => ({
      key: `${role.roleCode}-${index}`,
      roleCode: role.roleCode,
      scope: storeIdToScope(role.storeId),
      additionalPermissions: role.additionalPermissions ?? [],
      qualificationReference: role.qualificationReference ?? "",
      responsibleProfessional: role.responsibleProfessional ?? false,
    })),
  );
  const roles = useRoles(open);
  const scopes = useManagedScopes();

  const update = (key: string, patch: Partial<RoleRow>) =>
    setRows((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  const duplicates = new Set(
    rows
      .filter(
        (row, index) =>
          row.roleCode &&
          row.scope &&
          rows.findIndex((other) => rowKey(other) === rowKey(row)) !== index,
      )
      .map(rowKey),
  );
  const problems = [
    rows.some((row) => !row.roleCode || !row.scope)
      ? "Chọn đủ vai trò và phạm vi cho từng dòng."
      : null,
    duplicates.size ? "Có cặp vai trò – phạm vi bị trùng." : null,
    rows.some((row) => row.roleCode === "pharmacist" && !row.qualificationReference.trim())
      ? "Vai trò Dược sĩ cần ghi căn cứ đã kiểm tra chuyên môn."
      : null,
  ].filter(Boolean);

  const save = useMutation({
    mutationFn: () =>
      http.put(
        `/users/${user.id}/roles`,
        rows.map((row) => ({
          roleCode: row.roleCode,
          storeId: scopeToStoreId(row.scope),
          additionalPermissions: row.additionalPermissions,
          qualificationReference: row.qualificationReference.trim() || null,
          responsibleProfessional: row.responsibleProfessional,
        })),
      ),
    onSuccess: async () => {
      void message.success("Đã cập nhật vai trò");
      await onSaved();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không cập nhật được vai trò")),
  });

  const scopeOptions = (current: string) => [
    ...(scopes.canChain || current === CHAIN_SCOPE
      ? [{ value: CHAIN_SCOPE, label: "Toàn chuỗi (mọi cửa hàng)", disabled: !scopes.canChain }]
      : []),
    ...scopes.stores.map((store) => ({ value: store.id, label: `${store.code} — ${store.name}` })),
    // Phạm vi cũ ngoài quyền quản lý của người sửa: vẫn hiện để không mất thông tin, nhưng không chọn mới được.
    ...(current && current !== CHAIN_SCOPE && !scopes.stores.some((store) => store.id === current)
      ? [
          {
            value: current,
            label:
              user.roles.find((role) => role.storeId === current)?.storeName ?? "Cửa hàng khác",
            disabled: true,
          },
        ]
      : []),
  ];

  return (
    <Modal
      open={open}
      title={`Quản lý vai trò — ${user.fullName}`}
      okText="Lưu vai trò"
      cancelText="Hủy"
      onCancel={onClose}
      onOk={() => save.mutate()}
      okButtonProps={{ disabled: problems.length > 0, loading: save.isPending }}
      cancelButtonProps={{ disabled: save.isPending }}
      width={780}
      destroyOnHidden
    >
      <div className="staff-roles-editor">
        <Alert
          type="warning"
          showIcon
          title="Lưu sẽ thay toàn bộ vai trò hiện có và đăng xuất mọi phiên đang đăng nhập của người này."
        />
        {rows.map((row) => (
          <div key={row.key} className="staff-role-block">
            <div className="staff-role-row">
              <Select
                aria-label="Vai trò"
                placeholder="Chọn vai trò"
                loading={roles.isLoading}
                value={row.roleCode || undefined}
                status={duplicates.has(rowKey(row)) ? "error" : undefined}
                onChange={(roleCode) =>
                  update(row.key, {
                    roleCode,
                    additionalPermissions: [],
                    responsibleProfessional: false,
                    qualificationReference: "",
                  })
                }
                options={(roles.data ?? []).map((role) => ({ value: role.code, label: role.name }))}
              />
              <Select
                aria-label="Phạm vi"
                placeholder="Chọn cửa hàng hoặc toàn chuỗi"
                value={row.scope || undefined}
                status={duplicates.has(rowKey(row)) ? "error" : undefined}
                onChange={(scope: string) =>
                  update(row.key, {
                    scope,
                    additionalPermissions: [],
                    responsibleProfessional: false,
                  })
                }
                options={scopeOptions(row.scope)}
              />
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                aria-label="Xóa dòng vai trò"
                onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}
              />
            </div>
            {row.roleCode === "pharmacist" ? (
              <div className="staff-role-extra">
                <label className="staff-field-label" htmlFor={`qual-${row.key}`}>
                  Căn cứ đã kiểm tra bằng cấp chuyên môn
                </label>
                <Input
                  id={`qual-${row.key}`}
                  maxLength={500}
                  placeholder="Trình độ, số văn bằng hoặc mã hồ sơ đã đối chiếu"
                  value={row.qualificationReference}
                  status={row.qualificationReference.trim() ? undefined : "error"}
                  onChange={(event) =>
                    update(row.key, { qualificationReference: event.target.value })
                  }
                />
                <Typography.Text type="secondary">
                  Người lưu xác nhận đã kiểm tra hồ sơ phù hợp với công việc. Thông tin nhập không
                  thay thế việc xác minh văn bằng.
                </Typography.Text>
                {row.scope && row.scope !== CHAIN_SCOPE ? (
                  <>
                    <label className="staff-field-label" htmlFor={`extra-${row.key}`}>
                      Quyền bổ sung tại cửa hàng
                    </label>
                    <Select
                      id={`extra-${row.key}`}
                      mode="multiple"
                      placeholder="Chỉ cấp quyền theo nhiệm vụ được phân công"
                      value={row.additionalPermissions}
                      options={(
                        roles.data?.find((role) => role.code === row.roleCode)
                          ?.additionalPermissions ?? []
                      ).map((permission) => ({
                        value: permission.code,
                        label: permission.description,
                      }))}
                      onChange={(additionalPermissions: string[]) =>
                        update(row.key, { additionalPermissions })
                      }
                    />
                    <Checkbox
                      checked={row.responsibleProfessional}
                      disabled={!user.practiceCertificateNumber?.trim() || !user.isActive}
                      onChange={(event) =>
                        update(row.key, { responsibleProfessional: event.target.checked })
                      }
                    >
                      Phân công chịu trách nhiệm chuyên môn tại cửa hàng này
                    </Checkbox>
                    <Typography.Text type="secondary">
                      Cần hồ sơ chứng chỉ hành nghề và tài khoản đang hoạt động. Chức danh này không
                      tự cấp thêm quyền.
                    </Typography.Text>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        <Button
          type="dashed"
          icon={<PlusOutlined />}
          onClick={() =>
            setRows((current) => [
              ...current,
              {
                key: crypto.randomUUID(),
                roleCode: "",
                scope: "",
                additionalPermissions: [],
                qualificationReference: "",
                responsibleProfessional: false,
              },
            ])
          }
        >
          Thêm vai trò
        </Button>
        {problems.length ? (
          <div className="staff-form-errors" role="alert">
            {problems.map((problem) => (
              <span key={problem}>{problem}</span>
            ))}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
