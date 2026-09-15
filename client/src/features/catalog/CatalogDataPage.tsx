import { EditOutlined, ExperimentOutlined, PlusOutlined, TagsOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Card, Empty, Form, Input, Modal, Popconfirm, Segmented, Table, Tabs, Tag } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { type ActiveIngredientItem, type CategoryItem, type Envelope, type Paged } from "../../api/types.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";

type CategoryForm = { name: string };
type IngredientForm = { name: string; atcCode?: string };

/** Nhóm hàng và hoạt chất dùng chung toàn chuỗi, phục vụ tạo và kiểm tra sản phẩm. */
export function CatalogDataPage() {
  return (
    <div>
      <PageHeader icon={<TagsOutlined />} title="Danh mục nền" description="Nhóm hàng và hoạt chất dùng chung toàn chuỗi. Hoạt chất là cơ sở để kiểm tra trùng hoạt chất và dị ứng khi bán." />
      <Card>
        <Tabs
          items={[
            { key: "categories", label: <span><TagsOutlined /> Nhóm hàng</span>, children: <CategoriesTab /> },
            { key: "ingredients", label: <span><ExperimentOutlined /> Hoạt chất</span>, children: <IngredientsTab /> },
          ]}
        />
      </Card>
    </div>
  );
}

function CategoriesTab() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"active" | "inactive">("active");
  const [editing, setEditing] = useState<CategoryItem | null | undefined>(undefined);
  const queryClient = useQueryClient();
  const term = useDebounced(search.trim(), 300);
  const listQueryKey = ["categories-page", term, status] as const;
  const categories = useQuery({
    queryKey: listQueryKey,
    queryFn: async () => (await http.get<Envelope<Paged<CategoryItem>>>("/categories", { params: { search: term || undefined, limit: 100, isActive: status === "inactive" ? "false" : undefined } })).data.data,
  });
  const changeStatus = useMutation({
    mutationFn: (item: CategoryItem) => http.post(`/categories/${item.id}/${item.isActive ? "deactivate" : "activate"}`),
    onSuccess: async () => {
      void message.success("Đã cập nhật trạng thái nhóm hàng");
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["categories-page"] }), queryClient.invalidateQueries({ queryKey: ["product-categories"] })]);
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không cập nhật được trạng thái")),
  });

  return (
    <>
      <div className="toolbar">
        <Segmented
          value={status}
          onChange={(value) => setStatus(value as typeof status)}
          options={[
            { value: "active", label: "Đang dùng" },
            { value: "inactive", label: "Đã ngừng" },
          ]}
        />
        <Input.Search allowClear className="toolbar-grow" placeholder="Tìm nhóm hàng" value={search} onChange={(event) => setSearch(event.target.value)} />
        {can("catalog.manage") ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing(null)}>
            Thêm nhóm hàng
          </Button>
        ) : null}
      </div>
      <p className="section-note">“Ngừng sử dụng” chỉ ẩn nhóm khỏi việc chọn cho sản phẩm mới, không xóa lịch sử dữ liệu.</p>
      <Table
        rowKey="id"
        loading={categories.isFetching}
        dataSource={categories.data?.items ?? []}
        pagination={false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={categories.isError ? getErrorMessage(categories.error, "Không tải được danh sách nhóm hàng") : "Chưa có nhóm hàng"} /> }}
        columns={[
          { title: "Tên nhóm hàng", dataIndex: "name", render: (value: string) => <strong>{value}</strong> },
          { title: "Trạng thái", key: "status", width: 140, render: (_: unknown, item: CategoryItem) => (item.isActive ? <Tag color="green">Đang dùng</Tag> : <Tag>Ngừng dùng</Tag>) },
          {
            title: "",
            key: "actions",
            width: 220,
            align: "right",
            render: (_: unknown, item: CategoryItem) =>
              can("catalog.manage") ? (
                <span className="row-actions">
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing(item)}>
                    Sửa
                  </Button>
                  <Popconfirm
                    title={item.isActive ? "Ngừng sử dụng nhóm hàng này?" : "Kích hoạt lại nhóm hàng này?"}
                    description={item.isActive ? "Nhóm sẽ không còn được chọn khi tạo sản phẩm mới." : "Nhóm sẽ có thể được chọn khi tạo sản phẩm mới."}
                    okText={item.isActive ? "Ngừng dùng" : "Kích hoạt"}
                    cancelText="Quay lại"
                    onConfirm={() => changeStatus.mutate(item)}
                  >
                    <Button size="small" type="text" danger={item.isActive}>
                      {item.isActive ? "Ngừng sử dụng" : "Kích hoạt lại"}
                    </Button>
                  </Popconfirm>
                </span>
              ) : null,
          },
        ]}
      />
      <CategoryModal category={editing ?? null} open={editing !== undefined} listQueryKey={listQueryKey} onClose={() => setEditing(undefined)} />
    </>
  );
}

