import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Descriptions,
  Drawer,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { useAuth } from "../auth/AuthProvider.js";
import {
  formatVnd,
  type Envelope,
  type GoodsReceiptDetail,
  type GoodsReceiptLine,
  type GoodsReceiptListItem,
  type Paged,
  type ProductDetail,
  type ProductListItem,
  type ProductUnit,
  type SupplierListItem,
} from "../../api/types.js";

const STATUS: Record<GoodsReceiptDetail["status"], { text: string; color: string }> = {
  DRAFT: { text: "Nháp", color: "default" },
  CONFIRMED: { text: "Đã kiểm nhập", color: "green" },
  CANCELLED: { text: "Đã hủy", color: "red" },
};

type DraftLine = {
  key: string;
  productId: string;
  productCode: string;
  productName: string;
  unitId: string;
  units: ProductUnit[];
  quantity: number;
  unitCost: number;
  batchNumber: string;
  manufactureDate: string;
  expiryDate: string;
};

/** Danh sách phiếu nhập của cửa hàng đang chọn. */
export function GoodsReceiptsPage() {
  const { can } = useAuth();
  const canCreate = can("goods_receipt.create");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<GoodsReceiptDetail["status"]>();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ["goods-receipts", page, status],
    queryFn: async () => {
      const response = await http.get<Envelope<Paged<GoodsReceiptListItem>>>("/goods-receipts", {
        params: { page, limit: 20, status },
      });
      return response.data.data;
    },
  });

  async function refreshList(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["goods-receipts"] });
  }

  return (
    <Card
      title="Phiếu nhập kho"
      extra={
        <Space>
          <Select
            allowClear
            placeholder="Trạng thái"
            style={{ width: 150 }}
            value={status}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            options={Object.entries(STATUS).map(([value, item]) => ({ value, label: item.text }))}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={!canCreate}
            onClick={() => setCreating(true)}
          >
            Tạo phiếu nhập
          </Button>
        </Space>
      }
    >
      <Table
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
        pagination={{
          current: page,
          pageSize: list.data?.pagination.limit ?? 20,
          total: list.data?.pagination.total ?? 0,
          onChange: setPage,
          showSizeChanger: false,
        }}
        columns={[
          { title: "Số phiếu", dataIndex: "code", width: 200 },
          {
            title: "Ngày nhập",
            width: 130,
            render: (_, row: GoodsReceiptListItem) => formatDate(row.receivedAt),
          },
          {
            title: "Nhà cung cấp",
            render: (_, row: GoodsReceiptListItem) => row.supplierName ?? "—",
          },
          { title: "Số dòng", dataIndex: "lineCount", width: 90, align: "right" },
          {
            title: "Giá trị",
            width: 140,
            align: "right",
            render: (_, row: GoodsReceiptListItem) => (
              <Typography.Text strong>{formatVnd(row.totalCost)}</Typography.Text>
            ),
          },
          {
            title: "Trạng thái",
            width: 140,
            render: (_, row: GoodsReceiptListItem) => <StatusTag status={row.status} />,
          },
        ]}
      />

      <ReceiptDrawer receiptId={openId} onClose={() => setOpenId(null)} onChanged={refreshList} />
      <ReceiptFormModal
        open={creating}
        receipt={null}
        onClose={() => setCreating(false)}
        onSaved={async (id) => {
          setCreating(false);
          await refreshList();
          setOpenId(id);
        }}
      />
    </Card>
  );
}

