import { DeleteOutlined, EditOutlined, KeyOutlined, PlusOutlined, PoweroffOutlined, SafetyOutlined, UserOutlined, UserSwitchOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Card, Empty, Form, Input, Modal, Popconfirm, Select, Skeleton, Table, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { type Envelope, type RoleItem, type StoreDetail, type UserDetail, type UserListItem, type UserRoleAssignment } from "../../api/types.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { PanelEmpty } from "../../ui/PanelEmpty.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";

/** Quản lý tài khoản nhân viên và vai trò (contract §21). */
export function UsersPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();
  const term = useDebounced(search.trim(), 300);

  const list = useQuery({
    queryKey: ["users", term],
    queryFn: async () => (await http.get<Envelope<UserListItem[]>>("/users", { params: { search: term || undefined } })).data.data,
    placeholderData: (previous) => previous,
  });

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["users"] });
  }

  return (
    <div>
      <PageHeader
        icon={<UserSwitchOutlined />}
        title="Nhân viên"
        description="Tài khoản đăng nhập và vai trò theo từng cửa hàng. Mỗi thay đổi vai trò đều đăng xuất các phiên cũ của người đó."
        extra={
          can("user.manage") ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              Thêm tài khoản
            </Button>
          ) : null
        }
      />
      <div className="split-layout">
        <Card>
          <div className="toolbar">
            <Input.Search allowClear className="toolbar-grow" placeholder="Tìm theo họ tên hoặc tên đăng nhập" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <Table
            rowKey="id"
            loading={list.isFetching}
            dataSource={list.data ?? []}
            scroll={{ x: 640 }}
            onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
            rowClassName={(row) => (row.id === openId ? "row-selected" : "")}
            pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={list.isError ? getErrorMessage(list.error, "Không tải được danh sách") : "Chưa có tài khoản"} /> }}
            columns={[
              {
                title: "Nhân viên",
                key: "name",
                render: (_: unknown, row: UserListItem) => (
                  <div className="person-cell">
                    <span className="person-avatar">
                      <UserOutlined />
                    </span>
                    <div className="cell-main">
                      <strong>{row.fullName}</strong>
                      <span className="mono">@{row.username}</span>
                    </div>
                  </div>
                ),
              },
              {
                title: "Vai trò",
                key: "roles",
                render: (_: unknown, row: UserListItem) =>
                  row.roles.length === 0 ? (
                    <Typography.Text type="secondary">Chưa gán</Typography.Text>
                  ) : (
                    row.roles.map((role, index) => (
                      <Tag key={`${role.roleCode}-${role.storeId ?? "chain"}-${index}`} color={role.storeId ? "blue" : "purple"} style={{ marginBottom: 2 }}>
                        {role.roleName}
                        {role.storeId ? "" : " · toàn chuỗi"}
                      </Tag>
                    ))
                  ),
              },
              { title: "Trạng thái", key: "active", width: 120, render: (_: unknown, row: UserListItem) => (row.isActive ? <Tag color="green">Đang dùng</Tag> : <Tag>Đã khóa</Tag>) },
            ]}
          />
        </Card>
        <aside className="split-aside">
          <UserPanel id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />
        </aside>
      </div>
      <CreateUserModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={async (id) => {
          setCreating(false);
          await refresh();
          setOpenId(id);
        }}
      />
    </div>
  );
}

function TempPasswordAlert({ username, tempPassword }: { username: string; tempPassword: string }) {
  return (
    <Alert
      type="success"
      showIcon
      title={`Mật khẩu tạm cho “${username}”`}
      description={
        <div className="detail-stack" style={{ gap: 8 }}>
          <span>Chỉ hiển thị đúng một lần — chép lại ngay để gửi cho nhân viên.</span>
          <Typography.Text code copyable style={{ fontSize: 16 }}>
            {tempPassword}
          </Typography.Text>
        </div>
      }
    />
  );
}

type CreateUserValues = { username: string; fullName: string; phone?: string; practiceCertificateNumber?: string };

function CreateUserModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<CreateUserValues>();
  const [created, setCreated] = useState<{ id: string; username: string; tempPassword: string } | null>(null);

  useEffect(() => {
    if (open) setCreated(null);
  }, [open]);

  const create = useMutation({
    mutationFn: async (values: CreateUserValues) => (await http.post<Envelope<UserDetail & { tempPassword: string }>>("/users", values)).data.data,
    onSuccess: (data) => setCreated({ id: data.id, username: data.username, tempPassword: data.tempPassword }),
    onError: (error) => void message.error(getErrorMessage(error, "Không tạo được tài khoản")),
  });

  return (
    <Modal
      open={open}
      title="Thêm tài khoản"
      okText={created ? "Xong" : "Tạo tài khoản"}
      cancelText="Hủy"
      cancelButtonProps={{ hidden: created !== null }}
      onCancel={() => {
        form.resetFields();
        if (created) void onCreated(created.id);
        else onClose();
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
            <Input placeholder="Ví dụ: duocsi2" autoFocus />
          </Form.Item>
          <Form.Item name="fullName" label="Họ tên" rules={[{ required: true, whitespace: true, message: "Nhập họ tên" }]}>
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="Số điện thoại">
            <Input inputMode="tel" />
          </Form.Item>
          <Form.Item name="practiceCertificateNumber" label="Số chứng chỉ hành nghề (nếu có)">
            <Input />
          </Form.Item>
          <Typography.Paragraph type="secondary">Hệ thống tự sinh mật khẩu tạm; nhân viên cần đổi mật khẩu sau lần đăng nhập đầu tiên. Gán vai trò sau khi tạo.</Typography.Paragraph>
        </Form>
      )}
    </Modal>
  );
}

