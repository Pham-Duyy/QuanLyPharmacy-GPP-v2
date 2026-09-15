import { EditOutlined, EnvironmentOutlined, FileSearchOutlined, PhoneOutlined, PlusOutlined, PoweroffOutlined, ShopOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Card, Col, Empty, Form, Input, Modal, Popconfirm, Row, Skeleton, Table, Tag } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { type Envelope, type StoreDetail } from "../../api/types.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { PanelEmpty } from "../../ui/PanelEmpty.js";
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
    <div>
      <PageHeader
        icon={<ShopOutlined />}
        title="Cửa hàng"
        description="Các nhà thuốc trong chuỗi, kèm số chứng nhận GPP và giấy phép kinh doanh."
        extra={
          can("store.manage") ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              Mở cửa hàng mới
            </Button>
          ) : null
        }
      />
      <div className="split-layout">
        <Card>
          <Table
            rowKey="id"
            loading={list.isLoading}
            dataSource={list.data ?? []}
            scroll={{ x: 560 }}
            onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
            rowClassName={(row) => (row.id === openId ? "row-selected" : "")}
            pagination={false}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có cửa hàng" /> }}
            columns={[
              {
                title: "Cửa hàng",
                key: "name",
                render: (_: unknown, row: StoreListItem) => (
                  <div className="cell-main">
                    <strong>{row.name}</strong>
                    <span className="mono">{row.code}</span>
                  </div>
                ),
              },
              { title: "Địa chỉ", dataIndex: "address", ellipsis: true, render: (value: string | null) => value ?? "—" },
              { title: "Điện thoại", dataIndex: "phone", width: 140, render: (value: string | null) => <span className="mono">{value ?? "—"}</span> },
            ]}
          />
        </Card>
        <aside className="split-aside">
          <StorePanel id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />
        </aside>
      </div>
      <StoreFormModal
        open={creating}
        store={null}
        onClose={() => setCreating(false)}
        onSaved={async () => {
          setCreating(false);
          await refresh();
        }}
      />
    </div>
  );
}

function StorePanel({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const { can } = useAuth();
  const { message } = App.useApp();
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

  if (id === null) {
    return (
      <Card title="Chi tiết cửa hàng">
        <PanelEmpty icon={<FileSearchOutlined />} title="Chưa chọn cửa hàng" description="Bấm vào một cửa hàng để xem hồ sơ pháp lý." />
      </Card>
    );
  }

  const store = detail.data;

  return (
    <Card
      title="Chi tiết cửa hàng"
      extra={
        <Button type="text" size="small" onClick={onClose}>
          Đóng
        </Button>
      }
    >
      {detail.isLoading || !store ? (
        <Skeleton active paragraph={{ rows: 5 }} />
      ) : (
        <div className="detail-stack">
          <div>
            <h3 className="detail-title">{store.name}</h3>
            <span className="detail-sub">
              <span className="mono">{store.code}</span> · {store.isActive ? <Tag color="green">Đang hoạt động</Tag> : <Tag>Đã ngừng</Tag>}
            </span>
          </div>
          <dl className="kv-list">
            <div>
              <dt>
                <EnvironmentOutlined /> Địa chỉ
              </dt>
              <dd>{store.address ?? "—"}</dd>
            </div>
            <div>
              <dt>
                <PhoneOutlined /> Điện thoại
              </dt>
              <dd>{store.phone ?? "—"}</dd>
            </div>
            <div>
              <dt>Số chứng nhận GPP</dt>
              <dd>{store.gppCertificateNumber ?? "—"}</dd>
            </div>
            <div>
              <dt>Giấy phép kinh doanh</dt>
              <dd>{store.licenseNumber ?? "—"}</dd>
            </div>
          </dl>
          {can("store.manage") ? (
            <div className="panel-actions-row">
              <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
                Sửa thông tin
              </Button>
              {store.isActive ? (
                <Popconfirm title="Ngừng hoạt động cửa hàng này?" description="Nhân viên sẽ không chọn được cửa hàng này nữa." okText="Ngừng hoạt động" okButtonProps={{ danger: true }} cancelText="Quay lại" onConfirm={() => deactivate.mutate()}>
                  <Button danger icon={<PoweroffOutlined />} loading={deactivate.isPending}>
                    Ngừng hoạt động
                  </Button>
                </Popconfirm>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      {store ? (
        <StoreFormModal
          open={editing}
          store={store}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await refresh();
          }}
        />
      ) : null}
    </Card>
  );
}

type StoreForm = { code?: string; name: string; address?: string; phone?: string; gppCertificateNumber?: string; licenseNumber?: string };

function StoreFormModal({ open, store, onClose, onSaved }: { open: boolean; store: StoreDetail | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { message } = App.useApp();
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
      width={640}
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
        <Row gutter={12}>
          {!store ? (
            <Col xs={24} sm={8}>
              <Form.Item name="code" label="Mã cửa hàng" rules={[{ required: true, whitespace: true, message: "Nhập mã, ví dụ NT02" }]}>
                <Input placeholder="NT02" />
              </Form.Item>
            </Col>
          ) : null}
          <Col xs={24} sm={store ? 24 : 16}>
            <Form.Item name="name" label="Tên cửa hàng" rules={[{ required: true, whitespace: true, message: "Nhập tên cửa hàng" }]}>
              <Input placeholder="Nhà thuốc GPP số 2" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={16}>
            <Form.Item name="address" label="Địa chỉ">
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} sm={8}>
            <Form.Item name="phone" label="Số điện thoại">
              <Input inputMode="tel" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="gppCertificateNumber" label="Số chứng nhận GPP">
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="licenseNumber" label="Số giấy phép kinh doanh">
              <Input />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
