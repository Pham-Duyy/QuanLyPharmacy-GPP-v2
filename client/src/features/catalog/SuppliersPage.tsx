import { EditOutlined, FileSearchOutlined, PlusOutlined, PoweroffOutlined, TruckOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Card, Col, Divider, Empty, Form, Input, Modal, Row, Segmented, Table, Tag, Typography } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { type Envelope, type Paged, type SupplierListItem } from "../../api/types.js";
import { ExcelMenuButton } from "../excel/ExcelButtons.js";
import { ExcelImportModal } from "../excel/ExcelImportModal.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { PanelEmpty } from "../../ui/PanelEmpty.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";

/** Quản lý nhà cung cấp dùng chung cho các phiếu nhập kho. */
export function SuppliersPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<"active" | "inactive">("active");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const queryClient = useQueryClient();
  const term = useDebounced(search.trim(), 300);

  const suppliers = useQuery({
    queryKey: ["suppliers-page", term, page, status],
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<SupplierListItem>>>("/suppliers", {
          params: { search: term || undefined, page, limit: 20, isActive: status === "inactive" ? "false" : undefined },
        })
      ).data.data,
    placeholderData: (previous) => previous,
  });

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["suppliers-page"] });
  }

  const selected = suppliers.data?.items.find((item) => item.id === openId) ?? null;

  return (
    <div>
      <PageHeader
        icon={<TruckOutlined />}
        title="Nhà cung cấp"
        description="Thông tin nhà cung cấp dùng khi lập phiếu nhập và truy xuất nguồn gốc hàng hóa."
        extra={
          <>
            <ExcelMenuButton onImport={can("catalog.manage") ? () => setImporting(true) : undefined} exportType="suppliers" />
            {can("catalog.manage") ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                Thêm nhà cung cấp
              </Button>
            ) : null}
          </>
        }
      />
      <ExcelImportModal type="suppliers" title="Nhà cung cấp" open={importing} onClose={() => setImporting(false)} onDone={() => void refresh()} />
      <div className="split-layout">
        <Card>
          <div className="toolbar">
            <Segmented
              value={status}
              onChange={(value) => {
                setStatus(value as typeof status);
                setPage(1);
              }}
              options={[
                { value: "active", label: "Đang sử dụng" },
                { value: "inactive", label: "Ngừng sử dụng" },
              ]}
            />
            <Input.Search
              allowClear
              className="toolbar-grow"
              placeholder="Tên, số điện thoại hoặc mã số thuế"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <Table
            rowKey="id"
            loading={suppliers.isFetching}
            dataSource={suppliers.data?.items ?? []}
            scroll={{ x: 600 }}
            onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
            rowClassName={(row) => (row.id === openId ? "row-selected" : "")}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có nhà cung cấp phù hợp" /> }}
            pagination={{
              current: page,
              pageSize: suppliers.data?.pagination.limit ?? 20,
              total: suppliers.data?.pagination.total ?? 0,
              onChange: setPage,
              showSizeChanger: false,
            }}
            columns={[
              {
                title: "Nhà cung cấp",
                key: "name",
                render: (_: unknown, item: SupplierListItem) => (
                  <div className="cell-main">
                    <strong>{item.name}</strong>
                    <span>{item.address ?? "Chưa có địa chỉ"}</span>
                  </div>
                ),
              },
              { title: "Điện thoại", dataIndex: "phone", width: 140, render: (value: string | null) => <span className="mono">{value ?? "—"}</span> },
              { title: "Mã số thuế", dataIndex: "taxCode", width: 140, render: (value: string | null) => <span className="mono">{value ?? "—"}</span> },
            ]}
          />
        </Card>
        <aside className="split-aside">
          <SupplierPanel supplier={selected} onSaved={refresh} onClose={() => setOpenId(null)} />
        </aside>
      </div>
      <SupplierFormModal
        open={creating}
        supplier={null}
        onClose={() => setCreating(false)}
        onSaved={async () => {
          setCreating(false);
          await refresh();
        }}
      />
    </div>
  );
}

