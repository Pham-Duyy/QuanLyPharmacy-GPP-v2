import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Divider, Drawer, Form, Input, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { type Envelope, type Paged, type SupplierListItem } from "../../api/types.js";
import { useAuth } from "../auth/AuthProvider.js";

/** Quản lý nhà cung cấp dùng chung cho các phiếu nhập kho. */
export function SuppliersPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<"active" | "inactive">("active");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();

  const suppliers = useQuery({
    queryKey: ["suppliers-page", search, page, status],
    queryFn: async () => {
      const response = await http.get<Envelope<Paged<SupplierListItem>>>("/suppliers", {
        params: { search: search || undefined, page, limit: 20, isActive: status === "inactive" ? "false" : undefined },
      });
      return response.data.data;
    },
  });

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["suppliers-page"] });
  }

  const selected = suppliers.data?.items.find((item) => item.id === openId) ?? null;

  return (
    <Card
      title="Nhà cung cấp"
      extra={
        <Space>
          <Select
            value={status}
            style={{ width: 180 }}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            options={[
              { value: "active", label: "Đang sử dụng" },
              { value: "inactive", label: "Ngừng sử dụng" },
            ]}
          />
          <Input.Search
            allowClear
            placeholder="Tên, số điện thoại hoặc mã số thuế"
            onSearch={(value) => {
              setSearch(value);
              setPage(1);
            }}
          />
          {can("catalog.manage") ? <Button type="primary" onClick={() => setCreating(true)}>Thêm nhà cung cấp</Button> : null}
        </Space>
      }
    >
      <Table
        rowKey="id"
        size="small"
        loading={suppliers.isLoading}
        dataSource={suppliers.data?.items ?? []}
        onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
        pagination={{
          current: page,
          pageSize: suppliers.data?.pagination.limit ?? 20,
          total: suppliers.data?.pagination.total ?? 0,
          onChange: setPage,
          showSizeChanger: false,
        }}
        columns={[
          { title: "Tên nhà cung cấp", dataIndex: "name" },
          { title: "Điện thoại", dataIndex: "phone", width: 150, render: (value) => value ?? "—" },
          { title: "Mã số thuế", dataIndex: "taxCode", width: 150, render: (value) => value ?? "—" },
          { title: "Trạng thái", width: 120, render: (_, item: SupplierListItem) => item.isActive ? <Tag color="green">Đang dùng</Tag> : <Tag>Ngừng dùng</Tag> },
        ]}
      />

      <SupplierDrawer supplier={selected} open={openId !== null} onClose={() => setOpenId(null)} onSaved={refresh} />
      <SupplierFormModal open={creating} supplier={null} onClose={() => setCreating(false)} onSaved={async () => { setCreating(false); await refresh(); }} />
    </Card>
  );
}

function SupplierDrawer({ supplier, open, onClose, onSaved }: { supplier: SupplierListItem | null; open: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();

  const changeStatus = useMutation({
    mutationFn: () => http.post(`/suppliers/${supplier!.id}/${supplier!.isActive ? "deactivate" : "activate"}`),
    onSuccess: async () => {
      void message.success("Đã cập nhật trạng thái nhà cung cấp");
      await Promise.all([onSaved(), queryClient.invalidateQueries({ queryKey: ["receipt-suppliers"] })]);
      onClose();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không cập nhật được trạng thái")),
  });

  return (
    <>
      <Drawer
        width={520}
        open={open}
        onClose={onClose}
        title={supplier?.name ?? "Chi tiết nhà cung cấp"}
        extra={supplier && can("catalog.manage") ? <Space><Button onClick={() => setEditing(true)}>Sửa</Button><Button danger={supplier.isActive} loading={changeStatus.isPending} onClick={() => changeStatus.mutate()}>{supplier.isActive ? "Ngừng dùng" : "Kích hoạt"}</Button></Space> : null}
      >
        {supplier ? <Space direction="vertical" size="middle"><Typography.Text><strong>Điện thoại:</strong> {supplier.phone ?? "—"}</Typography.Text><Typography.Text><strong>Mã số thuế:</strong> {supplier.taxCode ?? "—"}</Typography.Text><Typography.Text><strong>Số giấy phép:</strong> {supplier.licenseNumber ?? "—"}</Typography.Text><Typography.Text><strong>Địa chỉ:</strong> {supplier.address ?? "—"}</Typography.Text><Typography.Text><strong>Trạng thái:</strong> {supplier.isActive ? "Đang dùng" : "Ngừng dùng"}</Typography.Text></Space> : null}
      </Drawer>
      {supplier ? <SupplierFormModal open={editing} supplier={supplier} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await onSaved(); }} /> : null}
    </>
  );
}

