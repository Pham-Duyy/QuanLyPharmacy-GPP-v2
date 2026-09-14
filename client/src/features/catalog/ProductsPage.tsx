import { MedicineBoxOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Col, Descriptions, Empty, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tag, Typography, message } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { formatVnd, type ActiveIngredientItem, type CategoryItem, type Envelope, type Paged, type ProductDetail, type ProductListItem, type ProductUnit } from "../../api/types.js";
import { useAuth } from "../auth/AuthProvider.js";

const DRUG_CLASS: Record<string, { text: string; color: string }> = {
  OTC: { text: "Không kê đơn", color: "green" },
  RX: { text: "Kê đơn", color: "orange" },
  CONTROLLED: { text: "Kiểm soát đặc biệt", color: "red" },
};

type ProductForm = {
  code: string;
  name: string;
  productType: "DRUG" | "SUPPLEMENT" | "MEDICAL_DEVICE" | "COSMETIC" | "OTHER";
  drugClass?: "OTC" | "RX" | "CONTROLLED";
  categoryId: string;
  baseUnitName: string;
  minStockBaseQuantity?: number;
  ingredients?: string[];
};

/** Danh mục dùng chung toàn chuỗi. Tồn kho hiển thị theo cửa hàng đang chọn. */
export function ProductsPage() {
  const { can } = useAuth();
  const [term, setTerm] = useState("");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();
  const products = useQuery({
    queryKey: ["products-page", term, page],
    queryFn: async () => (await http.get<Envelope<Paged<ProductListItem>>>("/products", { params: { search: term || undefined, page, limit: 20 } })).data.data,
  });
  async function refresh(): Promise<void> { await queryClient.invalidateQueries({ queryKey: ["products-page"] }); }

  return (
    <div className="products-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}><MedicineBoxOutlined /> Quản lý thuốc</Typography.Title>
          <Typography.Text>Danh mục thuốc, thực phẩm chức năng và dược phẩm tại nhà thuốc.</Typography.Text>
        </div>
        {can("catalog.manage") ? <Button type="primary" size="large" onClick={() => setCreating(true)}>+ Thêm thuốc</Button> : null}
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card className="products-list-card" title="Danh sách thuốc" extra={<Input.Search allowClear style={{ width: 300 }} placeholder="Tìm theo tên thuốc, hoạt chất, mã" onSearch={(value) => { setTerm(value); setPage(1); }} />}>
            <Table
              rowKey="id"
              size="small"
              loading={products.isLoading}
              dataSource={products.data?.items ?? []}
              onRow={(row) => ({ onClick: () => setSelectedId(row.id), style: { cursor: "pointer" } })}
              rowClassName={(row) => (row.id === selectedId ? "row-selected" : "")}
              pagination={{ current: page, pageSize: products.data?.pagination.limit ?? 20, total: products.data?.pagination.total ?? 0, onChange: setPage, showSizeChanger: false }}
              columns={[
                { title: "Mã", dataIndex: "code", width: 100 },
                { title: "Tên sản phẩm", render: (_, item: ProductListItem) => <Space direction="vertical" size={0}><Typography.Text strong>{item.name}</Typography.Text><Typography.Text type="secondary">{item.categoryName}</Typography.Text></Space> },
                { title: "Phân loại", width: 145, render: (_, item: ProductListItem) => { const info = item.drugClass ? DRUG_CLASS[item.drugClass] : null; return info ? <Tag color={info.color}>{info.text}</Tag> : <Tag>Không phải thuốc</Tag>; } },
                { title: "Giá bán", width: 110, align: "right", render: (_, item: ProductListItem) => formatVnd(item.currentPrice?.salePrice) },
                { title: "Tồn bán được", width: 100, align: "right", render: (_, item: ProductListItem) => item.stock?.sellable ?? 0 },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <ProductDetailPanel id={selectedId} />
        </Col>
      </Row>

      <ProductFormModal open={creating} onClose={() => setCreating(false)} onSaved={async () => { setCreating(false); await refresh(); }} />
    </div>
  );
}

function ProductDetailPanel({ id }: { id: string | null }) {
  const { can } = useAuth();
  const [editingUnit, setEditingUnit] = useState<ProductUnit | null | undefined>(undefined);
  const [pricingUnit, setPricingUnit] = useState<ProductUnit | null>(null);
  const [editingProduct, setEditingProduct] = useState(false);
  const queryClient = useQueryClient();
  const product = useQuery({ enabled: id !== null, queryKey: ["product", id], queryFn: async () => (await http.get<Envelope<ProductDetail>>(`/products/${id}`)).data.data });
  const item = product.data;
  async function refresh(): Promise<void> { await Promise.all([queryClient.invalidateQueries({ queryKey: ["product", id] }), queryClient.invalidateQueries({ queryKey: ["products-page"] })]); }

  return (
    <>
      <Card className="product-detail-card" title={item?.name ?? "Chi tiết sản phẩm"} loading={product.isLoading} extra={item && can("catalog.manage") ? <Button onClick={() => setEditingProduct(true)}>Sửa sản phẩm</Button> : null}>
        {!item ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chọn một sản phẩm để xem chi tiết" />
        ) : (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Descriptions column={1} size="small" items={[{ key: "code", label: "Mã", children: item.code }, { key: "category", label: "Nhóm hàng", children: item.category.name }, { key: "type", label: "Loại", children: item.drugClass ? DRUG_CLASS[item.drugClass]?.text : "Không phải thuốc" }, { key: "stock", label: "Tồn bán được", children: item.stock?.sellable ?? 0 }]} />
            <div>
              <Space style={{ marginBottom: 8 }}>
                <Typography.Text strong>Đơn vị tính và mã vạch</Typography.Text>
                {can("catalog.manage") ? <Button size="small" onClick={() => setEditingUnit(null)}>Thêm đơn vị</Button> : null}
              </Space>
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={item.units}
                columns={[
                  { title: "Tên", dataIndex: "name" },
                  { title: "Quy đổi", dataIndex: "conversionToBase", render: (value) => `1 = ${value} đơn vị cơ bản` },
                  { title: "Mã vạch", dataIndex: "barcodes", render: (value: string[]) => value?.join(", ") || "—" },
                  { title: "Giá hiện hành", render: (_, unit: ProductUnit) => formatVnd(unit.currentPrice?.salePrice) },
                  { title: "Thao tác", width: 150, render: (_, unit: ProductUnit) => <Space>{can("catalog.manage") ? <Button size="small" onClick={() => setEditingUnit(unit)}>Sửa</Button> : null}{can("price.manage") ? <Button size="small" onClick={() => setPricingUnit(unit)}>Đặt giá</Button> : null}</Space> },
                ]}
              />
            </div>
          </Space>
        )}
      </Card>
      {item ? <ProductEditModal product={item} open={editingProduct} onClose={() => setEditingProduct(false)} onSaved={refresh} /> : null}
      {item ? <UnitModal productId={item.id} unit={editingUnit ?? null} open={editingUnit !== undefined} onClose={() => setEditingUnit(undefined)} onSaved={refresh} /> : null}
      {item && pricingUnit ? <PriceModal productId={item.id} unit={pricingUnit} onClose={() => setPricingUnit(null)} onSaved={refresh} /> : null}
    </>
  );
}

type ProductEditForm = { name: string; categoryId: string; minStockBaseQuantity: number };
function ProductEditModal({ product, open, onClose, onSaved }: { product: ProductDetail; open: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form] = Form.useForm<ProductEditForm>();
  const categories = useQuery({ enabled: open, queryKey: ["product-categories"], queryFn: async () => (await http.get<Envelope<Paged<CategoryItem>>>("/categories", { params: { limit: 100 } })).data.data.items });
  const save = useMutation({ mutationFn: (values: ProductEditForm) => http.patch(`/products/${product.id}`, { ...values, version: product.version }), onSuccess: async () => { void message.success("Đã lưu sản phẩm"); await onSaved(); onClose(); }, onError: (error) => void message.error(getErrorMessage(error, "Không lưu được sản phẩm")) });
  return <Modal open={open} title="Sửa sản phẩm" okText="Lưu" onCancel={onClose} onOk={() => void form.validateFields().then((values) => save.mutate(values))} confirmLoading={save.isPending} afterOpenChange={(visible) => { if (visible) form.setFieldsValue({ name: product.name, categoryId: product.category.id, minStockBaseQuantity: product.minStockBaseQuantity }); }} destroyOnHidden><Form form={form} layout="vertical"><Form.Item name="name" label="Tên sản phẩm" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item><Form.Item name="categoryId" label="Nhóm hàng" rules={[{ required: true }]}><Select loading={categories.isLoading} showSearch optionFilterProp="label" options={categories.data?.map((item) => ({ value: item.id, label: item.name }))} /></Form.Item><Form.Item name="minStockBaseQuantity" label="Tồn tối thiểu"><InputNumber min={0} precision={0} style={{ width: "100%" }} /></Form.Item></Form></Modal>;
}

type UnitForm = { name: string; conversionToBase?: number; isSellable?: boolean; isDefaultSaleUnit?: boolean; barcodesText?: string };
function UnitModal({ productId, unit, open, onClose, onSaved }: { productId: string; unit: ProductUnit | null; open: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form] = Form.useForm<UnitForm>();
  const save = useMutation({
    mutationFn: async (values: UnitForm) => {
      const body = { ...values, barcodes: (values.barcodesText ?? "").split(/[\n,]/).map((value) => value.trim()).filter(Boolean) };
      if (unit) await http.patch(`/products/${productId}/units/${unit.id}`, body);
      else await http.post(`/products/${productId}/units`, { ...body, conversionToBase: values.conversionToBase });
    },
    onSuccess: async () => { void message.success(unit ? "Đã lưu đơn vị tính" : "Đã thêm đơn vị tính"); await onSaved(); onClose(); },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được đơn vị tính")),
  });
  return <Modal open={open} title={unit ? "Sửa đơn vị tính" : "Thêm đơn vị tính"} okText="Lưu" onCancel={onClose} onOk={() => void form.validateFields().then((values) => save.mutate(values))} confirmLoading={save.isPending} afterOpenChange={(visible) => { if (visible) form.setFieldsValue({ name: unit?.name ?? "", conversionToBase: unit?.conversionToBase, isSellable: unit?.isSellable ?? true, isDefaultSaleUnit: unit?.isDefaultSaleUnit ?? false, barcodesText: unit?.barcodes?.join(", ") ?? "" }); }} destroyOnHidden><Form form={form} layout="vertical"><Form.Item name="name" label="Tên đơn vị" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item>{unit ? <Typography.Text type="secondary">Hệ số quy đổi không thể sửa sau khi đã tạo.</Typography.Text> : <Form.Item name="conversionToBase" label="Hệ số quy đổi sang đơn vị cơ bản" rules={[{ required: true }]}><InputNumber min={1} precision={0} style={{ width: "100%" }} /></Form.Item>}<Form.Item name="barcodesText" label="Mã vạch"><Input.TextArea rows={2} placeholder="Ngăn cách bằng dấu phẩy hoặc xuống dòng" /></Form.Item><Form.Item name="isSellable" label="Được phép bán"><Select options={[{ value: true, label: "Có" }, { value: false, label: "Không" }]} /></Form.Item><Form.Item name="isDefaultSaleUnit" label="Đơn vị bán mặc định"><Select options={[{ value: true, label: "Có" }, { value: false, label: "Không" }]} /></Form.Item></Form></Modal>;
}

type PriceForm = { salePrice: number; vatRatePercent: number; scope: "CHAIN" | "STORE" };
function PriceModal({ productId, unit, onClose, onSaved }: { productId: string; unit: ProductUnit; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form] = Form.useForm<PriceForm>();
  const save = useMutation({ mutationFn: (values: PriceForm) => http.post(`/products/${productId}/prices`, { ...values, unitId: unit.id }), onSuccess: async () => { void message.success("Đã tạo phiên bản giá mới"); await onSaved(); onClose(); }, onError: (error) => void message.error(getErrorMessage(error, "Không đặt được giá")) });
  return <Modal open title={`Đặt giá — ${unit.name}`} okText="Lưu giá" onCancel={onClose} onOk={() => void form.validateFields().then((values) => save.mutate(values))} confirmLoading={save.isPending} destroyOnHidden><Typography.Paragraph type="secondary">Giá cũ không bị sửa; hệ thống tạo một phiên bản giá mới để bảo toàn hóa đơn lịch sử.</Typography.Paragraph><Form form={form} layout="vertical" initialValues={{ vatRatePercent: 0, scope: "CHAIN" }}><Form.Item name="salePrice" label="Giá bán (đồng)" rules={[{ required: true }]}><InputNumber min={0} precision={0} style={{ width: "100%" }} /></Form.Item><Form.Item name="vatRatePercent" label="VAT (%)" rules={[{ required: true }]}><InputNumber min={0} max={100} style={{ width: "100%" }} /></Form.Item><Form.Item name="scope" label="Phạm vi giá"><Select options={[{ value: "CHAIN", label: "Toàn chuỗi" }, { value: "STORE", label: "Chỉ cửa hàng đang chọn" }]} /></Form.Item></Form></Modal>;
}

function ProductFormModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form] = Form.useForm<ProductForm>();
  const productType = Form.useWatch("productType", form);
  const queryClient = useQueryClient();
  const categories = useQuery({ enabled: open, queryKey: ["product-categories"], queryFn: async () => (await http.get<Envelope<Paged<CategoryItem>>>("/categories", { params: { limit: 100 } })).data.data.items });
  const ingredients = useQuery({ enabled: open, queryKey: ["active-ingredients"], queryFn: async () => (await http.get<Envelope<Paged<ActiveIngredientItem>>>("/active-ingredients", { params: { limit: 100 } })).data.data.items });
  const create = useMutation({
    mutationFn: async (values: ProductForm) => http.post("/products", { ...values, drugClass: values.productType === "DRUG" ? values.drugClass : null, minStockBaseQuantity: values.minStockBaseQuantity ?? 0, ingredients: (values.ingredients ?? []).map((ingredientId) => ({ ingredientId })) }),
    onSuccess: async () => { void message.success("Đã thêm sản phẩm"); form.resetFields(); await queryClient.invalidateQueries({ queryKey: ["products-page"] }); await onSaved(); },
    onError: (error) => void message.error(getErrorMessage(error, "Không thêm được sản phẩm")),
  });
  return <Modal width={640} open={open} title="Thêm sản phẩm" okText="Lưu sản phẩm" onCancel={() => { form.resetFields(); onClose(); }} onOk={() => void form.validateFields().then((values) => create.mutate(values))} confirmLoading={create.isPending} destroyOnHidden>
    <Form form={form} layout="vertical" initialValues={{ productType: "DRUG", baseUnitName: "Viên", minStockBaseQuantity: 0 }}>
      <Space style={{ width: "100%" }} align="start"><Form.Item name="code" label="Mã sản phẩm" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item><Form.Item name="name" label="Tên sản phẩm" rules={[{ required: true, whitespace: true }]} style={{ width: 400 }}><Input /></Form.Item></Space>
      <Space style={{ width: "100%" }} align="start"><Form.Item name="productType" label="Loại hàng" rules={[{ required: true }]}><Select style={{ width: 190 }} options={[{ value: "DRUG", label: "Thuốc" }, { value: "SUPPLEMENT", label: "Thực phẩm bảo vệ sức khỏe" }, { value: "MEDICAL_DEVICE", label: "Thiết bị y tế" }, { value: "COSMETIC", label: "Mỹ phẩm" }, { value: "OTHER", label: "Khác" }]} /></Form.Item>{productType === "DRUG" ? <Form.Item name="drugClass" label="Phân loại thuốc" rules={[{ required: true, message: "Chọn phân loại thuốc" }]}><Select style={{ width: 190 }} options={Object.entries(DRUG_CLASS).map(([value, info]) => ({ value, label: info.text }))} /></Form.Item> : null}<Form.Item name="categoryId" label="Nhóm hàng" rules={[{ required: true, message: "Chọn nhóm hàng" }]}><Select loading={categories.isLoading} style={{ width: 200 }} showSearch optionFilterProp="label" options={categories.data?.map((item) => ({ value: item.id, label: item.name }))} /></Form.Item></Space>
      <Space align="start"><Form.Item name="baseUnitName" label="Đơn vị cơ bản" rules={[{ required: true, whitespace: true }]}><Input placeholder="Ví dụ: Viên, Chai" /></Form.Item><Form.Item name="minStockBaseQuantity" label="Tồn tối thiểu"><InputNumber min={0} precision={0} /></Form.Item></Space>
      <Form.Item name="ingredients" label="Hoạt chất (nếu có)"><Select mode="multiple" showSearch optionFilterProp="label" loading={ingredients.isLoading} options={ingredients.data?.map((item) => ({ value: item.id, label: item.atcCode ? `${item.name} (${item.atcCode})` : item.name }))} /></Form.Item>
    </Form>
  </Modal>;
}