function ReceiptDrawer({
  receiptId,
  onClose,
  onChanged,
}: {
  receiptId: string | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const keys = useRef<Record<string, string>>({});
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ["goods-receipt", receiptId],
    enabled: receiptId !== null,
    queryFn: async () => {
      const response = await http.get<Envelope<GoodsReceiptDetail>>(`/goods-receipts/${receiptId}`);
      return response.data.data;
    },
  });

  function keyFor(action: string): string {
    const key = `${receiptId}:${action}`;
    keys.current[key] ??= crypto.randomUUID();
    return keys.current[key];
  }

  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["goods-receipt", receiptId] }),
      onChanged(),
    ]);
  }

  const cancel = useMutation({
    mutationFn: () =>
      http.post(
        `/goods-receipts/${receiptId}/cancel`,
        { reason: cancelReason },
        { headers: { "Idempotency-Key": keyFor("cancel") } },
      ),
    onSuccess: async () => {
      void message.success("Đã hủy phiếu nhập");
      setCancelling(false);
      setCancelReason("");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không hủy được phiếu nhập")),
  });

  const receipt = detail.data;
  const isDraft = receipt?.status === "DRAFT";

  return (
    <>
      <Drawer
        width={850}
        open={receiptId !== null}
        onClose={onClose}
        title={receipt?.code ?? "Chi tiết phiếu nhập"}
        extra={
          isDraft ? (
            <Space>
              <Button
                danger
                disabled={!can("goods_receipt.confirm")}
                onClick={() => setCancelling(true)}
              >
                Hủy phiếu
              </Button>
              <Button disabled={!can("goods_receipt.create")} onClick={() => setEditing(true)}>
                Sửa
              </Button>
              <Button
                type="primary"
                disabled={!can("goods_receipt.confirm")}
                onClick={() => setInspecting(true)}
              >
                Kiểm nhập &amp; xác nhận
              </Button>
            </Space>
          ) : null
        }
      >
        {receipt ? <ReceiptDetail receipt={receipt} /> : null}
      </Drawer>

      {receipt ? (
        <ReceiptFormModal
          open={editing}
          receipt={receipt}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await refresh();
          }}
        />
      ) : null}
      {receipt ? (
        <InspectionModal
          open={inspecting}
          receipt={receipt}
          getIdempotencyKey={() => keyFor("confirm")}
          onClose={() => setInspecting(false)}
          onConfirmed={async () => {
            setInspecting(false);
            await refresh();
          }}
        />
      ) : null}

      <Modal
        open={cancelling}
        title="Hủy phiếu nhập"
        okText="Hủy phiếu"
        onOk={() => cancel.mutate()}
        onCancel={() => setCancelling(false)}
        confirmLoading={cancel.isPending}
        okButtonProps={{ danger: true, disabled: cancelReason.trim().length === 0 }}
      >
        <Input.TextArea
          rows={3}
          placeholder="Lý do hủy phiếu (bắt buộc)"
          value={cancelReason}
          onChange={(event) => setCancelReason(event.target.value)}
        />
      </Modal>
    </>
  );
}

type InspectionResult = { passed: boolean; rejectReason: string };

/**
 * Kiểm nhập cảm quan trước khi xác nhận (thực hành GPP): mỗi dòng phải được
 * đánh dấu đạt/không đạt. Mặc định "Đạt" cho đỡ mất công ở trường hợp phổ
 * biến — hàng không có vấn đề gì; dòng không đạt bắt buộc ghi lý do và sẽ
 * vào lô biệt trữ ngay, không có lúc nào ở trạng thái bán được.
 */
function InspectionModal({
  open,
  receipt,
  getIdempotencyKey,
  onClose,
  onConfirmed,
}: {
  open: boolean;
  receipt: GoodsReceiptDetail;
  getIdempotencyKey: () => string;
  onClose: () => void;
  onConfirmed: () => Promise<void>;
}) {
  const [results, setResults] = useState<Record<string, InspectionResult>>({});

  useEffect(() => {
    if (!open) return;
    setResults(
      Object.fromEntries(
        receipt.lines.map((line) => [line.id, { passed: true, rejectReason: "" }]),
      ),
    );
  }, [open, receipt.lines]);

  const confirm = useMutation({
    mutationFn: () =>
      http.post(
        `/goods-receipts/${receipt.id}/confirm`,
        {
          lines: receipt.lines.map((line) => ({
            lineId: line.id,
            passed: results[line.id]?.passed ?? true,
            rejectReason: results[line.id]?.passed ? null : results[line.id]?.rejectReason,
          })),
        },
        { headers: { "Idempotency-Key": getIdempotencyKey() } },
      ),
    onSuccess: async () => {
      void message.success("Đã xác nhận kiểm nhập và cập nhật tồn kho");
      await onConfirmed();
    },
    onError: (error) =>
      void message.error(getErrorMessage(error, "Không xác nhận được phiếu nhập")),
  });

  const hasFailedWithoutReason = receipt.lines.some((line) => {
    const result = results[line.id];
    return result && !result.passed && result.rejectReason.trim().length === 0;
  });

  return (
    <Modal
      open={open}
      width={720}
      title="Kiểm nhập cảm quan trước khi nhập kho"
      okText="Xác nhận nhập kho"
      onCancel={onClose}
      onOk={() => confirm.mutate()}
      confirmLoading={confirm.isPending}
      okButtonProps={{ disabled: hasFailedWithoutReason }}
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="Kiểm tra hạn dùng, bao bì và chất lượng cảm quan từng dòng trước khi cho vào kho bán. Dòng đánh dấu Không đạt sẽ vào lô biệt trữ ngay, không bán được cho tới khi mở biệt trữ."
      />
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {receipt.lines.map((line) => {
          const result = results[line.id] ?? { passed: true, rejectReason: "" };
          return (
            <div
              key={line.id}
              style={{ border: "1px solid #f0f0f0", borderRadius: 6, padding: 12 }}
            >
              <Space style={{ width: "100%", justifyContent: "space-between" }}>
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>{line.productName}</Typography.Text>
                  <Typography.Text type="secondary">
                    Lô {line.batchNumber} · HSD {formatDate(line.expiryDate)} · {line.quantity}{" "}
                    {line.unitName}
                  </Typography.Text>
                </Space>
                <Select
                  value={result.passed}
                  style={{ width: 140 }}
                  onChange={(passed) =>
                    setResults((current) => ({ ...current, [line.id]: { ...result, passed } }))
                  }
                  options={[
                    { value: true, label: "Đạt" },
                    { value: false, label: "Không đạt" },
                  ]}
                />
              </Space>
              {!result.passed ? (
                <Input.TextArea
                  rows={2}
                  style={{ marginTop: 8 }}
                  placeholder="Lý do không đạt (bắt buộc)"
                  value={result.rejectReason}
                  onChange={(event) =>
                    setResults((current) => ({
                      ...current,
                      [line.id]: { ...result, rejectReason: event.target.value },
                    }))
                  }
                />
              ) : null}
            </div>
          );
        })}
      </Space>
    </Modal>
  );
}

