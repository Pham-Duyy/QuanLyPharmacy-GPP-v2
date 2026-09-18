import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Col, Form, Input, InputNumber, Modal, Row, Select, Typography } from "antd";
import { getErrorMessage, http } from "../../../api/http.js";
import type { ActiveIngredientItem, CategoryItem, Envelope, Paged, ProductDetail, ProductUnit } from "../../../api/types.js";
import { DRUG_CLASS, PRODUCT_TYPE } from "./product-labels.js";

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

function useCategories(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["product-categories"],
    queryFn: async () => (await http.get<Envelope<Paged<CategoryItem>>>("/categories", { params: { limit: 100 } })).data.data.items,
  });
}

type ProductEditForm = {
  name: string;
  categoryId: string;
  minStockBaseQuantity: number;
  registrationNumber?: string | null;
  dosageForm?: string | null;
  strengthText?: string | null;
  packagingText?: string | null;
  manufacturer?: string | null;
  countryOfOrigin?: string | null;
  storageCondition?: string | null;
};

const OPTIONAL_TEXT: Array<{ name: keyof ProductEditForm; label: string; placeholder: string; max: number }> = [
  { name: "registrationNumber", label: "Số đăng ký", placeholder: "VD: VD-12345-20", max: 50 },
  { name: "dosageForm", label: "Dạng bào chế", placeholder: "VD: Viên nén bao phim", max: 100 },
  { name: "strengthText", label: "Hàm lượng", placeholder: "VD: 500 mg", max: 100 },
  { name: "packagingText", label: "Quy cách đóng gói", placeholder: "VD: Hộp 10 vỉ x 10 viên", max: 200 },
  { name: "manufacturer", label: "Nhà sản xuất", placeholder: "", max: 200 },
  { name: "countryOfOrigin", label: "Nước sản xuất", placeholder: "", max: 100 },
];

/**
 * Sửa thông tin danh mục dùng chung. Không có trường loại hàng/phân loại kê
 * đơn: đổi phân loại ảnh hưởng luật bán thuốc nên không sửa ở đây. Không
 * đụng tới tồn kho của cửa hàng nào.
 */
export function ProductEditModal({ product, open, onClose, onSaved }: { product: ProductDetail; open: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<ProductEditForm>();
  const categories = useCategories(open);
  const baseUnit = product.units.find((unit) => unit.conversionToBase === 1);
  const save = useMutation({
    mutationFn: (values: ProductEditForm) => {
      // Ô để trống gửi null để xóa giá trị cũ thay vì giữ nguyên.
      const cleaned = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === "string" && value.trim() === "" ? null : value]));
      return http.patch(`/products/${product.id}`, { ...cleaned, version: product.version });
    },
    onSuccess: async () => {
      void message.success("Đã lưu thông tin sản phẩm");
      await onSaved();
      onClose();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được sản phẩm")),
  });
  // Giá trị ban đầu gắn thẳng vào Form (hộp thoại tạo lại mỗi lần mở): điền trong
  // afterOpenChange sẽ ghi đè những gì người dùng đã kịp gõ trong lúc hộp thoại đang mở ra.
  return (
    <Modal
      open={open}
      width={680}
      title="Sửa thông tin sản phẩm"
      okText="Lưu"
      cancelText="Hủy"
      onCancel={onClose}
      onOk={() => void form.validateFields().then((values) => save.mutate(values))}
      confirmLoading={save.isPending}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">Danh mục dùng chung toàn chuỗi. Loại hàng và phân loại kê đơn không sửa tại đây.</Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          name: product.name,
          categoryId: product.category.id,
          minStockBaseQuantity: product.minStockBaseQuantity,
          registrationNumber: product.registrationNumber ?? "",
          dosageForm: product.dosageForm ?? "",
          strengthText: product.strengthText ?? "",
          packagingText: product.packagingText ?? "",
          manufacturer: product.manufacturer ?? "",
          countryOfOrigin: product.countryOfOrigin ?? "",
          storageCondition: product.storageCondition ?? "",
        }}
      >
        <Form.Item name="name" label="Tên sản phẩm" rules={[{ required: true, whitespace: true, message: "Nhập tên sản phẩm" }, { max: 300 }]}>
          <Input />
        </Form.Item>
        <Row gutter={12}>
          <Col xs={24} sm={12}>
            <Form.Item name="categoryId" label="Nhóm hàng" rules={[{ required: true, message: "Chọn nhóm hàng" }]}>
              <Select loading={categories.isLoading} showSearch optionFilterProp="label" options={categories.data?.map((item) => ({ value: item.id, label: item.name }))} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="minStockBaseQuantity" label={`Tồn tối thiểu (${baseUnit?.name ?? "đơn vị cơ bản"})`} rules={[{ required: true, message: "Nhập tồn tối thiểu" }]}>
              <InputNumber min={0} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          {OPTIONAL_TEXT.map((field) => (
            <Col xs={24} sm={12} key={field.name}>
              <Form.Item name={field.name} label={field.label} rules={[{ max: field.max, message: `Tối đa ${field.max} ký tự` }]}>
                <Input placeholder={field.placeholder} />
              </Form.Item>
            </Col>
          ))}
        </Row>
        <Form.Item name="storageCondition" label="Điều kiện bảo quản" rules={[{ max: 200 }]}>
          <Input placeholder="VD: Nơi khô, dưới 30°C, tránh ánh sáng" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

