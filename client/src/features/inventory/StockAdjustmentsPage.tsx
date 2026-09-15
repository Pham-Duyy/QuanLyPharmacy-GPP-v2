import { CheckOutlined, CloseOutlined, DeleteOutlined, FileSearchOutlined, PlusOutlined, StopOutlined, SwapOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, AutoComplete, Button, Card, Empty, Input, InputNumber, Modal, Segmented, Select, Skeleton, Table, Tag } from "antd";
import { useEffect, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { type BatchListItem, type Envelope, type Paged, type ProductDetail, type ProductUnit, type StockAdjustmentDetail, type StockAdjustmentListItem } from "../../api/types.js";
import { formatDateTime, formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { PanelEmpty } from "../../ui/PanelEmpty.js";
import { useAuth } from "../auth/AuthProvider.js";

const STATUS: Record<StockAdjustmentListItem["status"], { text: string; color: string }> = {
  DRAFT: { text: "Chờ duyệt", color: "gold" },
  APPROVED: { text: "Đã duyệt", color: "green" },
  REJECTED: { text: "Đã từ chối", color: "red" },
  CANCELLED: { text: "Đã hủy", color: "default" },
};

const REASONS: Record<string, string> = {
  COUNT_DIFFERENCE: "Kiểm kê lệch",
  DAMAGED: "Hư hỏng",
  EXPIRED_DISPOSAL: "Hết hạn, xuất hủy",
  RECALL_DISPOSAL: "Thu hồi, xuất hủy",
  OTHER: "Khác",
};

function idemHeader(): Record<string, string> {
  return { "Idempotency-Key": crypto.randomUUID() };
}

/** Phiếu điều chỉnh tồn: nhân viên kho lập, dược sĩ/quản lý duyệt (contract §10.3). */
export function StockAdjustmentsPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState<StockAdjustmentListItem["status"] | "ALL">("ALL");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ["stock-adjustments", status],
    queryFn: async () => (await http.get<Envelope<StockAdjustmentListItem[]>>("/stock-adjustments", { params: { status: status === "ALL" ? undefined : status } })).data.data,
    placeholderData: (previous) => previous,
  });

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["stock-adjustments"] });
  }

  return (
    <div>
      <PageHeader
        icon={<SwapOutlined />}
        title="Điều chỉnh tồn"
        description="Lập phiếu chưa đụng tới tồn. Chỉ khi được duyệt (người duyệt khác người lập) mới áp dụng chênh lệch và ghi thẻ kho."
        extra={
          can("stock.adjust.create") ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              Lập phiếu điều chỉnh
            </Button>
          ) : null
        }
      />
      <div className="split-layout">
        <Card>
          <div className="toolbar">
            <Segmented
              value={status}
              onChange={(value) => setStatus(value as typeof status)}
              options={[{ value: "ALL", label: "Tất cả" }, ...Object.entries(STATUS).map(([value, info]) => ({ value, label: info.text }))]}
            />
          </div>
          <Table
            rowKey="id"
            loading={list.isFetching}
            dataSource={list.data ?? []}
            scroll={{ x: 620 }}
            onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
            rowClassName={(row) => (row.id === openId ? "row-selected" : "")}
            pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={list.isError ? getErrorMessage(list.error, "Không tải được danh sách") : "Chưa có phiếu điều chỉnh"} /> }}
            columns={[
              {
                title: "Phiếu",
                key: "code",
                render: (_: unknown, row: StockAdjustmentListItem) => (
                  <div className="cell-main">
                    <strong className="mono">{row.code}</strong>
                    <span>
                      {formatDateTime(row.createdAt)} · {row.createdByName}
                    </span>
                  </div>
                ),
              },
              { title: "Lý do", dataIndex: "reason", ellipsis: true, render: (value: string | null) => value ?? "—" },
              { title: "Số dòng", dataIndex: "lineCount", width: 90, align: "right" },
              { title: "Trạng thái", key: "status", width: 120, render: (_: unknown, row: StockAdjustmentListItem) => <Tag color={STATUS[row.status].color}>{STATUS[row.status].text}</Tag> },
            ]}
          />
        </Card>
        <aside className="split-aside">
          <AdjustmentPanel id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />
        </aside>
      </div>
      <CreateAdjustmentModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={async (id) => {
          setCreating(false);
          await refresh();
          setOpenId(id);
        }}
      />
    </div>
  );
}