function ReceiptDetail({ receipt }: { receipt: GoodsReceiptDetail }) {
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      {receipt.status === "DRAFT" ? (
        <Alert type="info" showIcon message="Phiếu nháp chưa làm thay đổi tồn kho." />
      ) : null}
      {receipt.status === "CONFIRMED" ? (
        <Alert
          type="success"
          showIcon
          message="Phiếu đã xác nhận; tồn kho và thẻ kho đã được cập nhật."
        />
      ) : null}
      {receipt.status === "CANCELLED" ? (
        <Alert type="error" showIcon message={`Đã hủy: ${receipt.cancelReason ?? "—"}`} />
      ) : null}
      <Descriptions
        size="small"
        column={2}
        items={[
          { key: "status", label: "Trạng thái", children: <StatusTag status={receipt.status} /> },
          { key: "supplier", label: "Nhà cung cấp", children: receipt.supplier?.name ?? "—" },
          {
            key: "invoice",
            label: "Số hóa đơn NCC",
            children: receipt.supplierInvoiceNumber ?? "—",
          },
          { key: "date", label: "Ngày nhận", children: formatDate(receipt.receivedAt) },
          { key: "note", label: "Ghi chú", children: receipt.note ?? "—", span: 2 },
          {
            key: "total",
            label: "Tổng giá trị",
            children: <strong>{formatVnd(receipt.totalCost)}</strong>,
          },
        ]}
      />
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={receipt.lines}
        columns={detailColumns}
      />
    </Space>
  );
}

const detailColumns = [
  {
    title: "Sản phẩm",
    render: (_: unknown, line: GoodsReceiptLine) => (
      <Space direction="vertical" size={0}>
        <Typography.Text strong>{line.productName}</Typography.Text>
        <Typography.Text type="secondary">{line.productCode}</Typography.Text>
      </Space>
    ),
  },
  { title: "Lô", dataIndex: "batchNumber", width: 120 },
  {
    title: "HSD",
    width: 105,
    render: (_: unknown, line: GoodsReceiptLine) => formatDate(line.expiryDate),
  },
  {
    title: "Số lượng",
    width: 110,
    align: "right" as const,
    render: (_: unknown, line: GoodsReceiptLine) => `${line.quantity} ${line.unitName}`,
  },
  {
    title: "Giá nhập",
    width: 125,
    align: "right" as const,
    render: (_: unknown, line: GoodsReceiptLine) => formatVnd(line.unitCost),
  },
  {
    title: "Thành tiền",
    width: 125,
    align: "right" as const,
    render: (_: unknown, line: GoodsReceiptLine) => formatVnd(line.lineCost),
  },
];

