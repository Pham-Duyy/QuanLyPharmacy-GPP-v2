import { PlusOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Drawer, Form, Input, Modal, Space, Table, Tag, Typography, message } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { type Envelope, type StoreDetail } from "../../api/types.js";
import { useAuth } from "../auth/AuthProvider.js";

type StoreListItem = { id: string; code: string; name: string; address: string | null; phone: string | null };

/** Quản lý cửa hàng trong chuỗi (contract §21). */
export function StoresPage() {
  const { can } = useAuth();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ["all-stores-page"],
    queryFn: async () => (await http.get<Envelope<{ items: StoreListItem[] }>>("/stores")).data.data.items,
  });

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["all-stores-page"] });
  }

  return (
    <Card
      title="Cửa hàng"
      extra={
        can("store.manage") ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            Mở cửa hàng mới
          </Button>
        ) : null
      }
    >
      <Table
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={list.data ?? []}
        onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
        pagination={false}
        locale={{ emptyText: "Chưa có cửa hàng" }}
        columns={[
          { title: "Mã", dataIndex: "code", width: 100 },
          { title: "Tên cửa hàng", dataIndex: "name" },
          { title: "Địa chỉ", dataIndex: "address", render: (value) => value ?? "—" },
          { title: "Điện thoại", dataIndex: "phone", width: 140, render: (value) => value ?? "—" },
        ]}
      />

      <StoreDrawer id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />
      <StoreFormModal open={creating} store={null} onClose={() => setCreating(false)} onSaved={async () => { setCreating(false); await refresh(); }} />
    </Card>
  );
}

function StoreDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ["store-detail", id],
    enabled: id !== null,
    queryFn: async () => (await http.get<Envelope<StoreDetail>>(`/stores/${id}`)).data.data,
  });

  async function refresh(): Promise<void> {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["store-detail", id] }), onChanged()]);
  }

  const deactivate = useMutation({
    mutationFn: () => http.post(`/stores/${id}/deactivate`),
    onSuccess: async () => {
      void message.success("Đã ngừng hoạt động cửa hàng");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không cập nhật được trạng thái")),
  });

  const store = detail.data;

  return (
    <Drawer
      width={520}
      open={id !== null}
      onClose={onClose}
      title={store?.name ?? "Chi tiết cửa hàng"}
      extra={
        store && can("store.manage") ? (
          <Space>
            {store.isActive ? (
              <Button danger loading={deactivate.isPending} onClick={() => deactivate.mutate()}>
                Ngừng hoạt động
              </Button>
            ) : null}
            <Button type="primary" onClick={() => setEditing(true)}>
              Sửa
            </Button>
          </Space>
        ) : null
      }
    >
      {store ? (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text>
            Trạng thái: {store.isActive ? <Tag color="green">Đang hoạt động</Tag> : <Tag>Đã ngừng</Tag>}
          </Typography.Text>
          <Typography.Text>Địa chỉ: {store.address ?? "—"}</Typography.Text>
          <Typography.Text>Điện thoại: {store.phone ?? "—"}</Typography.Text>
          <Typography.Text>Số chứng nhận GPP: {store.gppCertificateNumber ?? "—"}</Typography.Text>
          <Typography.Text>Số giấy phép kinh doanh: {store.licenseNumber ?? "—"}</Typography.Text>
        </Space>
      ) : null}

      {store ? <StoreFormModal open={editing} store={store} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await refresh(); }} /> : null}
    </Drawer>
  );
}

type StoreForm = { code?: string; name: string; address?: string; phone?: string; gppCertificateNumber?: string; licenseNumber?: string };

function StoreFormModal({ open, store, onClose, onSaved }: { open: boolean; store: StoreDetail | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form] = Form.useForm<StoreForm>();

  const save = useMutation({
    mutationFn: async (values: StoreForm) => {
      if (store) await http.patch(`/stores/${store.id}`, { ...values, version: store.version });
      else await http.post("/stores", values);
    },
    onSuccess: async () => {
      void message.success(store ? "Đã lưu cửa hàng" : "Đã mở cửa hàng mới");
      await onSaved();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được cửa hàng")),
  });

  return (
    <Modal
      open={open}
      title={store ? "Sửa thông tin cửa hàng" : "Mở cửa hàng mới"}
      okText="Lưu"
      cancelText="Hủy"
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      onOk={() => void form.validateFields().then((values) => save.mutate(values))}
      confirmLoading={save.isPending}
      afterOpenChange={(visible) => {
        if (visible) {
          form.setFieldsValue({
            code: store?.code ?? "",
            name: store?.name ?? "",
            address: store?.address ?? "",
            phone: store?.phone ?? "",
            gppCertificateNumber: store?.gppCertificateNumber ?? "",
            licenseNumber: store?.licenseNumber ?? "",
          });
        }
      }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        {!store ? (
          <Form.Item name="code" label="Mã cửa hàng" rules={[{ required: true, whitespace: true, message: "Nhập mã cửa hàng, ví dụ NT02" }]}>
            <Input placeholder="NT02" />
          </Form.Item>
        ) : null}
        <Form.Item name="name" label="Tên cửa hàng" rules={[{ required: true, whitespace: true, message: "Nhập tên cửa hàng" }]}>
          <Input />
        </Form.Item>
        <Form.Item name="address" label="Địa chỉ">
          <Input />
        </Form.Item>
        <Form.Item name="phone" label="Số điện thoại">
          <Input />
        </Form.Item>
        <Form.Item name="gppCertificateNumber" label="Số chứng nhận GPP">
          <Input />
        </Form.Item>
        <Form.Item name="licenseNumber" label="Số giấy phép kinh doanh">
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}