type SupplierForm = { name: string; phone?: string; taxCode?: string; licenseNumber?: string; address?: string };
function SupplierFormModal({ open, supplier, onClose, onSaved }: { open: boolean; supplier: SupplierListItem | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form] = Form.useForm<SupplierForm>();
  const save = useMutation({
    mutationFn: async (values: SupplierForm) => {
      const body = { name: values.name.trim(), phone: values.phone?.trim() || null, taxCode: values.taxCode?.trim() || null, licenseNumber: values.licenseNumber?.trim() || null, address: values.address?.trim() || null };
      if (supplier) await http.patch(`/suppliers/${supplier.id}`, { ...body, version: supplier.version });
      else await http.post("/suppliers", body);
    },
    onSuccess: async () => {
      void message.success(supplier ? "Đã lưu nhà cung cấp" : "Đã thêm nhà cung cấp");
      await onSaved();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được nhà cung cấp")),
  });

  return (
    <Modal width={680} open={open} title={supplier ? "Cập nhật nhà cung cấp" : "Thêm nhà cung cấp"} okText={supplier ? "Lưu thay đổi" : "Tạo nhà cung cấp"} cancelText="Hủy" onOk={() => void form.validateFields().then((values) => save.mutate(values))} onCancel={() => { form.resetFields(); onClose(); }} confirmLoading={save.isPending} afterOpenChange={(visible) => { if (visible) form.setFieldsValue({ name: supplier?.name ?? "", phone: supplier?.phone ?? "", taxCode: supplier?.taxCode ?? "", licenseNumber: supplier?.licenseNumber ?? "", address: supplier?.address ?? "" }); }} destroyOnHidden>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 20 }}>
        Thông tin này được dùng để lập phiếu nhập và truy xuất nguồn gốc hàng hóa.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" requiredMark="optional">
        <Form.Item name="name" label="Tên nhà cung cấp" rules={[{ required: true, whitespace: true, message: "Nhập tên nhà cung cấp" }]}>
          <Input placeholder="Ví dụ: Công ty Dược Minh An" autoFocus />
        </Form.Item>
        <Divider titlePlacement="start" plain>Thông tin liên hệ</Divider>
        <Space align="start" style={{ width: "100%" }}>
          <Form.Item name="phone" label="Số điện thoại" style={{ flex: 1 }}>
            <Input inputMode="tel" placeholder="Ví dụ: 0901 234 567" />
          </Form.Item>
          <Form.Item name="address" label="Địa chỉ" style={{ flex: 2 }}>
            <Input placeholder="Số nhà, đường, tỉnh/thành phố" />
          </Form.Item>
        </Space>
        <Divider titlePlacement="start" plain>Hồ sơ pháp lý</Divider>
        <Space align="start" style={{ width: "100%" }}>
          <Form.Item name="taxCode" label="Mã số thuế" style={{ flex: 1 }}>
            <Input placeholder="Nếu có" />
          </Form.Item>
          <Form.Item name="licenseNumber" label="Số giấy phép kinh doanh" style={{ flex: 1 }}>
            <Input placeholder="Nếu có" />
          </Form.Item>
        </Space>
      </Form>
    </Modal>
  );
}
