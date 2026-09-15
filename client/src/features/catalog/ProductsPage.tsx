import { BarcodeOutlined, DollarOutlined, EditOutlined, FileSearchOutlined, MedicineBoxOutlined, PlusOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Card, Col, Empty, Form, Input, InputNumber, Modal, Row, Segmented, Select, Skeleton, Table, Tag, Typography } from "antd";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { getErrorMessage, http } from "../../api/http.js";
import { formatVnd, type ActiveIngredientItem, type CategoryItem, type Envelope, type Paged, type ProductDetail, type ProductListItem, type ProductUnit } from "../../api/types.js";
import { formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { PanelEmpty } from "../../ui/PanelEmpty.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";

const DRUG_CLASS: Record<string, { text: string; color: string }> = {
  OTC: { text: "Không kê đơn", color: "green" },
  RX: { text: "Kê đơn", color: "orange" },
  CONTROLLED: { text: "Kiểm soát đặc biệt", color: "red" },
};

const PRODUCT_TYPE: Record<string, string> = {
  DRUG: "Thuốc",
  SUPPLEMENT: "Thực phẩm bảo vệ sức khỏe",
  MEDICAL_DEVICE: "Thiết bị y tế",
  COSMETIC: "Mỹ phẩm",
  OTHER: "Khác",
};

type TypeFilter = "ALL" | "RX" | "OTC" | "SUPPLEMENT" | "MEDICAL_DEVICE";

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

function ClassTag({ productType, drugClass }: { productType: string; drugClass: string | null }) {
  const info = drugClass ? DRUG_CLASS[drugClass] : null;
  return info ? <Tag color={info.color}>{info.text}</Tag> : <Tag>{PRODUCT_TYPE[productType] ?? "Không phải thuốc"}</Tag>;
}

/** Danh mục dùng chung toàn chuỗi. Tồn kho hiển thị theo cửa hàng đang chọn. */
export function ProductsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("ALL");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();
  const term = useDebounced(search.trim(), 300);
  // Chọn sản phẩm lưu trên URL để mở thẳng từ ô tìm nhanh và gửi link được.
  const selectedId = params.get("id");

  const products = useQuery({
    queryKey: ["products-page", term, typeFilter, page],
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<ProductListItem>>>("/products", {
          params: {
            search: term || undefined,
            page,
            limit: 20,
            ...(typeFilter === "RX" || typeFilter === "OTC" ? { productType: "DRUG", drugClass: typeFilter } : {}),
            ...(typeFilter === "SUPPLEMENT" || typeFilter === "MEDICAL_DEVICE" ? { productType: typeFilter } : {}),
          },
        })
      ).data.data,
    placeholderData: (previous) => previous,
  });
  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["products-page"] });
  }

  return (
    <div>
      <PageHeader
        icon={<MedicineBoxOutlined />}
        title="Thuốc & sản phẩm"
        description="Danh mục dùng chung toàn chuỗi: đơn vị tính, mã vạch, giá bán. Tồn kho tính theo cửa hàng đang chọn."
        extra={
          can("catalog.manage") ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              Thêm sản phẩm
            </Button>
          ) : null
        }
      />

      <div className="split-layout">
        <Card>
          <div className="toolbar">
            <Segmented
              value={typeFilter}
              onChange={(value) => {
                setTypeFilter(value as TypeFilter);
                setPage(1);
              }}
              options={[
                { label: "Tất cả", value: "ALL" },
                { label: "Kê đơn", value: "RX" },
                { label: "Không kê đơn", value: "OTC" },
                { label: "TPCN", value: "SUPPLEMENT" },
                { label: "Thiết bị y tế", value: "MEDICAL_DEVICE" },
              ]}
            />
            <Input.Search
              allowClear
              className="toolbar-grow"
              placeholder="Tên thuốc, hoạt chất, mã hoặc mã vạch"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <Table
            rowKey="id"
            loading={products.isFetching}
            dataSource={products.data?.items ?? []}
            scroll={{ x: 640 }}
            onRow={(row) => ({ onClick: () => setParams({ id: row.id }), style: { cursor: "pointer" } })}
            rowClassName={(row) => (row.id === selectedId ? "row-selected" : "")}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có sản phẩm phù hợp" /> }}
            pagination={{
              current: page,
              pageSize: products.data?.pagination.limit ?? 20,
              total: products.data?.pagination.total ?? 0,
              onChange: setPage,
              showSizeChanger: false,
              showTotal: (total) => `${total} sản phẩm`,
            }}
            columns={[
              {
                title: "Sản phẩm",
                key: "name",
                render: (_: unknown, item: ProductListItem) => (
                  <div className="cell-main">
                    <strong>{item.name}</strong>
                    <span>
                      {item.code} · {item.categoryName}
                    </span>
                  </div>
                ),
              },
              { title: "Phân loại", key: "class", width: 150, render: (_: unknown, item: ProductListItem) => <ClassTag productType={item.productType} drugClass={item.drugClass} /> },
              { title: "Giá bán", key: "price", width: 110, align: "right", render: (_: unknown, item: ProductListItem) => formatVnd(item.currentPrice?.salePrice) },
              {
                title: "Tồn bán được",
                key: "stock",
                width: 120,
                align: "right",
                render: (_: unknown, item: ProductListItem) => (item.stock ? <strong className={item.stock.sellable > 0 ? undefined : "text-danger"}>{formatNumber(item.stock.sellable)}</strong> : "—"),
              },
            ]}
          />
        </Card>
        <aside className="split-aside">
          <ProductDetailPanel id={selectedId} onClose={() => setParams({})} />
        </aside>
      </div>

      <ProductFormModal
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={async () => {
          setCreating(false);
          await refresh();
        }}
      />
    </div>
  );
}

