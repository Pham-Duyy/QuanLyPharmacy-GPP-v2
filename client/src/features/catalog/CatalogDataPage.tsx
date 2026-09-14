import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Typography, message } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { type ActiveIngredientItem, type CategoryItem, type Envelope, type Paged } from "../../api/types.js";
import { useAuth } from "../auth/AuthProvider.js";

type CategoryForm = { name: string };
type IngredientForm = { name: string; atcCode?: string };

/** Nhóm hàng và hoạt chất dùng chung toàn chuỗi, phục vụ tạo và kiểm tra sản phẩm. */
export function CatalogDataPage() {
  return <Tabs items={[{ key: "categories", label: "Nhóm hàng", children: <CategoriesTab /> }, { key: "ingredients", label: "Hoạt chất", children: <IngredientsTab /> }]} />;
}

function CategoriesTab() {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"active" | "inactive">("active");
  const [editing, setEditing] = useState<CategoryItem | null | undefined>(undefined);
  const queryClient = useQueryClient();
  const categories = useQuery({
    queryKey: ["categories-page", search, status],
    queryFn: async () => (await http.get<Envelope<Paged<CategoryItem>>>("/categories", { params: { search: search || undefined, limit: 100, isActive: status === "inactive" ? "false" : undefined } })).data.data,
  });
  const changeStatus = useMutation({
    mutationFn: (item: CategoryItem) => http.post(`/categories/${item.id}/${item.isActive ? "deactivate" : "activate"}`),
    onSuccess: async () => { void message.success("Đã cập nhật trạng thái nhóm hàng"); await Promise.all([queryClient.invalidateQueries({ queryKey: ["categories-page"] }), queryClient.invalidateQueries({ queryKey: ["product-categories"] })]); },
    onError: (error) => void message.error(getErrorMessage(error, "Không cập nhật được trạng thái")),
  });
  return <Card title="Nhóm hàng" extra={<Space><Select value={status} style={{ width: 200 }} onChange={setStatus} options={[{ value: "active", label: "Hiển thị nhóm đang dùng" }, { value: "inactive", label: "Hiển thị nhóm đã ngừng" }]} /><Input.Search allowClear placeholder="Tìm nhóm hàng" onSearch={setSearch} />{can("catalog.manage") ? <Button type="primary" onClick={() => setEditing(null)}>Thêm nhóm hàng</Button> : null}</Space>}>
    <Typography.Paragraph type="secondary">
      Nhóm đang dùng có thể gán cho sản phẩm mới. “Ngừng sử dụng” chỉ ẩn nhóm khỏi việc chọn sản phẩm mới, không xóa lịch sử dữ liệu.
    </Typography.Paragraph>
    <Table rowKey="id" size="small" loading={categories.isLoading} dataSource={categories.data?.items ?? []} pagination={false} locale={{ emptyText: categories.isError ? getErrorMessage(categories.error, "Không tải được danh sách nhóm hàng") : "Chưa có nhóm hàng" }} columns={[
      { title: "Tên nhóm hàng", dataIndex: "name" },
      { title: "Trạng thái", width: 160, render: (_, item: CategoryItem) => item.isActive ? <Tag color="green">Đang dùng</Tag> : <Tag>Ngừng dùng</Tag> },
      { title: "Thao tác", width: 250, render: (_, item: CategoryItem) => can("catalog.manage") ? <Space><Button size="small" onClick={() => setEditing(item)}>Sửa</Button><Popconfirm title={item.isActive ? "Ngừng sử dụng nhóm hàng này?" : "Kích hoạt lại nhóm hàng này?"} description={item.isActive ? "Nhóm sẽ không còn được chọn khi tạo sản phẩm mới." : "Nhóm sẽ có thể được chọn khi tạo sản phẩm mới."} okText={item.isActive ? "Xác nhận ngừng dùng" : "Xác nhận kích hoạt"} cancelText="Quay lại" onConfirm={() => changeStatus.mutate(item)}><Button size="small" danger={item.isActive} loading={changeStatus.isPending}>{item.isActive ? "Ngừng sử dụng" : "Kích hoạt lại"}</Button></Popconfirm></Space> : null },
    ]} />
    <CategoryModal category={editing ?? null} open={editing !== undefined} listQueryKey={["categories-page", search, status]} onClose={() => setEditing(undefined)} />
  </Card>;
}

