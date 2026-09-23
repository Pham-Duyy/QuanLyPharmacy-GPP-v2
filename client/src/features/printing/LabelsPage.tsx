import { BarcodeOutlined, DeleteOutlined, EyeOutlined, PlusOutlined, PrinterOutlined } from "@ant-design/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, App, AutoComplete, Button, Card, Empty, InputNumber, Segmented, Select, Skeleton, Switch, Table, Tooltip } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { getErrorMessage, http } from "../../api/http.js";
import type { Envelope, Paged, ProductDetail, ProductListItem } from "../../api/types.js";
import { formatDate, formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { printHtml } from "./printing.js";

type LabelSize = { value: string; label: string; width: number; height: number; sheet: boolean };
type Unit = { id: string; name: string; conversionToBase: number };
type BatchOption = { id: string; batchNumber: string; expiryDate: string; quantityOnHand: number };

type Row = {
  key: string;
  productId: string;
  productCode: string;
  productName: string;
  units: Unit[];
  unitId: string;
  batchId: string | null;
  quantity: number;
};

type Warning = { productName: string; message: string };

export function LabelsPage() {
  const { message } = App.useApp();
  const [params] = useSearchParams();
  const [size, setSize] = useState("50x30");
  const [showPrice, setShowPrice] = useState(true);
  const [showBatch, setShowBatch] = useState(false);
  const [showStoreName, setShowStoreName] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const term = useDebounced(search.trim(), 300);
  const preselect = params.get("sanpham");

  const sizes = useQuery({
    queryKey: ["label-sizes"],
    queryFn: async () => (await http.get<Envelope<LabelSize[]>>("/labels/sizes")).data.data,
  });

  const products = useQuery({
    queryKey: ["label-products", term],
    enabled: term.length > 0,
    queryFn: async () => (await http.get<Envelope<Paged<ProductListItem>>>("/products", { params: { search: term, page: 1, limit: 12 } })).data.data.items,
  });

  const batches = useQuery({
    queryKey: ["label-batches", rows.map((row) => row.productId).join(",")],
    enabled: showBatch && rows.length > 0,
    queryFn: async () => {
      const result = await Promise.all(
        [...new Set(rows.map((row) => row.productId))].map(async (productId) => {
          const items = (await http.get<Envelope<Paged<BatchOption>>>("/inventory/batches", { params: { productId, page: 1, limit: 50 } })).data.data.items;
          return [productId, items] as const;
        }),
      );
      return Object.fromEntries(result) as Record<string, BatchOption[]>;
    },
  });

  const body = useMemo(
    () => ({
      size,
      showPrice,
      showBatch,
      showStoreName,
      items: rows.map((row) => ({ productId: row.productId, unitId: row.unitId, batchId: showBatch ? row.batchId : null, quantity: row.quantity })),
    }),
    [size, showPrice, showBatch, showStoreName, rows],
  );

  const render = useMutation({
    mutationFn: async (mode: "preview" | "print") => {
      const response = await http.post<string>(`/labels/print${mode === "preview" ? "?autoprint=0" : ""}`, body, { responseType: "text" });
      const raw = response.headers["x-label-warnings"];
      return { html: response.data, mode, warnings: raw ? (JSON.parse(decodeURIComponent(String(raw))) as Warning[]) : [] };
    },
    onSuccess: async (result) => {
      setWarnings(result.warnings);
      if (result.mode === "preview") setPreview(result.html);
      else await printHtml(result.html);
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không dựng được tem"), 8),
  });

  function rowFrom(product: ProductListItem | ProductDetail): Row | null {
    // Danh sách sản phẩm trả `saleUnits`, còn chi tiết sản phẩm trả `units`.
    const source = ("saleUnits" in product ? product.saleUnits : undefined) ?? ("units" in product ? product.units : undefined) ?? [];
    const units: Unit[] = source.map((unit) => ({ id: unit.id, name: unit.name, conversionToBase: unit.conversionToBase }));
    const unit = units.find((item) => item.conversionToBase === 1) ?? units[0];
    if (!unit) return null;
    return { key: crypto.randomUUID(), productId: product.id, productCode: product.code, productName: product.name, units, unitId: unit.id, batchId: null, quantity: 1 };
  }

  function addProduct(product: ProductListItem | ProductDetail): void {
    const row = rowFrom(product);
    if (!row) {
      void message.error(`${product.name} chưa có đơn vị tính`);
      return;
    }
    setRows((current) => [...current, row]);
    setSearch("");
    setPreview(null);
  }

  // Mở từ danh mục thuốc (?sanpham=): thêm sẵn mặt hàng đang xem.
  const preselected = useQuery({
    queryKey: ["label-preselect", preselect],
    enabled: Boolean(preselect),
    queryFn: async () => (await http.get<Envelope<ProductDetail>>(`/products/${preselect}`)).data.data,
  });

  useEffect(() => {
    const product = preselected.data;
    if (!product) return;
    setRows((current) => {
      if (current.some((row) => row.productId === product.id)) return current;
      const row = rowFrom(product);
      return row ? [...current, row] : current;
    });
    // Chỉ chạy khi mặt hàng mở kèm đường dẫn được tải xong.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselected.data]);

  const update = (key: string, patch: Partial<Row>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    setPreview(null);
  };

  const totalLabels = rows.reduce((sum, row) => sum + row.quantity, 0);
  const activeSize = sizes.data?.find((item) => item.value === size);

  return (
    <div>
      <PageHeader
        icon={<BarcodeOutlined />}
        title="In tem mã vạch"
        description="In tem dán lên hộp thuốc hoặc nhãn kệ: tên thuốc, mã vạch, giá bán, số lô và hạn dùng."
        extra={
          <>
            <Button icon={<EyeOutlined />} disabled={rows.length === 0} loading={render.isPending && render.variables === "preview"} onClick={() => render.mutate("preview")}>
              Xem trước
            </Button>
            <Button
              type="primary"
              icon={<PrinterOutlined />}
              disabled={rows.length === 0}
              loading={render.isPending && render.variables === "print"}
              onClick={() => render.mutate("print")}
            >
              In {totalLabels > 0 ? `${formatNumber(totalLabels)} tem` : "tem"}
            </Button>
          </>
        }
      />

      <Card className="count-banner">
        {sizes.isLoading ? (
          <Skeleton active />
        ) : (
          <div className="label-options">
            <label className="label-size">
              <span>Khổ tem</span>
              <Segmented
                value={size}
                onChange={(value) => {
                  setSize(String(value));
                  setPreview(null);
                }}
                options={(sizes.data ?? []).map((item) => ({ value: item.value, label: item.label }))}
              />
            </label>
            <label>
              <Switch
                checked={showPrice}
                size="small"
                onChange={(value) => {
                  setShowPrice(value);
                  setPreview(null);
                }}
              />{" "}
              In giá bán
            </label>
            <label>
              <Switch
                checked={showBatch}
                size="small"
                onChange={(value) => {
                  setShowBatch(value);
                  setPreview(null);
                }}
              />{" "}
              In số lô và hạn dùng
            </label>
            <label>
              <Switch
                checked={showStoreName}
                size="small"
                onChange={(value) => {
                  setShowStoreName(value);
                  setPreview(null);
                }}
              />{" "}
              In tên nhà thuốc
            </label>
          </div>
        )}
      </Card>

      <Card
        title="Mặt hàng cần in tem"
        extra={
          <AutoComplete
            value={search}
            onChange={setSearch}
            style={{ width: 340 }}
            options={(products.data ?? []).map((product) => ({ value: product.id, label: `${product.name} · ${product.code}` }))}
            onSelect={(value) => {
              const product = products.data?.find((item) => item.id === value);
              if (product) addProduct(product);
            }}
            placeholder="Tìm tên thuốc, mã hoặc hoạt chất để thêm"
          />
        }
      >
        <Table
          rowKey="key"
          size="small"
          dataSource={rows}
          pagination={false}
          scroll={{ x: 760 }}
          columns={[
            {
              title: "Sản phẩm",
              dataIndex: "productName",
              render: (_: string, row: Row) => (
                <div className="cell-main">
                  <span className="cell-title">{row.productName}</span>
                  <span className="cell-sub">{row.productCode}</span>
                </div>
              ),
            },
            {
              title: "Đơn vị in trên tem",
              dataIndex: "unitId",
              width: 170,
              render: (unitId: string, row: Row) => (
                <Select value={unitId} style={{ width: "100%" }} options={row.units.map((unit) => ({ value: unit.id, label: unit.name }))} onChange={(value) => update(row.key, { unitId: value })} />
              ),
            },
            ...(showBatch
              ? [
                  {
                    title: "Lô",
                    dataIndex: "batchId",
                    width: 250,
                    render: (batchId: string | null, row: Row) => (
                      <Select
                        allowClear
                        value={batchId}
                        style={{ width: "100%" }}
                        placeholder="Chọn lô"
                        loading={batches.isFetching}
                        options={(batches.data?.[row.productId] ?? []).map((batch) => ({
                          value: batch.id,
                          label: `${batch.batchNumber} · HSD ${formatDate(batch.expiryDate)} · tồn ${formatNumber(batch.quantityOnHand)}`,
                        }))}
                        onChange={(value) => update(row.key, { batchId: value ?? null })}
                      />
                    ),
                  },
                ]
              : []),
            {
              title: "Số tem",
              dataIndex: "quantity",
              width: 120,
              render: (quantity: number, row: Row) => (
                <InputNumber min={1} max={500} value={quantity} style={{ width: "100%" }} onChange={(value) => update(row.key, { quantity: Number(value ?? 1) })} />
              ),
            },
            {
              title: "",
              dataIndex: "key",
              width: 60,
              render: (key: string) => (
                <Tooltip title="Bỏ khỏi danh sách">
                  <Button
                    size="small"
                    type="text"
                    icon={<DeleteOutlined />}
                    onClick={() => {
                      setRows((current) => current.filter((row) => row.key !== key));
                      setPreview(null);
                    }}
                  />
                </Tooltip>
              ),
            },
          ]}
          locale={{
            emptyText: (
              <Empty description="Chưa chọn mặt hàng nào">
                <span className="cell-sub">
                  <PlusOutlined /> Gõ tên thuốc ở ô bên trên để thêm vào danh sách in
                </span>
              </Empty>
            ),
          }}
        />
      </Card>

      {warnings.length > 0 ? (
        <Alert
          className="count-banner"
          style={{ marginTop: 14 }}
          type="warning"
          showIcon
          title="Có mặt hàng cần lưu ý trước khi dán tem"
          description={
            <ul className="label-warnings">
              {warnings.map((warning) => (
                <li key={`${warning.productName}-${warning.message}`}>
                  <b>{warning.productName}</b>: {warning.message}
                </li>
              ))}
            </ul>
          }
        />
      ) : null}

      {preview ? (
        <Card title={`Xem trước · ${activeSize?.label ?? size}`} style={{ marginTop: 14 }}>
          <iframe title="Xem trước tem" className="label-preview" srcDoc={preview} />
        </Card>
      ) : null}
    </div>
  );
}