function ReceiptFormModal({
  open,
  receipt,
  onClose,
  onSaved,
}: {
  open: boolean;
  receipt: GoodsReceiptDetail | null;
  onClose: () => void;
  onSaved: (id: string) => Promise<unknown> | unknown;
}) {
  const [supplierId, setSupplierId] = useState<string>();
  const [receivedAt, setReceivedAt] = useState(today());
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [supplierInvoiceDate, setSupplierInvoiceDate] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const createAttempt = useRef({ signature: "", key: "" });

  const suppliers = useQuery({
    queryKey: ["receipt-suppliers"],
    enabled: open,
    queryFn: async () => {
      const response = await http.get<Envelope<Paged<SupplierListItem>>>("/suppliers", {
        params: { page: 1, limit: 100 },
      });
      return response.data.data.items;
    },
  });
  const products = useQuery({
    queryKey: ["receipt-products", productSearch],
    enabled: open && productSearch.trim().length > 0,
    queryFn: async () => {
      const response = await http.get<Envelope<Paged<ProductListItem>>>("/products", {
        params: { search: productSearch, page: 1, limit: 15 },
      });
      return response.data.data.items;
    },
  });

  useEffect(() => {
    if (!open) return;
    setSupplierId(receipt?.supplier?.id);
    setReceivedAt(toDateInput(receipt?.receivedAt) || today());
    setSupplierInvoiceNumber(receipt?.supplierInvoiceNumber ?? "");
    setSupplierInvoiceDate(toDateInput(receipt?.supplierInvoiceDate));
    setNote(receipt?.note ?? "");
    setLines((receipt?.lines ?? []).map(toDraftLine));
    setProductSearch("");
  }, [open, receipt]);

  const total = useMemo(
    () => lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0),
    [lines],
  );

  async function addProduct(productId: string): Promise<void> {
    const response = await http.get<Envelope<ProductDetail>>(`/products/${productId}`);
    const product = response.data.data;
    const unit = product.units[0];
    if (!unit) {
      void message.error("Sản phẩm chưa có đơn vị tính");
      return;
    }
    setLines((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        productId: product.id,
        productCode: product.code,
        productName: product.name,
        unitId: unit.id,
        units: product.units,
        quantity: 1,
        unitCost: 0,
        batchNumber: "",
        manufactureDate: "",
        expiryDate: "",
      },
    ]);
    setProductSearch("");
  }
  function changeLine(key: string, patch: Partial<DraftLine>): void {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        supplierId,
        receivedAt,
        supplierInvoiceNumber: supplierInvoiceNumber || null,
        supplierInvoiceDate: supplierInvoiceDate || null,
        note: note || null,
        lines: lines.map((line) => ({
          productId: line.productId,
          unitId: line.unitId,
          quantity: line.quantity,
          unitCost: line.unitCost,
          batchNumber: line.batchNumber,
          manufactureDate: line.manufactureDate || null,
          expiryDate: line.expiryDate,
        })),
      };
      if (receipt) {
        const response = await http.patch<Envelope<GoodsReceiptDetail>>(
          `/goods-receipts/${receipt.id}`,
          { ...body, version: receipt.version },
        );
        return response.data.data.id;
      }
      const signature = JSON.stringify(body);
      if (createAttempt.current.signature !== signature)
        createAttempt.current = { signature, key: crypto.randomUUID() };
      const response = await http.post<Envelope<GoodsReceiptDetail>>("/goods-receipts", body, {
        headers: { "Idempotency-Key": createAttempt.current.key },
      });
      return response.data.data.id;
    },
    onSuccess: async (id) => {
      void message.success(receipt ? "Đã lưu phiếu nháp" : "Đã tạo phiếu nháp");
      await onSaved(id);
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được phiếu nhập")),
  });
  const canSave = Boolean(supplierId) && lines.length > 0 && lines.every(isCompleteLine);

  return (
    <Modal
      open={open}
      width={1120}
      title={receipt ? `Sửa ${receipt.code}` : "Tạo phiếu nhập"}
      okText="Lưu phiếu nháp"
      onOk={() => save.mutate()}
      onCancel={onClose}
      confirmLoading={save.isPending}
      okButtonProps={{ disabled: !canSave }}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          message="Lưu nháp chưa tăng tồn. Chỉ xác nhận kiểm nhập mới tạo/cộng lô và ghi thẻ kho."
        />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="Nhà cung cấp"
            value={supplierId}
            onChange={setSupplierId}
            options={(suppliers.data ?? []).map((supplier) => ({
              value: supplier.id,
              label: supplier.name,
            }))}
          />
          <Input
            placeholder="Số hóa đơn nhà cung cấp"
            value={supplierInvoiceNumber}
            onChange={(event) => setSupplierInvoiceNumber(event.target.value)}
          />
          <Input
            type="date"
            value={receivedAt}
            onChange={(event) => setReceivedAt(event.target.value)}
          />
          <Input
            type="date"
            value={supplierInvoiceDate}
            onChange={(event) => setSupplierInvoiceDate(event.target.value)}
          />
        </div>
        <Input.TextArea
          rows={2}
          placeholder="Ghi chú"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <AutoComplete
          value={productSearch}
          onChange={setProductSearch}
          onSelect={(id) => void addProduct(String(id))}
          options={(products.data ?? []).map((product) => ({
            value: product.id,
            label: `${product.code} — ${product.name}`,
          }))}
        >
          <Input.Search placeholder="Tìm sản phẩm để thêm dòng nhập" />
        </AutoComplete>
        <Table
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={lines}
          locale={{ emptyText: "Chưa có dòng hàng." }}
          columns={[
            {
              title: "Sản phẩm",
              width: 200,
              render: (_: unknown, line: DraftLine) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>{line.productName}</Typography.Text>
                  <Typography.Text type="secondary">{line.productCode}</Typography.Text>
                </Space>
              ),
            },
            {
              title: "Đơn vị / SL",
              width: 155,
              render: (_: unknown, line: DraftLine) => (
                <Space direction="vertical" size={4}>
                  <Select
                    value={line.unitId}
                    onChange={(unitId) => changeLine(line.key, { unitId })}
                    options={line.units.map((unit) => ({ value: unit.id, label: unit.name }))}
                  />
                  <InputNumber
                    min={1}
                    precision={0}
                    value={line.quantity}
                    onChange={(value) => changeLine(line.key, { quantity: value ?? 0 })}
                  />
                </Space>
              ),
            },
            {
              title: "Giá nhập",
              width: 120,
              render: (_: unknown, line: DraftLine) => (
                <InputNumber
                  min={0}
                  precision={0}
                  value={line.unitCost}
                  onChange={(value) => changeLine(line.key, { unitCost: value ?? 0 })}
                />
              ),
            },
            {
              title: "Số lô",
              width: 120,
              render: (_: unknown, line: DraftLine) => (
                <Input
                  value={line.batchNumber}
                  onChange={(event) => changeLine(line.key, { batchNumber: event.target.value })}
                />
              ),
            },
            {
              title: "NSX",
              width: 130,
              render: (_: unknown, line: DraftLine) => (
                <Input
                  type="date"
                  value={line.manufactureDate}
                  onChange={(event) =>
                    changeLine(line.key, { manufactureDate: event.target.value })
                  }
                />
              ),
            },
            {
              title: "HSD",
              width: 130,
              render: (_: unknown, line: DraftLine) => (
                <Input
                  type="date"
                  value={line.expiryDate}
                  onChange={(event) => changeLine(line.key, { expiryDate: event.target.value })}
                />
              ),
            },
            {
              title: "Thành tiền",
              width: 120,
              align: "right" as const,
              render: (_: unknown, line: DraftLine) => formatVnd(line.quantity * line.unitCost),
            },
            {
              title: "",
              width: 45,
              render: (_: unknown, line: DraftLine) => (
                <Button
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() =>
                    setLines((current) => current.filter((item) => item.key !== line.key))
                  }
                />
              ),
            },
          ]}
        />
        <Typography.Text strong>Tổng giá trị: {formatVnd(total)}</Typography.Text>
      </Space>
    </Modal>
  );
}

function toDraftLine(line: GoodsReceiptLine): DraftLine {
  return {
    key: line.id,
    productId: line.productId,
    productCode: line.productCode,
    productName: line.productName,
    unitId: line.unitId,
    units: [{ id: line.unitId, name: line.unitName, conversionToBase: line.conversionToBase }],
    quantity: line.quantity,
    unitCost: line.unitCost,
    batchNumber: line.batchNumber,
    manufactureDate: toDateInput(line.manufactureDate),
    expiryDate: toDateInput(line.expiryDate),
  };
}
function isCompleteLine(line: DraftLine): boolean {
  return (
    line.quantity > 0 &&
    line.unitCost >= 0 &&
    line.batchNumber.trim().length > 0 &&
    line.expiryDate.length > 0
  );
}
function today(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
}
function toDateInput(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}
function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("vi-VN");
}
function StatusTag({ status }: { status: GoodsReceiptDetail["status"] }) {
  const item = STATUS[status];
  return <Tag color={item.color}>{item.text}</Tag>;
}