function CategoryModal({ category, open, listQueryKey, onClose }: { category: CategoryItem | null; open: boolean; listQueryKey: readonly unknown[]; onClose: () => void }) {
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
        return { ...old, items: exists ? old.items.map((item) => item.id === saved.id ? saved : item) : [saved, ...old.items], pagination: { ...old.pagination, total: old.pagination.total + (exists ? 0 : 1) } };
      });
      void message.success(category ? "Đã lưu nhóm hàng" : "Đã thêm nhóm hàng");
      await queryClient.invalidateQueries({ queryKey: ["product-categories"] });
      onClose();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được nhóm hàng")),
  });
  return <Modal open={open} title={category ? "Sửa nhóm hàng" : "Thêm nhóm hàng"} okText="Lưu" onCancel={onClose} onOk={() => void form.validateFields().then((values) => save.mutate(values))} confirmLoading={save.isPending} afterOpenChange={(visible) => { if (visible) form.setFieldsValue({ name: category?.name ?? "" }); }} destroyOnHidden><Form form={form} layout="vertical"><Form.Item name="name" label="Tên nhóm hàng" rules={[{ required: true, whitespace: true }]}><Input autoFocus /></Form.Item></Form></Modal>;
}

function IngredientsTab() {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<ActiveIngredientItem | null | undefined>(undefined);
  const ingredients = useQuery({ queryKey: ["ingredients-page", search], queryFn: async () => (await http.get<Envelope<Paged<ActiveIngredientItem>>>("/active-ingredients", { params: { search: search || undefined, limit: 100 } })).data.data });
  return <Card title="Hoạt chất" extra={<Space><Input.Search allowClear placeholder="Tìm hoạt chất" onSearch={setSearch} />{can("catalog.manage") ? <Button type="primary" onClick={() => setEditing(null)}>Thêm hoạt chất</Button> : null}</Space>}>
    <Table rowKey="id" size="small" loading={ingredients.isLoading} dataSource={ingredients.data?.items ?? []} pagination={false} locale={{ emptyText: ingredients.isError ? getErrorMessage(ingredients.error, "Không tải được danh sách hoạt chất") : "Chưa có hoạt chất" }} columns={[{ title: "Tên hoạt chất", dataIndex: "name" }, { title: "Mã ATC", dataIndex: "atcCode", width: 220, render: (value) => value ?? "—" }, { title: "Thao tác", width: 100, render: (_, item: ActiveIngredientItem) => can("catalog.manage") ? <Button size="small" onClick={() => setEditing(item)}>Sửa</Button> : null }]} />
    <IngredientModal ingredient={editing ?? null} open={editing !== undefined} listQueryKey={["ingredients-page", search]} onClose={() => setEditing(undefined)} />
  </Card>;
}

function IngredientModal({ ingredient, open, listQueryKey, onClose }: { ingredient: ActiveIngredientItem | null; open: boolean; listQueryKey: readonly unknown[]; onClose: () => void }) {
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
        return { ...old, items: exists ? old.items.map((item) => item.id === saved.id ? saved : item) : [saved, ...old.items], pagination: { ...old.pagination, total: old.pagination.total + (exists ? 0 : 1) } };
      });
      void message.success(ingredient ? "Đã lưu hoạt chất" : "Đã thêm hoạt chất");
      await queryClient.invalidateQueries({ queryKey: ["active-ingredients"] });
      onClose();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được hoạt chất")),
  });
  return <Modal open={open} title={ingredient ? "Sửa hoạt chất" : "Thêm hoạt chất"} okText="Lưu" onCancel={onClose} onOk={() => void form.validateFields().then((values) => save.mutate(values))} confirmLoading={save.isPending} afterOpenChange={(visible) => { if (visible) form.setFieldsValue({ name: ingredient?.name ?? "", atcCode: ingredient?.atcCode ?? "" }); }} destroyOnHidden><Form form={form} layout="vertical"><Form.Item name="name" label="Tên hoạt chất" rules={[{ required: true, whitespace: true }]}><Input autoFocus /></Form.Item><Form.Item name="atcCode" label="Mã ATC"><Input /></Form.Item></Form></Modal>;
}