function SupplierPanel({ supplier, onSaved, onClose }: { supplier: SupplierListItem | null; onSaved: () => Promise<void>; onClose: () => void }) {
  const { can } = useAuth();
  const { message } = App.useApp();
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

  if (!supplier) {
    return (
      <Card title="Chi tiết nhà cung cấp">
        <PanelEmpty icon={<FileSearchOutlined />} title="Chưa chọn nhà cung cấp" description="Bấm vào một dòng để xem hồ sơ và thao tác." />
      </Card>
    );
  }

  return (
    <Card
      title="Chi tiết nhà cung cấp"
      extra={
        <Button type="text" size="small" onClick={onClose}>
          Đóng
        </Button>
      }
    >
      <div className="detail-stack">
        <div>
          <h3 className="detail-title">{supplier.name}</h3>
          {supplier.isActive ? <Tag color="green">Đang sử dụng</Tag> : <Tag>Ngừng sử dụng</Tag>}
        </div>
        <dl className="kv-list">
          <div>
            <dt>Điện thoại</dt>
            <dd>{supplier.phone ?? "—"}</dd>
          </div>
          <div>
            <dt>Địa chỉ</dt>
            <dd>{supplier.address ?? "—"}</dd>
          </div>
          <div>
            <dt>Mã số thuế</dt>
            <dd>{supplier.taxCode ?? "—"}</dd>
          </div>
          <div>
            <dt>Số giấy phép</dt>
            <dd>{supplier.licenseNumber ?? "—"}</dd>
          </div>
        </dl>
        {can("catalog.manage") ? (
          <div className="panel-actions-row">
            <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
              Sửa
            </Button>
            <Button danger={supplier.isActive} icon={<PoweroffOutlined />} loading={changeStatus.isPending} onClick={() => changeStatus.mutate()}>
              {supplier.isActive ? "Ngừng dùng" : "Kích hoạt lại"}
            </Button>
          </div>
        ) : null}
      </div>
      <SupplierFormModal
        open={editing}
        supplier={supplier}
        onClose={() => setEditing(false)}
        onSaved={async () => {
          setEditing(false);
          await onSaved();
        }}
      />
    </Card>
  );
}

type SupplierForm = { name: string; phone?: string; taxCode?: string; licenseNumber?: string; address?: string };
function SupplierFormModal({ open, supplier, onClose, onSaved }: { open: boolean; supplier: SupplierListItem | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<SupplierForm>();
  const save = useMutation({
    mutationFn: async (values: SupplierForm) => {
      const body = {
        name: values.name.trim(),
        phone: values.phone?.trim() || null,
        taxCode: values.taxCode?.trim() || null,
        licenseNumber: values.licenseNumber?.trim() || null,
        address: values.address?.trim() || null,
      };
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
    <Modal
      width={680}
      open={open}
      title={supplier ? "Cập nhật nhà cung cấp" : "Thêm nhà cung cấp"}
      okText={supplier ? "Lưu thay đổi" : "Tạo nhà cung cấp"}
      cancelText="Hủy"
      onOk={() => void form.validateFields().then((values) => save.mutate(values))}
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      confirmLoading={save.isPending}
      afterOpenChange={(visible) => {
        if (visible)
          form.setFieldsValue({
            name: supplier?.name ?? "",
            phone: supplier?.phone ?? "",
            taxCode: supplier?.taxCode ?? "",
            licenseNumber: supplier?.licenseNumber ?? "",
            address: supplier?.address ?? "",
          });
      }}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">Thông tin này được dùng để lập phiếu nhập và truy xuất nguồn gốc hàng hóa.</Typography.Paragraph>
      <Form form={form} layout="vertical" requiredMark="optional">
        <Form.Item name="name" label="Tên nhà cung cấp" rules={[{ required: true, whitespace: true, message: "Nhập tên nhà cung cấp" }]}>
          <Input placeholder="Ví dụ: Công ty Dược Minh An" autoFocus />
        </Form.Item>
        <Divider titlePlacement="start" plain>
          Thông tin liên hệ
        </Divider>
        <Row gutter={12}>
          <Col xs={24} sm={8}>
            <Form.Item name="phone" label="Số điện thoại">
              <Input inputMode="tel" placeholder="0901 234 567" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={16}>
            <Form.Item name="address" label="Địa chỉ">
              <Input placeholder="Số nhà, đường, tỉnh/thành phố" />
            </Form.Item>
          </Col>
        </Row>
        <Divider titlePlacement="start" plain>
          Hồ sơ pháp lý
        </Divider>
        <Row gutter={12}>
          <Col xs={24} sm={12}>
            <Form.Item name="taxCode" label="Mã số thuế">
              <Input placeholder="Nếu có" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="licenseNumber" label="Số giấy phép kinh doanh">
              <Input placeholder="Nếu có" />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
