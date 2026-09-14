import { PlusOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Drawer, Form, Input, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import { useEffect, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import {
  type Envelope,
  type RoleItem,
  type StoreDetail,
  type UserDetail,
  type UserListItem,
  type UserRoleAssignment,
} from "../../api/types.js";
import { useAuth } from "../auth/AuthProvider.js";

/** Quản lý tài khoản nhân viên và vai trò (contract §21). */
export function UsersPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ["users", search],
    queryFn: async () =>
      (await http.get<Envelope<UserListItem[]>>("/users", { params: { search: search || undefined } })).data.data,
  });

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["users"] });
  }

  return (
    <Card
      title="Người dùng"
      extra={
        <Space>
          <Input.Search allowClear placeholder="Tìm theo tên hoặc tên đăng nhập" style={{ width: 280 }} onSearch={setSearch} />
          {can("user.manage") ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              Thêm tài khoản
            </Button>
          ) : null}
        </Space>
      }
    >
      <Table
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={list.data ?? []}
        onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
        pagination={false}
        locale={{ emptyText: list.isError ? getErrorMessage(list.error, "Không tải được danh sách") : "Chưa có tài khoản" }}
        columns={[
          { title: "Tên đăng nhập", dataIndex: "username", width: 160 },
          { title: "Họ tên", dataIndex: "fullName" },
          { title: "Điện thoại", dataIndex: "phone", width: 140, render: (value) => value ?? "—" },
          {
            title: "Vai trò",
            render: (_, row: UserListItem) => (
              <Space wrap size={4}>
                {row.roles.length === 0 ? <Typography.Text type="secondary">Chưa gán</Typography.Text> : null}
                {row.roles.map((role, index) => (
                  <Tag key={`${role.roleCode}-${role.storeId ?? "chain"}-${index}`}>
                    {role.roleName}
                    {role.storeId ? "" : " (toàn chuỗi)"}
                  </Tag>
                ))}
              </Space>
            ),
          },
          {
            title: "Trạng thái",
            width: 110,
            render: (_, row: UserListItem) => (row.isActive ? <Tag color="green">Đang dùng</Tag> : <Tag>Ngừng dùng</Tag>),
          },
        ]}
      />

      <UserDrawer id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />
      <CreateUserModal open={creating} onClose={() => setCreating(false)} onCreated={async (id) => { setCreating(false); await refresh(); setOpenId(id); }} />
    </Card>
  );
}

function TempPasswordAlert({ username, tempPassword }: { username: string; tempPassword: string }) {
  return (
    <Alert
      type="success"
      showIcon
      message={`Mật khẩu tạm cho "${username}"`}
      description={
        <Space direction="vertical">
          <Typography.Text>Chỉ hiển thị đúng một lần — chép hoặc chụp lại ngay để gửi cho nhân viên.</Typography.Text>
          <Typography.Text code copyable style={{ fontSize: 16 }}>
            {tempPassword}
          </Typography.Text>
        </Space>
      }
    />
  );
}

function CreateUserModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const [form] = Form.useForm<{ username: string; fullName: string; phone?: string; practiceCertificateNumber?: string }>();
  const [created, setCreated] = useState<{ id: string; username: string; tempPassword: string } | null>(null);

  useEffect(() => {
    if (open) setCreated(null);
  }, [open]);

  const create = useMutation({
    mutationFn: async (values: { username: string; fullName: string; phone?: string; practiceCertificateNumber?: string }) => {
      const response = await http.post<Envelope<UserDetail & { tempPassword: string }>>("/users", values);
      return response.data.data;
    },
    onSuccess: (data) => setCreated({ id: data.id, username: data.username, tempPassword: data.tempPassword }),
    onError: (error) => void message.error(getErrorMessage(error, "Không tạo được tài khoản")),
  });

  return (
    <Modal
      open={open}
      title="Thêm tài khoản"
      okText={created ? "Xong" : "Tạo tài khoản"}
      cancelText="Hủy"
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      onOk={() => (created ? void onCreated(created.id) : void form.validateFields().then((values) => create.mutate(values)))}
      confirmLoading={create.isPending}
      destroyOnHidden
    >
      {created ? (
        <TempPasswordAlert username={created.username} tempPassword={created.tempPassword} />
      ) : (
        <Form form={form} layout="vertical">
          <Form.Item name="username" label="Tên đăng nhập" rules={[{ required: true, message: "Nhập tên đăng nhập" }]}>
            <Input placeholder="vd: duocsi2" autoFocus />
          </Form.Item>
          <Form.Item name="fullName" label="Họ tên" rules={[{ required: true, whitespace: true, message: "Nhập họ tên" }]}>
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="Số điện thoại">
            <Input />
          </Form.Item>
          <Form.Item name="practiceCertificateNumber" label="Số chứng chỉ hành nghề (nếu có)">
            <Input />
          </Form.Item>
          <Typography.Paragraph type="secondary">
            Hệ thống tự sinh mật khẩu tạm; tài khoản phải đổi mật khẩu ở lần đăng nhập đầu tiên.
          </Typography.Paragraph>
        </Form>
      )}
    </Modal>
  );
}

function UserDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [changingRoles, setChangingRoles] = useState(false);
  const [resetResult, setResetResult] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ["user", id],
    enabled: id !== null,
    queryFn: async () => (await http.get<Envelope<UserDetail>>(`/users/${id}`)).data.data,
  });

  async function refresh(): Promise<void> {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["user", id] }), onChanged()]);
  }

  const toggleActive = useMutation({
    mutationFn: () => http.post(`/users/${id}/${detail.data?.isActive ? "deactivate" : "activate"}`),
    onSuccess: async () => {
      void message.success(detail.data?.isActive ? "Đã vô hiệu hóa tài khoản" : "Đã kích hoạt lại tài khoản");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không cập nhật được trạng thái")),
  });

  const resetPassword = useMutation({
    mutationFn: async () => (await http.post<Envelope<{ tempPassword: string }>>(`/users/${id}/reset-password`)).data.data,
    onSuccess: (data) => setResetResult(data.tempPassword),
    onError: (error) => void message.error(getErrorMessage(error, "Không đặt lại được mật khẩu")),
  });

  const user = detail.data;

  return (
    <Drawer
      width={560}
      open={id !== null}
      onClose={() => {
        setResetResult(null);
        onClose();
      }}
      title={user?.fullName ?? "Chi tiết tài khoản"}
      extra={
        user && can("user.manage") ? (
          <Space>
            <Button danger={user.isActive} loading={toggleActive.isPending} onClick={() => toggleActive.mutate()}>
              {user.isActive ? "Vô hiệu hóa" : "Kích hoạt lại"}
            </Button>
            <Button loading={resetPassword.isPending} onClick={() => resetPassword.mutate()}>
              Đặt lại mật khẩu
            </Button>
            <Button onClick={() => setChangingRoles(true)}>Đổi vai trò</Button>
            <Button type="primary" onClick={() => setEditing(true)}>
              Sửa
            </Button>
          </Space>
        ) : null
      }
    >
      {user ? (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {resetResult ? <TempPasswordAlert username={user.username} tempPassword={resetResult} /> : null}
          <Typography.Text type="secondary">Tên đăng nhập: {user.username}</Typography.Text>
          <Typography.Text>Điện thoại: {user.phone ?? "—"}</Typography.Text>
          <Typography.Text>Số chứng chỉ hành nghề: {user.practiceCertificateNumber ?? "—"}</Typography.Text>
          {user.mustChangePassword ? <Alert type="info" showIcon message="Chưa đổi mật khẩu tạm ở lần đăng nhập đầu" /> : null}
          <div>
            <Typography.Text type="secondary">Vai trò</Typography.Text>
            <div style={{ marginTop: 6 }}>
              {user.roles.length === 0 ? (
                <Typography.Text type="secondary">Chưa gán vai trò nào</Typography.Text>
              ) : (
                <Space direction="vertical" size={4}>
                  {user.roles.map((role, index) => (
                    <Tag key={`${role.roleCode}-${index}`}>
                      {role.roleName} — {role.storeId ? (role.storeName ?? role.storeId) : "toàn chuỗi"}
                    </Tag>
                  ))}
                </Space>
              )}
            </div>
          </div>
        </Space>
      ) : null}

      {user ? <EditUserModal open={editing} user={user} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await refresh(); }} /> : null}
      {user ? <ChangeRolesModal open={changingRoles} user={user} onClose={() => setChangingRoles(false)} onSaved={async () => { setChangingRoles(false); await refresh(); }} /> : null}
    </Drawer>
  );
}