type UnitForm = { name: string; conversionToBase?: number; isSellable?: boolean; isDefaultSaleUnit?: boolean; barcodesText?: string };

export function UnitModal({ productId, baseUnitName, unit, open, onClose, onSaved }: { productId: string; baseUnitName: string; unit: ProductUnit | null; open: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
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
      title={unit ? `Sửa đơn vị — ${unit.name}` : "Thêm đơn vị tính"}
      okText="Lưu"
      cancelText="Hủy"
      onCancel={onClose}
      onOk={() => void form.validateFields().then((values) => save.mutate(values))}
      confirmLoading={save.isPending}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          name: unit?.name ?? "",
          conversionToBase: unit?.conversionToBase,
          isSellable: unit?.isSellable ?? true,
          isDefaultSaleUnit: unit?.isDefaultSaleUnit ?? false,
          barcodesText: unit?.barcodes?.join(", ") ?? "",
        }}
      >
        <Form.Item name="name" label="Tên đơn vị" rules={[{ required: true, whitespace: true, message: "Nhập tên đơn vị" }]}>
          <Input placeholder="Ví dụ: Hộp, Vỉ, Lọ" />
        </Form.Item>
        {unit ? (
          <Typography.Paragraph type="secondary">
            Quy đổi: 1 {unit.name} = {unit.conversionToBase} {baseUnitName}. Hệ số quy đổi không sửa được sau khi đã tạo để không làm sai tồn kho và chứng từ cũ.
          </Typography.Paragraph>
        ) : (
          <Form.Item name="conversionToBase" label={`Hệ số quy đổi (1 đơn vị này = ? ${baseUnitName})`} rules={[{ required: true, message: "Nhập hệ số quy đổi" }]}>
            <InputNumber min={1} precision={0} style={{ width: "100%" }} />
          </Form.Item>
        )}
        <Form.Item name="barcodesText" label="Mã vạch" extra="Mỗi mã từ 6 ký tự; ngăn cách bằng dấu phẩy hoặc xuống dòng.">
          <Input.TextArea rows={2} />
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

export function PriceModal({ productId, unit, onClose, onSaved }: { productId: string; unit: ProductUnit; onClose: () => void; onSaved: () => Promise<void> }) {
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
      <Form
        form={form}
        layout="vertical"
        initialValues={{ vatRatePercent: unit.currentPrice ? Number(unit.currentPrice.vatRatePercent) : 0, scope: "CHAIN", salePrice: unit.currentPrice?.salePrice }}
      >
        <Form.Item name="salePrice" label="Giá bán (đồng)" rules={[{ required: true, message: "Nhập giá bán" }]}>
          <InputNumber<number> min={0} precision={0} style={{ width: "100%" }} formatter={(value) => (value ? Number(value).toLocaleString("vi-VN") : "")} parser={(value) => Number((value ?? "").replace(/\D/g, ""))} />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="vatRatePercent" label="VAT (%)" rules={[{ required: true, message: "Nhập VAT" }]}>
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

export function ProductFormModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<ProductForm>();
  const productType = Form.useWatch("productType", form);
  const queryClient = useQueryClient();
  const categories = useCategories(open);
  const ingredients = useQuery({ enabled: open, queryKey: ["active-ingredients"], queryFn: async () => (await http.get<Envelope<Paged<ActiveIngredientItem>>>("/active-ingredients", { params: { limit: 100 } })).data.data.items });
  const create = useMutation({
    mutationFn: async (values: ProductForm) =>
      (
        await http.post<Envelope<{ id: string }>>("/products", {
          ...values,
          drugClass: values.productType === "DRUG" ? values.drugClass : null,
          minStockBaseQuantity: values.minStockBaseQuantity ?? 0,
          ingredients: (values.ingredients ?? []).map((ingredientId) => ({ ingredientId })),
        })
      ).data.data,
    onSuccess: async (created) => {
      void message.success("Đã thêm sản phẩm");
      form.resetFields();
      await queryClient.invalidateQueries({ queryKey: ["products-page"] });
      await onSaved(created.id);
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
              <Select options={Object.entries(PRODUCT_TYPE).map(([value, info]) => ({ value, label: info.text }))} />
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
