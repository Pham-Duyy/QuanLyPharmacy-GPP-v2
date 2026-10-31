import { DeleteOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  DatePicker,
  Empty,
  Input,
  InputNumber,
  Modal,
  Select,
  Table,
} from "antd";
import dayjs from "dayjs";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import {
  formatVnd,
  type Envelope,
  type Paged,
  type ProductDetail,
  type ProductListItem,
  type SupplierListItem,
} from "../../api/types.js";
import { useDebounced } from "../../ui/useDebounced.js";
import {
  purchaseOrdersApi,
  type OrderInput,
  type PurchaseOrderDetail,
} from "./purchase-orders-api.js";

type Line = {
  key: string;
  productId: string;
  productCode: string;
  productName: string;
  unitId: string;
  units: Array<{ id: string; name: string; conversionToBase: number }>;
  quantity: number;
  unitPrice: number | null;
};

type Props = {
  open: boolean;
  order: PurchaseOrderDetail | null;
  onClose: () => void;
  onSaved: (id: string) => void;
};

/** Lập hoặc sửa đơn nháp: nhà cung cấp, ngày giao dự kiến, dòng hàng, đơn giá dự kiến. */
export function OrderFormModal(props: Props) {
  // Dựng lại mỗi lần mở: dữ liệu form luôn lấy từ đơn đang sửa, không sót của lần trước.
  return props.open ? <OrderForm {...props} /> : null;
}

