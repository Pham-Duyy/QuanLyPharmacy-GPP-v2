import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  FileDoneOutlined,
  FileSearchOutlined,
  InboxOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, AutoComplete, Button, Card, Empty, Input, InputNumber, Modal, Segmented, Select, Skeleton, Table, Tag, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
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
import { formatDate, formatNumber, vnDateKey, vnMonthStartKey } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { PanelEmpty } from "../../ui/PanelEmpty.js";
import { StatCard, StatGrid } from "../../ui/StatCard.js";
import { useAuth } from "../auth/AuthProvider.js";

const STATUS: Record<GoodsReceiptDetail["status"], { text: string; color: string }> = {
  DRAFT: { text: "Nháp", color: "default" },
  CONFIRMED: { text: "Đã kiểm nhập", color: "green" },
  CANCELLED: { text: "Đã hủy", color: "red" },
};

type StatusFilter = GoodsReceiptDetail["status"] | "ALL";

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

/** Đếm phiếu theo điều kiện bằng tổng phân trang — chính xác cho mọi trang, không chỉ trang đang xem. */
function useReceiptCount(key: string, params: Record<string, string>) {
  return useQuery({
    queryKey: ["goods-receipts", "count", key],
    queryFn: async () =>
      (await http.get<Envelope<Paged<GoodsReceiptListItem>>>("/goods-receipts", { params: { ...params, page: 1, limit: 1 } })).data.data.pagination.total,
  });
}

/** Danh sách phiếu nhập của cửa hàng đang chọn. */
export function GoodsReceiptsPage() {
  const { can } = useAuth();
  const canCreate = can("goods_receipt.create");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ["goods-receipts", page, status],
    queryFn: async () => {
      const response = await http.get<Envelope<Paged<GoodsReceiptListItem>>>("/goods-receipts", {
        params: { page, limit: 20, status: status === "ALL" ? undefined : status },
      });
      return response.data.data;
    },
    placeholderData: (previous) => previous,
  });
  const drafts = useReceiptCount("draft", { status: "DRAFT" });
  const confirmedThisMonth = useReceiptCount(`confirmed-${vnMonthStartKey()}`, { status: "CONFIRMED", from: vnMonthStartKey() });
  const all = useReceiptCount("all", {});

  async function refreshList(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["goods-receipts"] });
  }

  return (
    <div>
      <PageHeader
        icon={<InboxOutlined />}
        title="Nhập hàng"
        description="Lập phiếu nhập từ nhà cung cấp, kiểm nhập cảm quan từng dòng rồi mới cộng tồn kho."
        extra={
          canCreate ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              Tạo phiếu nhập
            </Button>
          ) : null
        }
      />

      <StatGrid>
        <StatCard tone="orange" icon={<ClockCircleOutlined />} label="Chờ kiểm nhập" value={formatNumber(drafts.data)} loading={drafts.isLoading} hint="Phiếu nháp chưa cộng tồn" />
        <StatCard tone="green" icon={<FileDoneOutlined />} label="Đã kiểm nhập tháng này" value={formatNumber(confirmedThisMonth.data)} loading={confirmedThisMonth.isLoading} hint="Tính từ ngày 1 theo ngày nhận hàng" />
        <StatCard tone="blue" icon={<InboxOutlined />} label="Tổng số phiếu" value={formatNumber(all.data)} loading={all.isLoading} hint="Mọi trạng thái" />
      </StatGrid>

      <div className="split-layout">
        <Card title="Phiếu nhập kho">
          <div className="toolbar">
            <Segmented
              value={status}
              onChange={(value) => {
                setStatus(value as StatusFilter);
                setPage(1);
              }}
              options={[
                { value: "ALL", label: "Tất cả" },
                { value: "DRAFT", label: "Nháp" },
                { value: "CONFIRMED", label: "Đã kiểm nhập" },
                { value: "CANCELLED", label: "Đã hủy" },
              ]}
            />
          </div>
          <Table
            rowKey="id"
            loading={list.isFetching}
            dataSource={list.data?.items ?? []}
            scroll={{ x: 680 }}
            onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
            rowClassName={(row) => (row.id === openId ? "row-selected" : "")}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có phiếu nhập nào" /> }}
            pagination={{
              current: page,
              pageSize: list.data?.pagination.limit ?? 20,
              total: list.data?.pagination.total ?? 0,
              onChange: setPage,
              showSizeChanger: false,
              showTotal: (total) => `${total} phiếu`,
            }}
            columns={[
              {
                title: "Số phiếu",
                key: "code",
                render: (_: unknown, row: GoodsReceiptListItem) => (
                  <div className="cell-main">
                    <strong className="mono">{row.code}</strong>
                    <span>{formatDate(row.receivedAt)} · {row.lineCount} dòng</span>
                  </div>
                ),
              },
              { title: "Nhà cung cấp", key: "supplier", ellipsis: true, render: (_: unknown, row: GoodsReceiptListItem) => row.supplierName ?? "—" },
              { title: "Giá trị", key: "total", width: 130, align: "right", render: (_: unknown, row: GoodsReceiptListItem) => <Typography.Text strong>{formatVnd(row.totalCost)}</Typography.Text> },
              { title: "Trạng thái", key: "status", width: 130, render: (_: unknown, row: GoodsReceiptListItem) => <StatusTag status={row.status} /> },
            ]}
          />
        </Card>

        <aside className="split-aside">
          <ReceiptDetailPanel receiptId={openId} onChanged={refreshList} />
        </aside>
      </div>

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
    </div>
  );
}