function EditUserModal({ open, user, onClose, onSaved }: { open: boolean; user: UserDetail; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form] = Form.useForm<{ fullName: string; phone?: string; practiceCertificateNumber?: string }>();

  const save = useMutation({
    mutationFn: (values: { fullName: string; phone?: string; practiceCertificateNumber?: string }) =>
      http.patch(`/users/${user.id}`, { ...values, version: user.version }),
    onSuccess: async () => {
      void message.success("Đã lưu thông tin tài khoản");
      await onSaved();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được thông tin")),
  });

  return (
    <Modal
      open={open}
      title="Sửa thông tin tài khoản"
      okText="Lưu"
      cancelText="Hủy"
      onCancel={onClose}
      onOk={() => void form.validateFields().then((values) => save.mutate(values))}
      confirmLoading={save.isPending}
      afterOpenChange={(visible) => {
        if (visible) form.setFieldsValue({ fullName: user.fullName, phone: user.phone ?? "", practiceCertificateNumber: user.practiceCertificateNumber ?? "" });
      }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <Form.Item name="fullName" label="Họ tên" rules={[{ required: true, whitespace: true, message: "Nhập họ tên" }]}>
          <Input />
        </Form.Item>
        <Form.Item name="phone" label="Số điện thoại">
          <Input />
        </Form.Item>
        <Form.Item name="practiceCertificateNumber" label="Số chứng chỉ hành nghề">
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}

type RoleRow = { key: string; roleCode: string; storeId: string | null };

function ChangeRolesModal({ open, user, onClose, onSaved }: { open: boolean; user: UserDetail; onClose: () => void; onSaved: () => Promise<void> }) {
  const [rows, setRows] = useState<RoleRow[]>([]);

  const roles = useQuery({
    queryKey: ["all-roles"],
    enabled: open,
    queryFn: async () => (await http.get<Envelope<RoleItem[]>>("/roles")).data.data,
  });
  const stores = useQuery({
    queryKey: ["all-stores"],
    enabled: open,
    queryFn: async () => (await http.get<Envelope<{ items: StoreDetail[] }>>("/stores")).data.data.items,
  });

  useEffect(() => {
    if (!open) return;
    setRows(
      user.roles.map((role: UserRoleAssignment, index: number) => ({
        key: `${role.roleCode}-${index}`,
        roleCode: role.roleCode,
        storeId: role.storeId,
      })),
    );
  }, [open, user.roles]);

  const save = useMutation({
    mutationFn: () =>
      http.put(
        `/users/${user.id}/roles`,
        rows.map((row) => ({ roleCode: row.roleCode, storeId: row.storeId })),
      ),
    onSuccess: async () => {
      void message.success("Đã cập nhật vai trò");
      await onSaved();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không cập nhật được vai trò")),
  });

  return (
    <Modal
      open={open}
      title={`Đổi vai trò — ${user.fullName}`}
      okText="Lưu vai trò"
      cancelText="Hủy"
      onCancel={onClose}
      onOk={() => save.mutate()}
      confirmLoading={save.isPending}
      width={600}
      destroyOnHidden
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Typography.Paragraph type="secondary">
          Để trống "Phạm vi" nghĩa là vai trò áp dụng toàn chuỗi. Lưu sẽ thay toàn bộ danh sách vai trò hiện có và đăng xuất mọi phiên đang đăng nhập của người này.
        </Typography.Paragraph>
        {rows.map((row) => (
          <Space key={row.key} style={{ width: "100%" }}>
            <Select
              style={{ width: 220 }}
              placeholder="Vai trò"
              loading={roles.isLoading}
              value={row.roleCode || undefined}
              onChange={(roleCode) => setRows((current) => current.map((item) => (item.key === row.key ? { ...item, roleCode } : item)))}
              options={(roles.data ?? []).map((role) => ({ value: role.code, label: role.name }))}
            />
            <Select
              allowClear
              style={{ width: 220 }}
              placeholder="Toàn chuỗi"
              loading={stores.isLoading}
              value={row.storeId ?? undefined}
              onChange={(storeId) => setRows((current) => current.map((item) => (item.key === row.key ? { ...item, storeId: storeId ?? null } : item)))}
              options={(stores.data ?? []).map((store) => ({ value: store.id, label: `${store.code} — ${store.name}` }))}
            />
            <Button danger onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}>
              Xóa
            </Button>
          </Space>
        ))}
        <Button onClick={() => setRows((current) => [...current, { key: crypto.randomUUID(), roleCode: "", storeId: null }])}>
          Thêm vai trò
        </Button>
      </Space>
    </Modal>
  );
}