function OrderForm({ open, order, onClose, onSaved }: Props) {
  const { message } = App.useApp();
  const [supplierId, setSupplierId] = useState<string | undefined>(order?.supplier.id);
  const [expectedDate, setExpectedDate] = useState<string | null>(
    order?.expectedDate?.slice(0, 10) ?? null,
  );
  const [note, setNote] = useState(order?.note ?? "");
  const [lines, setLines] = useState<Line[]>(() =>
    (order?.lines ?? []).map((line) => ({
      key: line.id,
      productId: line.productId,
      productCode: line.productCode,
      productName: line.productName,
      unitId: line.unitId,
      units: [{ id: line.unitId, name: line.unitName, conversionToBase: line.conversionToBase }],
      quantity: line.quantity,
      unitPrice: line.unitPrice,
    })),
  );
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const term = useDebounced(search.trim(), 250);

  const suppliers = useQuery({
    queryKey: ["order-suppliers"],
    enabled: open,
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<SupplierListItem>>>("/suppliers", {
          params: { page: 1, limit: 100 },
        })
      ).data.data.items,
  });
  const products = useQuery({
    queryKey: ["order-products", term],
    enabled: open && term.length > 0,
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<ProductListItem>>>("/products", {
          params: { search: term, page: 1, limit: 15 },
        })
      ).data.data.items,
  });

  async function addProduct(productId: string) {
    setSearch("");
    if (lines.some((line) => line.productId === productId)) {
      void message.info("Sản phẩm đã có trong đơn");
      return;
    }
    try {
      const product = (await http.get<Envelope<ProductDetail>>(`/products/${productId}`)).data.data;
      const units = product.units
        .filter((unit) => unit.isActive !== false)
        .sort((a, b) => b.conversionToBase - a.conversionToBase);
      const unit = units[0];
      if (!unit) return void message.error("Sản phẩm chưa có đơn vị tính");
      setLines((current) => [
        ...current,
        {
          key: product.id,
          productId: product.id,
          productCode: product.code,
          productName: product.name,
          unitId: unit.id,
          units,
          quantity: 1,
          unitPrice: null,
        },
      ]);
    } catch (caught) {
      void message.error(getErrorMessage(caught, "Không tải được sản phẩm"));
    }
  }

  const update = (key: string, patch: Partial<Line>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  const total = lines.reduce((sum, line) => sum + (line.unitPrice ?? 0) * line.quantity, 0);

  async function save() {
    if (!supplierId) return setError("Chọn nhà cung cấp");
    if (lines.length === 0) return setError("Thêm ít nhất một mặt hàng");
    setSaving(true);
    setError(null);
    const input: OrderInput = {
      supplierId,
      expectedDate,
      note: note.trim() || null,
      lines: lines.map((line) => ({
        productId: line.productId,
        unitId: line.unitId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
      })),
    };
    try {
      const saved = order
        ? await purchaseOrdersApi.update(order.id, { ...input, version: order.version })
        : await purchaseOrdersApi.create(input);
      onSaved(saved.id);
    } catch (caught) {
      setError(getErrorMessage(caught, "Không lưu được đơn"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => void save()}
      okText={order ? "Lưu đơn" : "Lập đơn nháp"}
      cancelText="Hủy"
      confirmLoading={saving}
      title={order ? `Sửa đơn ${order.code}` : "Lập đơn đặt hàng"}
      width={920}
      destroyOnHidden
    >
      <div className="detail-stack">
        {error && <Alert type="error" showIcon title={error} />}
        <div className="form-grid">
          <label className="field">
            <span>Nhà cung cấp</span>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="Chọn nhà cung cấp"
              value={supplierId}
              onChange={setSupplierId}
              loading={suppliers.isLoading}
              options={(suppliers.data ?? [])
                .filter((item) => item.isActive)
                .map((item) => ({ value: item.id, label: item.name }))}
            />
          </label>
          <label className="field">
            <span>Ngày giao dự kiến</span>
            <DatePicker
              format="DD/MM/YYYY"
              value={expectedDate ? dayjs(expectedDate) : null}
              disabledDate={(date) => date.isBefore(dayjs(), "day")}
              onChange={(value) => setExpectedDate(value ? value.format("YYYY-MM-DD") : null)}
              style={{ width: "100%" }}
            />
          </label>
        </div>
        <label className="field">
          <span>Ghi chú gửi nhà cung cấp</span>
          <Input.TextArea
            rows={2}
            maxLength={1000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Ví dụ: giao giờ hành chính, gọi trước khi giao"
          />
        </label>
        <Select
          showSearch
          value={null}
          placeholder="Gõ tên hoặc mã thuốc để thêm vào đơn"
          filterOption={false}
          searchValue={search}
          onSearch={setSearch}
          onChange={(value: string) => void addProduct(value)}
          loading={products.isFetching}
          notFoundContent={term ? "Không tìm thấy" : null}
          options={(products.data ?? []).map((item) => ({
            value: item.id,
            label: `${item.code} · ${item.name}`,
          }))}
          style={{ width: "100%" }}
        />
        <Table<Line>
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={lines}
          scroll={{ x: 720 }}
          locale={{ emptyText: <Empty description="Chưa có mặt hàng" /> }}
          columns={[
            {
              title: "Sản phẩm",
              render: (_, line) => (
                <span>
                  <strong>{line.productName}</strong>
                  <br />
                  <span className="text-secondary">{line.productCode}</span>
                </span>
              ),
            },
            {
              title: "Đơn vị",
              width: 120,
              render: (_, line) => (
                <Select
                  size="small"
                  value={line.unitId}
                  style={{ width: "100%" }}
                  onChange={(unitId: string) => update(line.key, { unitId })}
                  options={line.units.map((unit) => ({ value: unit.id, label: unit.name }))}
                />
              ),
            },
            {
              title: "Số lượng",
              width: 110,
              render: (_, line) => (
                <InputNumber
                  size="small"
                  min={1}
                  max={100_000}
                  precision={0}
                  value={line.quantity}
                  onChange={(value) => update(line.key, { quantity: Number(value ?? 1) })}
                  style={{ width: "100%" }}
                />
              ),
            },
            {
              title: "Đơn giá dự kiến",
              width: 150,
              render: (_, line) => (
                <InputNumber
                  size="small"
                  min={0}
                  precision={0}
                  value={line.unitPrice}
                  placeholder="Chưa biết"
                  formatter={(value) => (value ? Number(value).toLocaleString("vi-VN") : "")}
                  parser={(value) => Number((value ?? "").replace(/\D/g, ""))}
                  onChange={(value) =>
                    update(line.key, { unitPrice: value === null ? null : Number(value) })
                  }
                  style={{ width: "100%" }}
                />
              ),
            },
            {
              title: "",
              width: 44,
              render: (_, line) => (
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label="Bỏ dòng"
                  onClick={() =>
                    setLines((current) => current.filter((item) => item.key !== line.key))
                  }
                />
              ),
            },
          ]}
        />
        {total > 0 && (
          <p className="section-note" style={{ margin: 0, textAlign: "right" }}>
            Tạm tính <b>{formatVnd(total)}</b>
          </p>
        )}
      </div>
    </Modal>
  );
}