function AdjustmentPanel({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ["stock-adjustment", id],
    enabled: id !== null,
    queryFn: async () => (await http.get<Envelope<StockAdjustmentDetail>>(`/stock-adjustments/${id}`)).data.data,
  });

  async function refresh(): Promise<void> {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["stock-adjustment", id] }), onChanged(), queryClient.invalidateQueries({ queryKey: ["inventory-batches"] })]);
  }

  const approve = useMutation({
    mutationFn: () => http.post(`/stock-adjustments/${id}/approve`, {}, { headers: idemHeader() }),
    onSuccess: async () => {
      void message.success("Đã duyệt phiếu, tồn kho đã được cập nhật");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không duyệt được phiếu")),
  });
  const reject = useMutation({
    mutationFn: () => http.post(`/stock-adjustments/${id}/reject`, { reason: rejectReason }, { headers: idemHeader() }),
    onSuccess: async () => {
      void message.success("Đã từ chối phiếu");
      setRejecting(false);
      setRejectReason("");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không từ chối được phiếu")),
  });
  const cancel = useMutation({
    mutationFn: () => http.post(`/stock-adjustments/${id}/cancel`, {}, { headers: idemHeader() }),
    onSuccess: async () => {
      void message.success("Đã hủy phiếu");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không hủy được phiếu")),
  });

  if (id === null) {
    return (
      <Card title="Chi tiết phiếu điều chỉnh">
        <PanelEmpty icon={<FileSearchOutlined />} title="Chưa chọn phiếu" description="Bấm vào một phiếu để xem chênh lệch từng lô và duyệt." />
      </Card>
    );
  }

  const adjustment = detail.data;
  const isDraft = adjustment?.status === "DRAFT";

  return (
    <>
      <Card
        title={adjustment ? <span className="mono">{adjustment.code}</span> : "Chi tiết phiếu điều chỉnh"}
        extra={
          <span className="row-actions">
            {adjustment ? <Tag color={STATUS[adjustment.status].color}>{STATUS[adjustment.status].text}</Tag> : null}
            <Button type="text" size="small" onClick={onClose}>
              Đóng
            </Button>
          </span>
        }
      >
        {detail.isLoading || !adjustment ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : (
          <div className="detail-stack">
            {isDraft ? <Alert type="info" showIcon title="Phiếu chưa làm thay đổi tồn kho cho tới khi được duyệt." /> : null}
            <dl className="kv-list">
              <div>
                <dt>Lý do chung</dt>
                <dd>{adjustment.reason ?? "—"}</dd>
              </div>
              <div>
                <dt>Người lập</dt>
                <dd>{adjustment.createdBy.fullName}</dd>
              </div>
              <div>
                <dt>Người duyệt</dt>
                <dd>{adjustment.approvedBy ? `${adjustment.approvedBy.fullName}${adjustment.approvedAt ? ` · ${formatDateTime(adjustment.approvedAt)}` : ""}` : "—"}</dd>
              </div>
              {adjustment.status === "REJECTED" ? (
                <div>
                  <dt>Lý do từ chối</dt>
                  <dd className="text-danger">{adjustment.rejectedReason ?? "—"}</dd>
                </div>
              ) : null}
            </dl>

            <div className="line-list">
              <div className="line-list-head">
                <span>{adjustment.lines.length} dòng</span>
                <span>Chênh lệch</span>
              </div>
              {adjustment.lines.map((line) => {
                const delta = line.deltaBaseQuantity;
                return (
                  <div className="line-item" key={line.id}>
                    <div className="line-item-main">
                      <strong>
                        Lô <span className="mono">{line.batchNumber}</span>
                      </strong>
                      <span>{REASONS[line.reasonCode] ?? line.reasonCode}</span>
                      <span>
                        {line.countedQuantity !== null
                          ? `Đếm thực tế ${formatNumber(line.countedQuantity)} ${line.unitName}${line.systemBaseQuantityAtCount !== null ? ` · hệ thống ${formatNumber(line.systemBaseQuantityAtCount)}` : ""}`
                          : `Xuất ${formatNumber(line.quantity)} ${line.unitName}`}
                      </span>
                    </div>
                    <div className="line-item-side">
                      <strong className={delta === null ? undefined : delta < 0 ? "text-danger" : "text-success"}>{delta === null ? "Tính khi duyệt" : delta > 0 ? `+${formatNumber(delta)}` : formatNumber(delta)}</strong>
                    </div>
                  </div>
                );
              })}
            </div>

            {isDraft ? (
              <div className="panel-actions">
                {can("stock.adjust.approve") ? (
                  <div className="panel-actions-row">
                    <Button type="primary" icon={<CheckOutlined />} loading={approve.isPending} onClick={() => approve.mutate()}>
                      Duyệt phiếu
                    </Button>
                    <Button icon={<CloseOutlined />} onClick={() => setRejecting(true)}>
                      Từ chối
                    </Button>
                  </div>
                ) : null}
                {can("stock.adjust.create") ? (
                  <Button danger block icon={<StopOutlined />} loading={cancel.isPending} onClick={() => cancel.mutate()}>
                    Hủy phiếu
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </Card>

      <Modal
        open={rejecting}
        title="Từ chối phiếu điều chỉnh"
        okText="Từ chối"
        cancelText="Đóng"
        onOk={() => reject.mutate()}
        onCancel={() => setRejecting(false)}
        confirmLoading={reject.isPending}
        okButtonProps={{ danger: true, disabled: rejectReason.trim().length === 0 }}
      >
        <Input.TextArea rows={3} placeholder="Lý do từ chối (bắt buộc)" value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} />
      </Modal>
    </>
  );
}

type DraftLine = {
  key: string;
  batchId: string;
  batchNumber: string;
  productName: string;
  units: ProductUnit[];
  unitId: string;
  reasonCode: string;
  countedQuantity?: number;
  quantity?: number;
};

function CreateAdjustmentModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const { message } = App.useApp();
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [batchSearch, setBatchSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    setReason("");
    setLines([]);
    setBatchSearch("");
  }, [open]);

  const batches = useQuery({
    queryKey: ["adjustment-batches", batchSearch],
    enabled: open && batchSearch.trim().length > 0,
    queryFn: async () => (await http.get<Envelope<Paged<BatchListItem>>>("/inventory/batches", { params: { search: batchSearch, status: "AVAILABLE", page: 1, limit: 15 } })).data.data.items,
  });

  async function addBatch(batchId: string): Promise<void> {
    const batch = (batches.data ?? []).find((item) => item.id === batchId);
    if (!batch) return;
    const product = (await http.get<Envelope<ProductDetail>>(`/products/${batch.productId}`)).data.data;
    setLines((current) => [
      ...current,
      { key: crypto.randomUUID(), batchId: batch.id, batchNumber: batch.batchNumber, productName: batch.productName, units: product.units, unitId: product.units[0]?.id ?? "", reasonCode: "COUNT_DIFFERENCE" },
    ]);
    setBatchSearch("");
  }
  function changeLine(key: string, patch: Partial<DraftLine>): void {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  const create = useMutation({
    mutationFn: async () => {
      const body = {
        reason: reason || null,
        lines: lines.map((line) => ({
          batchId: line.batchId,
          unitId: line.unitId,
          reasonCode: line.reasonCode,
          countedQuantity: line.reasonCode === "COUNT_DIFFERENCE" ? line.countedQuantity : undefined,
          quantity: line.reasonCode === "COUNT_DIFFERENCE" ? undefined : line.quantity,
        })),
      };
      const response = await http.post<Envelope<StockAdjustmentDetail>>("/stock-adjustments", body);
      return response.data.data.id;
    },
    onSuccess: async (id) => {
      void message.success("Đã lập phiếu điều chỉnh, chờ duyệt");
      await onCreated(id);
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lập được phiếu")),
  });

  const canSave =
    lines.length > 0 &&
    lines.every((line) => (line.unitId && line.reasonCode === "COUNT_DIFFERENCE" ? line.countedQuantity !== undefined && line.countedQuantity >= 0 : (line.quantity ?? 0) > 0));

  return (
    <Modal open={open} width={920} title="Lập phiếu điều chỉnh tồn" okText="Lưu phiếu" cancelText="Đóng" onOk={() => create.mutate()} onCancel={onClose} confirmLoading={create.isPending} okButtonProps={{ disabled: !canSave }}>
      <div className="detail-stack">
        <label className="field">
          <span>Lý do chung</span>
          <Input placeholder="Không bắt buộc, ví dụ: Kiểm kê định kỳ tháng 9" value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <div className="field">
          <span>Thêm lô cần điều chỉnh</span>
          <AutoComplete
            value={batchSearch}
            onChange={setBatchSearch}
            onSelect={(value) => void addBatch(String(value))}
            options={(batches.data ?? []).map((batch) => ({ value: batch.id, label: `${batch.batchNumber} — ${batch.productName} (còn ${batch.quantityOnHand} ${batch.baseUnitName})` }))}
          >
            <Input prefix={<PlusOutlined />} placeholder="Tìm lô theo tên/mã sản phẩm hoặc số lô" />
          </AutoComplete>
        </div>
        <Table
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={lines}
          scroll={{ x: 760 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có dòng nào — tìm lô ở ô phía trên" /> }}
          columns={[
            {
              title: "Lô / sản phẩm",
              key: "batch",
              width: 220,
              render: (_: unknown, line: DraftLine) => (
                <div className="cell-main">
                  <strong className="mono">{line.batchNumber}</strong>
                  <span>{line.productName}</span>
                </div>
              ),
            },
            { title: "Đơn vị", key: "unit", width: 120, render: (_: unknown, line: DraftLine) => <Select style={{ width: "100%" }} value={line.unitId} onChange={(unitId) => changeLine(line.key, { unitId })} options={line.units.map((unit) => ({ value: unit.id, label: unit.name }))} /> },
            { title: "Lý do", key: "reason", width: 180, render: (_: unknown, line: DraftLine) => <Select style={{ width: "100%" }} value={line.reasonCode} onChange={(reasonCode) => changeLine(line.key, { reasonCode })} options={Object.entries(REASONS).map(([value, label]) => ({ value, label }))} /> },
            {
              title: "Số lượng",
              key: "qty",
              width: 170,
              render: (_: unknown, line: DraftLine) =>
                line.reasonCode === "COUNT_DIFFERENCE" ? (
                  <InputNumber min={0} precision={0} placeholder="Số đếm thực tế" style={{ width: "100%" }} value={line.countedQuantity} onChange={(value) => changeLine(line.key, { countedQuantity: value ?? undefined })} />
                ) : (
                  <InputNumber min={1} precision={0} placeholder="Số lượng xuất hủy" style={{ width: "100%" }} value={line.quantity} onChange={(value) => changeLine(line.key, { quantity: value ?? undefined })} />
                ),
            },
            { title: "", key: "remove", width: 48, render: (_: unknown, line: DraftLine) => <Button type="text" danger icon={<DeleteOutlined />} aria-label="Xóa dòng" onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))} /> },
          ]}
        />
      </div>
    </Modal>
  );
}