function UserPanel({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const { can, me } = useAuth();
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [changingRoles, setChangingRoles] = useState(false);
  const [resetResult, setResetResult] = useState<{ userId: string; password: string } | null>(null);
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
      void message.success(detail.data?.isActive ? "Đã khóa tài khoản" : "Đã kích hoạt lại tài khoản");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không cập nhật được trạng thái")),
  });

  const resetPassword = useMutation({
    mutationFn: async () => (await http.post<Envelope<{ tempPassword: string }>>(`/users/${id}/reset-password`)).data.data,
    onSuccess: (data) => setResetResult({ userId: id!, password: data.tempPassword }),
    onError: (error) => void message.error(getErrorMessage(error, "Không đặt lại được mật khẩu")),
  });

  if (id === null) {
    return (
      <Card title="Chi tiết tài khoản">
        <PanelEmpty icon={<UserOutlined />} title="Chưa chọn nhân viên" description="Bấm vào một tài khoản để xem vai trò, đặt lại mật khẩu hoặc khóa tài khoản." />
      </Card>
    );
  }

  const user = detail.data;
  const isSelf = user?.id === me?.user.id;

  return (
    <Card
      title="Chi tiết tài khoản"
      extra={
        <Button type="text" size="small" onClick={onClose}>
          Đóng
        </Button>
      }
    >
      {detail.isLoading || !user ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : (
        <div className="detail-stack">
          <div className="person-head">
            <span className="person-avatar lg">
              <UserOutlined />
            </span>
            <div>
              <h3 className="detail-title">{user.fullName}</h3>
              <span className="detail-sub">
                <span className="mono">@{user.username}</span> · {user.isActive ? <Tag color="green">Đang dùng</Tag> : <Tag>Đã khóa</Tag>}
              </span>
            </div>
          </div>
          {resetResult?.userId === user.id ? <TempPasswordAlert username={user.username} tempPassword={resetResult.password} /> : null}
          {user.mustChangePassword ? <Alert type="info" showIcon title="Nhân viên chưa đổi mật khẩu tạm." /> : null}
          <dl className="kv-list">
            <div>
              <dt>Điện thoại</dt>
              <dd>{user.phone ?? "—"}</dd>
            </div>
            <div>
              <dt>Chứng chỉ hành nghề</dt>
              <dd>{user.practiceCertificateNumber ?? "—"}</dd>
            </div>
          </dl>

          <div className="line-list">
            <div className="line-list-head">
              <span>
                <SafetyOutlined /> Vai trò
              </span>
              {can("user.manage") && !isSelf ? (
                <Button size="small" type="link" onClick={() => setChangingRoles(true)}>
                  Đổi vai trò
                </Button>
              ) : null}
            </div>
            {user.roles.length === 0 ? (
              <div className="line-item">
                <span>Chưa gán vai trò nào — tài khoản chưa dùng được hệ thống.</span>
              </div>
            ) : (
              user.roles.map((role, index) => (
                <div className="line-item" key={`${role.roleCode}-${index}`}>
                  <div className="line-item-main">
                    <strong>{role.roleName}</strong>
                    <span>{role.storeId ? (role.storeName ?? role.storeId) : "Toàn chuỗi"}</span>
                  </div>
                </div>
              ))
            )}
          </div>

          {can("user.manage") ? (
            <div className="panel-actions-row">
              <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
                Sửa thông tin
              </Button>
              <Popconfirm title="Đặt lại mật khẩu?" description="Mật khẩu tạm mới sẽ hiện một lần, mọi phiên đăng nhập của người này bị đăng xuất." okText="Đặt lại" cancelText="Quay lại" onConfirm={() => resetPassword.mutate()}>
                <Button icon={<KeyOutlined />} loading={resetPassword.isPending}>
                  Đặt lại mật khẩu
                </Button>
              </Popconfirm>
              {!isSelf ? (
                <Popconfirm
                  title={user.isActive ? "Khóa tài khoản này?" : "Kích hoạt lại tài khoản này?"}
                  okText={user.isActive ? "Khóa" : "Kích hoạt"}
                  okButtonProps={{ danger: user.isActive }}
                  cancelText="Quay lại"
                  onConfirm={() => toggleActive.mutate()}
                >
                  <Button danger={user.isActive} icon={<PoweroffOutlined />} loading={toggleActive.isPending}>
                    {user.isActive ? "Khóa tài khoản" : "Kích hoạt lại"}
                  </Button>
                </Popconfirm>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {user ? (
        <EditUserModal
          open={editing}
          user={user}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await refresh();
          }}
        />
      ) : null}
      {user ? (
        <ChangeRolesModal
          open={changingRoles}
          user={user}
          onClose={() => setChangingRoles(false)}
          onSaved={async () => {
            setChangingRoles(false);
            await refresh();
          }}
        />
      ) : null}
    </Card>
  );
}

type EditUserValues = { fullName: string; phone?: string; practiceCertificateNumber?: string };

function EditUserModal({ open, user, onClose, onSaved }: { open: boolean; user: UserDetail; onClose: () => void; onSaved: () => Promise<void> }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<EditUserValues>();

  const save = useMutation({
    mutationFn: (values: EditUserValues) => http.patch(`/users/${user.id}`, { ...values, version: user.version }),
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
          <Input inputMode="tel" />
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
  const { message } = App.useApp();
  const [rows, setRows] = useState<RoleRow[]>([]);

  const roles = useQuery({ queryKey: ["all-roles"], enabled: open, queryFn: async () => (await http.get<Envelope<RoleItem[]>>("/roles")).data.data });
  const stores = useQuery({ queryKey: ["all-stores"], enabled: open, queryFn: async () => (await http.get<Envelope<{ items: StoreDetail[] }>>("/stores")).data.data.items });

  useEffect(() => {
    if (!open) return;
    setRows(user.roles.map((role: UserRoleAssignment, index: number) => ({ key: `${role.roleCode}-${index}`, roleCode: role.roleCode, storeId: role.storeId })));
  }, [open, user.roles]);

  const save = useMutation({
    mutationFn: () => http.put(`/users/${user.id}/roles`, rows.map((row) => ({ roleCode: row.roleCode, storeId: row.storeId }))),
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
      okButtonProps={{ disabled: rows.some((row) => !row.roleCode) }}
      confirmLoading={save.isPending}
      width={640}
      destroyOnHidden
    >
      <div className="detail-stack">
        <Alert type="warning" showIcon title="Lưu sẽ thay toàn bộ vai trò hiện có và đăng xuất mọi phiên đang đăng nhập của người này." />
        {rows.map((row) => (
          <div key={row.key} className="role-row">
            <Select
              placeholder="Chọn vai trò"
              loading={roles.isLoading}
              value={row.roleCode || undefined}
              onChange={(roleCode) => setRows((current) => current.map((item) => (item.key === row.key ? { ...item, roleCode } : item)))}
              options={(roles.data ?? []).map((role) => ({ value: role.code, label: role.name }))}
            />
            <Select
              allowClear
              placeholder="Toàn chuỗi"
              loading={stores.isLoading}
              value={row.storeId ?? undefined}
              onChange={(storeId) => setRows((current) => current.map((item) => (item.key === row.key ? { ...item, storeId: storeId ?? null } : item)))}
              options={(stores.data ?? []).map((store) => ({ value: store.id, label: `${store.code} — ${store.name}` }))}
            />
            <Button type="text" danger icon={<DeleteOutlined />} aria-label="Xóa vai trò" onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))} />
          </div>
        ))}
        <Button type="dashed" icon={<PlusOutlined />} onClick={() => setRows((current) => [...current, { key: crypto.randomUUID(), roleCode: "", storeId: null }])}>
          Thêm vai trò
        </Button>
        <Typography.Text type="secondary">Để trống “Phạm vi” nghĩa là vai trò áp dụng cho toàn chuỗi.</Typography.Text>
      </div>
    </Modal>
  );
}