function CategoryModal({ category, open, listQueryKey, onClose }: { category: CategoryItem | null; open: boolean; listQueryKey: readonly unknown[]; onClose: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<CategoryForm>();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: async (values: CategoryForm) => {
      const response = category
        ? await http.patch<Envelope<CategoryItem>>(`/categories/${category.id}`, { ...values, version: category.version })
        : await http.post<Envelope<CategoryItem>>("/categories", values);
      return response.data.data;
    },
    onSuccess: async (saved) => {
      // Hiển thị ngay dữ liệu server vừa trả về; không phụ thuộc vào nhịp tải lại cache.
      queryClient.setQueryData<Paged<CategoryItem>>(listQueryKey, (old) => {
        if (!old) return old;
        const exists = old.items.some((item) => item.id === saved.id);
        return {
          ...old,
          items: exists ? old.items.map((item) => (item.id === saved.id ? saved : item)) : [saved, ...old.items],
          pagination: { ...old.pagination, total: old.pagination.total + (exists ? 0 : 1) },
        };
      });
      void message.success(category ? "Đã lưu nhóm hàng" : "Đã thêm nhóm hàng");
      await queryClient.invalidateQueries({ queryKey: ["product-categories"] });
      onClose();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được nhóm hàng")),
  });
  return (
    <Modal
      open={open}
      title={category ? "Sửa nhóm hàng" : "Thêm nhóm hàng"}
      okText="Lưu"
      cancelText="Hủy"
      onCancel={onClose}
      onOk={() => void form.validateFields().then((values) => save.mutate(values))}
      confirmLoading={save.isPending}
      afterOpenChange={(visible) => {
        if (visible) form.setFieldsValue({ name: category?.name ?? "" });
      }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="Tên nhóm hàng" rules={[{ required: true, whitespace: true, message: "Nhập tên nhóm hàng" }]}>
          <Input autoFocus placeholder="Ví dụ: Thuốc giảm đau, hạ sốt" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function IngredientsTab() {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<ActiveIngredientItem | null | undefined>(undefined);
  const term = useDebounced(search.trim(), 300);
  const listQueryKey = ["ingredients-page", term] as const;
  const ingredients = useQuery({
    queryKey: listQueryKey,
    queryFn: async () => (await http.get<Envelope<Paged<ActiveIngredientItem>>>("/active-ingredients", { params: { search: term || undefined, limit: 100 } })).data.data,
  });
  return (
    <>
      <div className="toolbar">
        <Input.Search allowClear className="toolbar-grow" placeholder="Tìm hoạt chất" value={search} onChange={(event) => setSearch(event.target.value)} />
        {can("catalog.manage") ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing(null)}>
            Thêm hoạt chất
          </Button>
        ) : null}
      </div>
      <Table
        rowKey="id"
        loading={ingredients.isFetching}
        dataSource={ingredients.data?.items ?? []}
        pagination={false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={ingredients.isError ? getErrorMessage(ingredients.error, "Không tải được danh sách hoạt chất") : "Chưa có hoạt chất"} /> }}
        columns={[
          { title: "Tên hoạt chất", dataIndex: "name", render: (value: string) => <strong>{value}</strong> },
          { title: "Mã ATC", dataIndex: "atcCode", width: 200, render: (value: string | null) => <span className="mono">{value ?? "—"}</span> },
          {
            title: "",
            key: "actions",
            width: 100,
            align: "right",
            render: (_: unknown, item: ActiveIngredientItem) =>
              can("catalog.manage") ? (
                <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing(item)}>
                  Sửa
                </Button>
              ) : null,
          },
        ]}
      />
      <IngredientModal ingredient={editing ?? null} open={editing !== undefined} listQueryKey={listQueryKey} onClose={() => setEditing(undefined)} />
    </>
  );
}

function IngredientModal({ ingredient, open, listQueryKey, onClose }: { ingredient: ActiveIngredientItem | null; open: boolean; listQueryKey: readonly unknown[]; onClose: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<IngredientForm>();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: async (values: IngredientForm) => {
      const body = { ...values, atcCode: values.atcCode?.trim() || null };
      const response = ingredient
        ? await http.patch<Envelope<ActiveIngredientItem>>(`/active-ingredients/${ingredient.id}`, body)
        : await http.post<Envelope<ActiveIngredientItem>>("/active-ingredients", body);
      return response.data.data;
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData<Paged<ActiveIngredientItem>>(listQueryKey, (old) => {
        if (!old) return old;
        const exists = old.items.some((item) => item.id === saved.id);
        return {
          ...old,
          items: exists ? old.items.map((item) => (item.id === saved.id ? saved : item)) : [saved, ...old.items],
          pagination: { ...old.pagination, total: old.pagination.total + (exists ? 0 : 1) },
        };
      });
      void message.success(ingredient ? "Đã lưu hoạt chất" : "Đã thêm hoạt chất");
      await queryClient.invalidateQueries({ queryKey: ["active-ingredients"] });
      onClose();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được hoạt chất")),
  });
  return (
    <Modal
      open={open}
      title={ingredient ? "Sửa hoạt chất" : "Thêm hoạt chất"}
      okText="Lưu"
      cancelText="Hủy"
      onCancel={onClose}
      onOk={() => void form.validateFields().then((values) => save.mutate(values))}
      confirmLoading={save.isPending}
      afterOpenChange={(visible) => {
        if (visible) form.setFieldsValue({ name: ingredient?.name ?? "", atcCode: ingredient?.atcCode ?? "" });
      }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="Tên hoạt chất" rules={[{ required: true, whitespace: true, message: "Nhập tên hoạt chất" }]}>
          <Input autoFocus placeholder="Ví dụ: Paracetamol" />
        </Form.Item>
        <Form.Item name="atcCode" label="Mã ATC">
          <Input placeholder="Ví dụ: N02BE01" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