function ReceiptDetailPanel({ receiptId, onChanged }: { receiptId: string | null; onChanged: () => Promise<void> }) {
  const { can } = useAuth();
  const { message } = App.useApp();
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
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["goods-receipt", receiptId] }), onChanged()]);
  }

  const cancel = useMutation({
    mutationFn: () => http.post(`/goods-receipts/${receiptId}/cancel`, { reason: cancelReason }, { headers: { "Idempotency-Key": keyFor("cancel") } }),
    onSuccess: async () => {
      void message.success("Đã hủy phiếu nhập");
      setCancelling(false);
      setCancelReason("");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không hủy được phiếu nhập")),
  });

  const receipt = detail.data;

  if (receiptId === null) {
    return (
      <Card title="Chi tiết phiếu nhập">
        <PanelEmpty icon={<FileSearchOutlined />} title="Chưa chọn phiếu nhập" description="Bấm vào một dòng trong danh sách để xem chi tiết và kiểm nhập." />
      </Card>
    );
  }

  return (
    <>
      <Card title={receipt ? <span className="mono">{receipt.code}</span> : "Chi tiết phiếu nhập"} extra={receipt ? <StatusTag status={receipt.status} /> : null}>
        {detail.isLoading || !receipt ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : (
          <div className="detail-stack">
            {receipt.status === "DRAFT" ? <Alert type="info" showIcon title="Phiếu nháp chưa làm thay đổi tồn kho." /> : null}
            {receipt.status === "CONFIRMED" ? <Alert type="success" showIcon title="Đã kiểm nhập: tồn kho và thẻ kho đã cập nhật." /> : null}
            {receipt.status === "CANCELLED" ? <Alert type="error" showIcon title={`Đã hủy: ${receipt.cancelReason ?? "—"}`} /> : null}

            <dl className="kv-list">
              <div>
                <dt>Nhà cung cấp</dt>
                <dd>{receipt.supplier?.name ?? "—"}</dd>
              </div>
              <div>
                <dt>Số hóa đơn NCC</dt>
                <dd>{receipt.supplierInvoiceNumber ?? "—"}</dd>
              </div>
              <div>
                <dt>Ngày nhận hàng</dt>
                <dd>{formatDate(receipt.receivedAt)}</dd>
              </div>
              {receipt.note ? (
                <div>
                  <dt>Ghi chú</dt>
                  <dd>{receipt.note}</dd>
                </div>
              ) : null}
            </dl>

            <div className="line-list">
              <div className="line-list-head">
                <span>{receipt.lines.length} dòng hàng</span>
                <strong>{formatVnd(receipt.totalCost)}</strong>
              </div>
              {receipt.lines.map((line) => (
                <div className="line-item" key={line.id}>
                  <div className="line-item-main">
                    <strong>{line.productName}</strong>
                    <span>
                      Lô <span className="mono">{line.batchNumber}</span> · HSD {formatDate(line.expiryDate)}
                    </span>
                  </div>
                  <div className="line-item-side">
                    <strong>{formatVnd(line.lineCost)}</strong>
                    <span>
                      {formatNumber(line.quantity)} {line.unitName} × {formatVnd(line.unitCost)}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {receipt.status === "DRAFT" ? (
              <div className="panel-actions">
                <Button type="primary" block icon={<SafetyCertificateOutlined />} disabled={!can("goods_receipt.confirm")} onClick={() => setInspecting(true)}>
                  Kiểm nhập &amp; xác nhận
                </Button>
                <div className="panel-actions-row">
                  <Button icon={<EditOutlined />} disabled={!can("goods_receipt.create")} onClick={() => setEditing(true)}>
                    Sửa phiếu
                  </Button>
                  <Button danger icon={<CloseCircleOutlined />} disabled={!can("goods_receipt.confirm")} onClick={() => setCancelling(true)}>
                    Hủy phiếu
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </Card>

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
        cancelText="Đóng"
        onOk={() => cancel.mutate()}
        onCancel={() => setCancelling(false)}
        confirmLoading={cancel.isPending}
        okButtonProps={{ danger: true, disabled: cancelReason.trim().length === 0 }}
      >
        <Input.TextArea rows={3} placeholder="Lý do hủy phiếu (bắt buộc)" value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} />
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
  const { message } = App.useApp();
  const [results, setResults] = useState<Record<string, InspectionResult>>({});

  useEffect(() => {
    if (!open) return;
    setResults(Object.fromEntries(receipt.lines.map((line) => [line.id, { passed: true, rejectReason: "" }])));
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
    onError: (error) => void message.error(getErrorMessage(error, "Không xác nhận được phiếu nhập")),
  });

  const hasFailedWithoutReason = receipt.lines.some((line) => {
    const result = results[line.id];
    return result && !result.passed && result.rejectReason.trim().length === 0;
  });
  const failedCount = receipt.lines.filter((line) => results[line.id] && !results[line.id]!.passed).length;

  return (
    <Modal
      open={open}
      width={720}
      title="Kiểm nhập cảm quan trước khi nhập kho"
      okText={failedCount > 0 ? `Xác nhận (${failedCount} dòng biệt trữ)` : "Xác nhận nhập kho"}
      cancelText="Đóng"
      onCancel={onClose}
      onOk={() => confirm.mutate()}
      confirmLoading={confirm.isPending}
      okButtonProps={{ disabled: hasFailedWithoutReason }}
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        title="Kiểm tra hạn dùng, bao bì và chất lượng cảm quan từng dòng trước khi cho vào kho bán. Dòng Không đạt sẽ vào lô biệt trữ ngay, không bán được cho tới khi mở biệt trữ."
      />
      <div className="inspect-list">
        {receipt.lines.map((line) => {
          const result = results[line.id] ?? { passed: true, rejectReason: "" };
          return (
            <div key={line.id} className={result.passed ? "inspect-item" : "inspect-item failed"}>
              <div className="inspect-item-head">
                <div className="cell-main">
                  <strong>{line.productName}</strong>
                  <span>
                    Lô {line.batchNumber} · HSD {formatDate(line.expiryDate)} · {formatNumber(line.quantity)} {line.unitName}
                  </span>
                </div>
                <Segmented
                  value={result.passed ? "pass" : "fail"}
                  onChange={(value) => setResults((current) => ({ ...current, [line.id]: { ...result, passed: value === "pass" } }))}
                  options={[
                    { value: "pass", label: <span className="text-success"><CheckCircleOutlined /> Đạt</span> },
                    { value: "fail", label: <span className="text-danger"><CloseCircleOutlined /> Không đạt</span> },
                  ]}
                />
              </div>
              {!result.passed ? (
                <Input.TextArea
                  rows={2}
                  placeholder="Lý do không đạt (bắt buộc), ví dụ: bao bì móp, ẩm mốc, sai số lô…"
                  value={result.rejectReason}
                  status={result.rejectReason.trim() ? undefined : "error"}
                  onChange={(event) => setResults((current) => ({ ...current, [line.id]: { ...result, rejectReason: event.target.value } }))}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

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
  const { message } = App.useApp();
  const [supplierId, setSupplierId] = useState<string>();
  const [receivedAt, setReceivedAt] = useState(vnDateKey());
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
      const response = await http.get<Envelope<Paged<SupplierListItem>>>("/suppliers", { params: { page: 1, limit: 100 } });
      return response.data.data.items;
    },
  });
  const products = useQuery({
    queryKey: ["receipt-products", productSearch],
    enabled: open && productSearch.trim().length > 0,
    queryFn: async () => {
      const response = await http.get<Envelope<Paged<ProductListItem>>>("/products", { params: { search: productSearch, page: 1, limit: 15 } });
      return response.data.data.items;
    },
  });

  useEffect(() => {
    if (!open) return;
    setSupplierId(receipt?.supplier?.id);
    setReceivedAt(toDateInput(receipt?.receivedAt) || vnDateKey());
    setSupplierInvoiceNumber(receipt?.supplierInvoiceNumber ?? "");
    setSupplierInvoiceDate(toDateInput(receipt?.supplierInvoiceDate));
    setNote(receipt?.note ?? "");
    setLines((receipt?.lines ?? []).map(toDraftLine));
    setProductSearch("");
  }, [open, receipt]);

  const total = useMemo(() => lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0), [lines]);

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
        const response = await http.patch<Envelope<GoodsReceiptDetail>>(`/goods-receipts/${receipt.id}`, { ...body, version: receipt.version });
        return response.data.data.id;
      }
      const signature = JSON.stringify(body);
      if (createAttempt.current.signature !== signature) createAttempt.current = { signature, key: crypto.randomUUID() };
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
  const incomplete = lines.filter((line) => !isCompleteLine(line)).length;
  const canSave = Boolean(supplierId) && lines.length > 0 && incomplete === 0;

  return (
    <Modal
      open={open}
      width={1120}
      title={receipt ? `Sửa phiếu ${receipt.code}` : "Tạo phiếu nhập"}
      okText="Lưu phiếu nháp"
      cancelText="Đóng"
      onOk={() => save.mutate()}
      onCancel={onClose}
      confirmLoading={save.isPending}
      okButtonProps={{ disabled: !canSave }}
    >
      <div className="detail-stack">
        <Alert type="info" showIcon title="Lưu nháp chưa tăng tồn. Chỉ khi kiểm nhập và xác nhận mới tạo/cộng lô và ghi thẻ kho." />
        <div className="form-grid">
          <label className="field">
            <span>Nhà cung cấp *</span>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="Chọn nhà cung cấp"
              value={supplierId}
              onChange={setSupplierId}
              options={(suppliers.data ?? []).map((supplier) => ({ value: supplier.id, label: supplier.name }))}
            />
          </label>
          <label className="field">
            <span>Ngày nhận hàng *</span>
            <Input type="date" value={receivedAt} onChange={(event) => setReceivedAt(event.target.value)} />
          </label>
          <label className="field">
            <span>Số hóa đơn nhà cung cấp</span>
            <Input placeholder="Ví dụ: 0001234" value={supplierInvoiceNumber} onChange={(event) => setSupplierInvoiceNumber(event.target.value)} />
          </label>
          <label className="field">
            <span>Ngày hóa đơn nhà cung cấp</span>
            <Input type="date" value={supplierInvoiceDate} onChange={(event) => setSupplierInvoiceDate(event.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Ghi chú</span>
          <Input.TextArea rows={2} placeholder="Không bắt buộc" value={note} onChange={(event) => setNote(event.target.value)} />
        </label>

        <div className="field">
          <span>Dòng hàng</span>
          <AutoComplete
            value={productSearch}
            onChange={setProductSearch}
            onSelect={(id) => void addProduct(String(id))}
            options={(products.data ?? []).map((product) => ({ value: product.id, label: `${product.code} — ${product.name}` }))}
          >
            <Input prefix={<PlusOutlined />} placeholder="Gõ tên hoặc mã sản phẩm để thêm dòng nhập" />
          </AutoComplete>
        </div>
        <Table
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={lines}
          scroll={{ x: 1040 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có dòng hàng — tìm sản phẩm ở ô phía trên" /> }}
          columns={[
            {
              title: "Sản phẩm",
              width: 210,
              render: (_: unknown, line: DraftLine) => (
                <div className="cell-main">
                  <strong>{line.productName}</strong>
                  <span>{line.productCode}</span>
                </div>
              ),
            },
            {
              title: "Đơn vị",
              width: 110,
              render: (_: unknown, line: DraftLine) => (
                <Select style={{ width: "100%" }} value={line.unitId} onChange={(unitId) => changeLine(line.key, { unitId })} options={line.units.map((unit) => ({ value: unit.id, label: unit.name }))} />
              ),
            },
            {
              title: "Số lượng",
              width: 100,
              render: (_: unknown, line: DraftLine) => <InputNumber style={{ width: "100%" }} min={1} precision={0} value={line.quantity} onChange={(value) => changeLine(line.key, { quantity: value ?? 0 })} />,
            },
            {
              title: "Giá nhập",
              width: 120,
              render: (_: unknown, line: DraftLine) => <InputNumber style={{ width: "100%" }} min={0} precision={0} value={line.unitCost} onChange={(value) => changeLine(line.key, { unitCost: value ?? 0 })} />,
            },
            {
              title: "Số lô *",
              width: 120,
              render: (_: unknown, line: DraftLine) => (
                <Input value={line.batchNumber} status={line.batchNumber.trim() ? undefined : "warning"} onChange={(event) => changeLine(line.key, { batchNumber: event.target.value })} />
              ),
            },
            {
              title: "NSX",
              width: 136,
              render: (_: unknown, line: DraftLine) => <Input type="date" value={line.manufactureDate} onChange={(event) => changeLine(line.key, { manufactureDate: event.target.value })} />,
            },
            {
              title: "HSD *",
              width: 136,
              render: (_: unknown, line: DraftLine) => (
                <Input type="date" value={line.expiryDate} status={line.expiryDate ? undefined : "warning"} onChange={(event) => changeLine(line.key, { expiryDate: event.target.value })} />
              ),
            },
            { title: "Thành tiền", width: 120, align: "right" as const, render: (_: unknown, line: DraftLine) => <strong>{formatVnd(line.quantity * line.unitCost)}</strong> },
            {
              title: "",
              width: 48,
              render: (_: unknown, line: DraftLine) => (
                <Button type="text" danger icon={<DeleteOutlined />} aria-label="Xóa dòng" onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))} />
              ),
            },
          ]}
        />
        <div className="form-summary">
          <span>{incomplete > 0 ? <Typography.Text type="warning">{incomplete} dòng còn thiếu số lô hoặc hạn dùng</Typography.Text> : `${lines.length} dòng hàng`}</span>
          <span>
            Tổng giá trị <strong>{formatVnd(total)}</strong>
          </span>
        </div>
      </div>
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
  return line.quantity > 0 && line.unitCost >= 0 && line.batchNumber.trim().length > 0 && line.expiryDate.length > 0;
}
function toDateInput(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}
function StatusTag({ status }: { status: GoodsReceiptDetail["status"] }) {
  const item = STATUS[status];
  return <Tag color={item.color}>{item.text}</Tag>;
}