function ProductDetailPanel({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const [editingUnit, setEditingUnit] = useState<ProductUnit | null | undefined>(undefined);
  const [pricingUnit, setPricingUnit] = useState<ProductUnit | null>(null);
  const [editingProduct, setEditingProduct] = useState(false);
  const queryClient = useQueryClient();
  const product = useQuery({ enabled: id !== null, queryKey: ["product", id], queryFn: async () => (await http.get<Envelope<ProductDetail>>(`/products/${id}`)).data.data });
  const item = product.data;
  async function refresh(): Promise<void> {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["product", id] }), queryClient.invalidateQueries({ queryKey: ["products-page"] })]);
  }

  if (id === null) {
    return (
      <Card title="Chi tiết sản phẩm">
        <PanelEmpty icon={<FileSearchOutlined />} title="Chưa chọn sản phẩm" description="Bấm vào một dòng để xem đơn vị tính, mã vạch và giá bán." />
      </Card>
    );
  }

  return (
    <>
      <Card
        title="Chi tiết sản phẩm"
        extra={
          <Button type="text" size="small" onClick={onClose}>
            Đóng
          </Button>
        }
      >
        {product.isLoading || !item ? (
          product.isError ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không tải được sản phẩm" />
          ) : (
            <Skeleton active paragraph={{ rows: 6 }} />
          )
        ) : (
          <div className="detail-stack">
            <div>
              <h3 className="detail-title">{item.name}</h3>
              <span className="detail-sub">
                <span className="mono">{item.code}</span> · <ClassTag productType={item.productType} drugClass={item.drugClass} />
              </span>
            </div>
            <dl className="kv-list">
              <div>
                <dt>Nhóm hàng</dt>
                <dd>{item.category.name}</dd>
              </div>
              <div>
                <dt>Hoạt chất</dt>
                <dd>{item.ingredients.length > 0 ? item.ingredients.map((ingredient) => [ingredient.name, ingredient.strengthText].filter(Boolean).join(" ")).join(", ") : "—"}</dd>
              </div>
              <div>
                <dt>Tồn bán được</dt>
                <dd>
                  <strong>{item.stock ? formatNumber(item.stock.sellable) : "—"}</strong>
                </dd>
              </div>
              <div>
                <dt>Tồn tối thiểu</dt>
                <dd>{formatNumber(item.minStockBaseQuantity)}</dd>
              </div>
            </dl>
            {can("catalog.manage") ? (
              <Button block icon={<EditOutlined />} onClick={() => setEditingProduct(true)}>
                Sửa thông tin sản phẩm
              </Button>
            ) : null}

            <div className="line-list">
              <div className="line-list-head">
                <span>Đơn vị tính & giá bán</span>
                {can("catalog.manage") ? (
                  <Button size="small" type="link" icon={<PlusOutlined />} onClick={() => setEditingUnit(null)}>
                    Thêm đơn vị
                  </Button>
                ) : null}
              </div>
              {item.units.map((unit) => (
                <div className="line-item" key={unit.id}>
                  <div className="line-item-main">
                    <strong>
                      {unit.name} {unit.isDefaultSaleUnit ? <Tag color="blue">Mặc định</Tag> : null} {unit.isSellable === false ? <Tag>Không bán</Tag> : null}
                    </strong>
                    <span>{unit.conversionToBase === 1 ? "Đơn vị cơ bản" : `1 ${unit.name} = ${formatNumber(unit.conversionToBase)} đơn vị cơ bản`}</span>
                    <span>
                      <BarcodeOutlined /> {unit.barcodes?.length ? unit.barcodes.join(", ") : "Chưa có mã vạch"}
                    </span>
                  </div>
                  <div className="line-item-side">
                    <strong>{formatVnd(unit.currentPrice?.salePrice)}</strong>
                    <span>
                      {can("catalog.manage") ? (
                        <Button size="small" type="link" onClick={() => setEditingUnit(unit)}>
                          Sửa
                        </Button>
                      ) : null}
                      {can("price.manage") ? (
                        <Button size="small" type="link" icon={<DollarOutlined />} onClick={() => setPricingUnit(unit)}>
                          Đặt giá
                        </Button>
                      ) : null}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
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
  const { message } = App.useApp();
  const [form] = Form.useForm<ProductEditForm>();
  const categories = useQuery({ enabled: open, queryKey: ["product-categories"], queryFn: async () => (await http.get<Envelope<Paged<CategoryItem>>>("/categories", { params: { limit: 100 } })).data.data.items });
  const save = useMutation({
    mutationFn: (values: ProductEditForm) => http.patch(`/products/${product.id}`, { ...values, version: product.version }),
    onSuccess: async () => {
      void message.success("Đã lưu sản phẩm");
      await onSaved();
      onClose();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được sản phẩm")),
  });
  return (
    <Modal
      open={open}
      title="Sửa sản phẩm"
      okText="Lưu"
      cancelText="Hủy"
      onCancel={onClose}
      onOk={() => void form.validateFields().then((values) => save.mutate(values))}
      confirmLoading={save.isPending}
      afterOpenChange={(visible) => {
        if (visible) form.setFieldsValue({ name: product.name, categoryId: product.category.id, minStockBaseQuantity: product.minStockBaseQuantity });
      }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="Tên sản phẩm" rules={[{ required: true, whitespace: true, message: "Nhập tên sản phẩm" }]}>
          <Input />
        </Form.Item>
        <Form.Item name="categoryId" label="Nhóm hàng" rules={[{ required: true, message: "Chọn nhóm hàng" }]}>
          <Select loading={categories.isLoading} showSearch optionFilterProp="label" options={categories.data?.map((item) => ({ value: item.id, label: item.name }))} />
        </Form.Item>
        <Form.Item name="minStockBaseQuantity" label="Tồn tối thiểu (đơn vị cơ bản)">
          <InputNumber min={0} precision={0} style={{ width: "100%" }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

type UnitForm = { name: string; conversionToBase?: number; isSellable?: boolean; isDefaultSaleUnit?: boolean; barcodesText?: string };
function UnitModal({ productId, unit, open, onClose, onSaved }: { productId: string; unit: ProductUnit | null; open: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<UnitForm>();
  const save = useMutation({
    mutationFn: async (values: UnitForm) => {
      const body = { ...values, barcodes: (values.barcodesText ?? "").split(/[\n,]/).map((value) => value.trim()).filter(Boolean) };
      if (unit) await http.patch(`/products/${productId}/units/${unit.id}`, body);
      else await http.post(`/products/${productId}/units`, { ...body, conversionToBase: values.conversionToBase });
    },
    onSuccess: async () => {
      void message.success(unit ? "Đã lưu đơn vị tính" : "Đã thêm đơn vị tính");
      await onSaved();
      onClose();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được đơn vị tính")),
  });
  return (
    <Modal
      open={open}
      title={unit ? "Sửa đơn vị tính" : "Thêm đơn vị tính"}
      okText="Lưu"
      cancelText="Hủy"
      onCancel={onClose}
      onOk={() => void form.validateFields().then((values) => save.mutate(values))}
      confirmLoading={save.isPending}
      afterOpenChange={(visible) => {
        if (visible)
          form.setFieldsValue({
            name: unit?.name ?? "",
            conversionToBase: unit?.conversionToBase,
            isSellable: unit?.isSellable ?? true,
            isDefaultSaleUnit: unit?.isDefaultSaleUnit ?? false,
            barcodesText: unit?.barcodes?.join(", ") ?? "",
          });
      }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="Tên đơn vị" rules={[{ required: true, whitespace: true, message: "Nhập tên đơn vị" }]}>
          <Input placeholder="Ví dụ: Hộp, Vỉ, Viên" />
        </Form.Item>
        {unit ? (
          <Typography.Paragraph type="secondary">Hệ số quy đổi không thể sửa sau khi đã tạo.</Typography.Paragraph>
        ) : (
          <Form.Item name="conversionToBase" label="Hệ số quy đổi sang đơn vị cơ bản" rules={[{ required: true, message: "Nhập hệ số quy đổi" }]}>
            <InputNumber min={1} precision={0} style={{ width: "100%" }} />
          </Form.Item>
        )}
        <Form.Item name="barcodesText" label="Mã vạch">
          <Input.TextArea rows={2} placeholder="Ngăn cách bằng dấu phẩy hoặc xuống dòng" />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="isSellable" label="Được phép bán">
              <Select options={[{ value: true, label: "Có" }, { value: false, label: "Không" }]} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="isDefaultSaleUnit" label="Đơn vị bán mặc định">
              <Select options={[{ value: true, label: "Có" }, { value: false, label: "Không" }]} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}

type PriceForm = { salePrice: number; vatRatePercent: number; scope: "CHAIN" | "STORE" };
function PriceModal({ productId, unit, onClose, onSaved }: { productId: string; unit: ProductUnit; onClose: () => void; onSaved: () => Promise<void> }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<PriceForm>();
  const save = useMutation({
    mutationFn: (values: PriceForm) => http.post(`/products/${productId}/prices`, { ...values, unitId: unit.id }),
    onSuccess: async () => {
      void message.success("Đã tạo phiên bản giá mới");
      await onSaved();
      onClose();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không đặt được giá")),
  });
  return (
    <Modal open title={`Đặt giá — ${unit.name}`} okText="Lưu giá" cancelText="Hủy" onCancel={onClose} onOk={() => void form.validateFields().then((values) => save.mutate(values))} confirmLoading={save.isPending} destroyOnHidden>
      <Typography.Paragraph type="secondary">Giá cũ không bị sửa; hệ thống tạo một phiên bản giá mới để bảo toàn hóa đơn lịch sử.</Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={{ vatRatePercent: 0, scope: "CHAIN", salePrice: unit.currentPrice?.salePrice }}>
        <Form.Item name="salePrice" label="Giá bán (đồng)" rules={[{ required: true, message: "Nhập giá bán" }]}>
          <InputNumber<number> min={0} precision={0} style={{ width: "100%" }} formatter={(value) => (value ? Number(value).toLocaleString("vi-VN") : "")} parser={(value) => Number((value ?? "").replace(/\D/g, ""))} />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="vatRatePercent" label="VAT (%)" rules={[{ required: true }]}>
              <InputNumber min={0} max={100} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="scope" label="Phạm vi giá">
              <Select options={[{ value: "CHAIN", label: "Toàn chuỗi" }, { value: "STORE", label: "Chỉ cửa hàng đang chọn" }]} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}

function ProductFormModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<ProductForm>();
  const productType = Form.useWatch("productType", form);
  const queryClient = useQueryClient();
  const categories = useQuery({ enabled: open, queryKey: ["product-categories"], queryFn: async () => (await http.get<Envelope<Paged<CategoryItem>>>("/categories", { params: { limit: 100 } })).data.data.items });
  const ingredients = useQuery({ enabled: open, queryKey: ["active-ingredients"], queryFn: async () => (await http.get<Envelope<Paged<ActiveIngredientItem>>>("/active-ingredients", { params: { limit: 100 } })).data.data.items });
  const create = useMutation({
    mutationFn: async (values: ProductForm) =>
      http.post("/products", {
        ...values,
        drugClass: values.productType === "DRUG" ? values.drugClass : null,
        minStockBaseQuantity: values.minStockBaseQuantity ?? 0,
        ingredients: (values.ingredients ?? []).map((ingredientId) => ({ ingredientId })),
      }),
    onSuccess: async () => {
      void message.success("Đã thêm sản phẩm");
      form.resetFields();
      await queryClient.invalidateQueries({ queryKey: ["products-page"] });
      await onSaved();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không thêm được sản phẩm")),
  });
  return (
    <Modal
      width={680}
      open={open}
      title="Thêm sản phẩm"
      okText="Lưu sản phẩm"
      cancelText="Hủy"
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      onOk={() => void form.validateFields().then((values) => create.mutate(values))}
      confirmLoading={create.isPending}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" initialValues={{ productType: "DRUG", baseUnitName: "Viên", minStockBaseQuantity: 0 }}>
        <Row gutter={12}>
          <Col xs={24} sm={8}>
            <Form.Item name="code" label="Mã sản phẩm" rules={[{ required: true, whitespace: true, message: "Nhập mã" }]}>
              <Input placeholder="TH0001" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={16}>
            <Form.Item name="name" label="Tên sản phẩm" rules={[{ required: true, whitespace: true, message: "Nhập tên sản phẩm" }]}>
              <Input placeholder="Ví dụ: Paracetamol 500mg" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={productType === "DRUG" ? 8 : 12}>
            <Form.Item name="productType" label="Loại hàng" rules={[{ required: true }]}>
              <Select options={Object.entries(PRODUCT_TYPE).map(([value, label]) => ({ value, label }))} />
            </Form.Item>
          </Col>
          {productType === "DRUG" ? (
            <Col xs={24} sm={8}>
              <Form.Item name="drugClass" label="Phân loại thuốc" rules={[{ required: true, message: "Chọn phân loại thuốc" }]}>
                <Select options={Object.entries(DRUG_CLASS).map(([value, info]) => ({ value, label: info.text }))} />
              </Form.Item>
            </Col>
          ) : null}
          <Col xs={24} sm={productType === "DRUG" ? 8 : 12}>
            <Form.Item name="categoryId" label="Nhóm hàng" rules={[{ required: true, message: "Chọn nhóm hàng" }]}>
              <Select loading={categories.isLoading} showSearch optionFilterProp="label" options={categories.data?.map((item) => ({ value: item.id, label: item.name }))} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="baseUnitName" label="Đơn vị cơ bản" rules={[{ required: true, whitespace: true, message: "Nhập đơn vị cơ bản" }]}>
              <Input placeholder="Ví dụ: Viên, Chai" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="minStockBaseQuantity" label="Tồn tối thiểu">
              <InputNumber min={0} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="ingredients" label="Hoạt chất (nếu có)" extra="Cần gắn hoạt chất để hệ thống kiểm tra trùng hoạt chất và dị ứng khi bán.">
          <Select mode="multiple" showSearch optionFilterProp="label" loading={ingredients.isLoading} options={ingredients.data?.map((item) => ({ value: item.id, label: item.atcCode ? `${item.name} (${item.atcCode})` : item.name }))} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
