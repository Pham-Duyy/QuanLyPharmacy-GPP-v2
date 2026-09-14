import { PlusOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AutoComplete, Button, Card, Descriptions, Drawer, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import { useEffect, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { type BatchListItem, type Envelope, type Paged, type ProductDetail, type ProductUnit, type StockAdjustmentDetail, type StockAdjustmentListItem } from "../../api/types.js";
import { useAuth } from "../auth/AuthProvider.js";

const STATUS: Record<StockAdjustmentListItem["status"], { text: string; color: string }> = {
  DRAFT: { text: "Nháp", color: "default" },
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
function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("vi-VN");
}

/** Phiếu điều chỉnh tồn: nhân viên kho lập, dược sĩ/quản lý duyệt (contract §10.3). */
export function StockAdjustmentsPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState<string>();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ["stock-adjustments", status],
    queryFn: async () =>
      (await http.get<Envelope<StockAdjustmentListItem[]>>("/stock-adjustments", { params: { status } })).data
        .data,
  });

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["stock-adjustments"] });
  }

  return (
    <Card
      title="Điều chỉnh tồn kho"
      extra={
        <Space>
          <Select
            allowClear
            placeholder="Tất cả trạng thái"
            style={{ width: 170 }}
            value={status}
            onChange={setStatus}
            options={Object.entries(STATUS).map(([value, info]) => ({ value, label: info.text }))}
          />
          {can("stock.adjust.create") ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              Lập phiếu
            </Button>
          ) : null}
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        Lập phiếu chưa đụng tới tồn. Chỉ khi duyệt, hệ thống mới áp dụng chênh lệch vào tồn của lô và ghi thẻ
        kho. Người duyệt phải khác người lập.
      </Typography.Paragraph>
      <Table
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={list.data ?? []}
        onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
        pagination={false}
        locale={{ emptyText: list.isError ? getErrorMessage(list.error, "Không tải được danh sách") : "Chưa có phiếu" }}
        columns={[
          { title: "Số phiếu", dataIndex: "code", width: 190 },
          { title: "Lý do", dataIndex: "reason", render: (value) => value ?? "—" },
          { title: "Số dòng", dataIndex: "lineCount", width: 90, align: "right" },
          { title: "Người lập", dataIndex: "createdByName", width: 160 },
          { title: "Ngày lập", width: 150, render: (_, row: StockAdjustmentListItem) => formatDateTime(row.createdAt) },
          { title: "Trạng thái", width: 130, render: (_, row: StockAdjustmentListItem) => <Tag color={STATUS[row.status].color}>{STATUS[row.status].text}</Tag> },
        ]}
      />

      <AdjustmentDrawer id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />
      <CreateAdjustmentModal open={creating} onClose={() => setCreating(false)} onCreated={async (id) => { setCreating(false); await refresh(); setOpenId(id); }} />
    </Card>
  );
}

function AdjustmentDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const { can } = useAuth();
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ["stock-adjustment", id],
    enabled: id !== null,
    queryFn: async () => (await http.get<Envelope<StockAdjustmentDetail>>(`/stock-adjustments/${id}`)).data.data,
  });

  async function refresh(): Promise<void> {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["stock-adjustment", id] }), onChanged()]);
  }

  const approve = useMutation({
    mutationFn: () => http.post(`/stock-adjustments/${id}/approve`, {}, { headers: idemHeader() }),
    onSuccess: async () => { void message.success("Đã duyệt phiếu điều chỉnh"); await refresh(); },
    onError: (error) => void message.error(getErrorMessage(error, "Không duyệt được phiếu")),
  });
  const reject = useMutation({
    mutationFn: () => http.post(`/stock-adjustments/${id}/reject`, { reason: rejectReason }, { headers: idemHeader() }),
    onSuccess: async () => { void message.success("Đã từ chối phiếu"); setRejecting(false); setRejectReason(""); await refresh(); },
    onError: (error) => void message.error(getErrorMessage(error, "Không từ chối được phiếu")),
  });
  const cancel = useMutation({
    mutationFn: () => http.post(`/stock-adjustments/${id}/cancel`, {}, { headers: idemHeader() }),
    onSuccess: async () => { void message.success("Đã hủy phiếu"); await refresh(); },
    onError: (error) => void message.error(getErrorMessage(error, "Không hủy được phiếu")),
  });

  const adjustment = detail.data;
  const isDraft = adjustment?.status === "DRAFT";

  return (
    <>
      <Drawer
        width={760}
        open={id !== null}
        onClose={onClose}
        title={adjustment?.code ?? "Chi tiết phiếu điều chỉnh"}
        loading={detail.isLoading}
        extra={
          isDraft ? (
            <Space>
              {can("stock.adjust.create") ? (
                <Button danger loading={cancel.isPending} onClick={() => cancel.mutate()}>
                  Hủy phiếu
                </Button>
              ) : null}
              {can("stock.adjust.approve") ? (
                <>
                  <Button onClick={() => setRejecting(true)}>Từ chối</Button>
                  <Button type="primary" loading={approve.isPending} onClick={() => approve.mutate()}>
                    Duyệt
                  </Button>
                </>
              ) : null}
            </Space>
          ) : null
        }
      >
        {adjustment ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Descriptions
              size="small"
              column={2}
              items={[
                { key: "status", label: "Trạng thái", children: <Tag color={STATUS[adjustment.status].color}>{STATUS[adjustment.status].text}</Tag> },
                { key: "reason", label: "Lý do chung", children: adjustment.reason ?? "—" },
                { key: "createdBy", label: "Người lập", children: adjustment.createdBy.fullName },
                { key: "approvedBy", label: "Người duyệt", children: adjustment.approvedBy?.fullName ?? "—" },
                ...(adjustment.status === "REJECTED"
                  ? [{ key: "rejectedReason", label: "Lý do từ chối", children: adjustment.rejectedReason ?? "—", span: 2 }]
                  : []),
              ]}
            />
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={adjustment.lines}
              columns={[
                { title: "Lô", dataIndex: "batchNumber", width: 120 },
                { title: "Đơn vị", dataIndex: "unitName", width: 90 },
                { title: "Lý do", width: 150, render: (_, line) => REASONS[line.reasonCode] ?? line.reasonCode },
                { title: "Tồn lúc lập", width: 100, align: "right" as const, render: (_, line) => line.systemBaseQuantityAtCount ?? "—" },
                { title: "Số đếm / SL hủy", width: 130, align: "right" as const, render: (_, line) => line.countedQuantity ?? line.quantity },
                { title: "Chênh lệch áp dụng", width: 140, align: "right" as const, render: (_, line) => line.deltaBaseQuantity ?? "—" },
              ]}
            />
          </Space>
        ) : null}
      </Drawer>

      <Modal
        open={rejecting}
        title="Từ chối phiếu điều chỉnh"
        okText="Từ chối"
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
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<BatchListItem>>>("/inventory/batches", {
          params: { search: batchSearch, status: "AVAILABLE", page: 1, limit: 15 },
        })
      ).data.data.items,
  });

  async function addBatch(batchId: string): Promise<void> {
    const batch = (batches.data ?? []).find((item) => item.id === batchId);
    if (!batch) return;
    const product = (await http.get<Envelope<ProductDetail>>(`/products/${batch.productId}`)).data.data;
    setLines((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        productName: batch.productName,
        units: product.units,
        unitId: product.units[0]?.id ?? "",
        reasonCode: "COUNT_DIFFERENCE",
      },
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
    onSuccess: async (id) => { void message.success("Đã lập phiếu điều chỉnh"); await onCreated(id); },
    onError: (error) => void message.error(getErrorMessage(error, "Không lập được phiếu")),
  });

  const canSave =
    lines.length > 0 &&
    lines.every((line) =>
      line.unitId && line.reasonCode === "COUNT_DIFFERENCE"
        ? line.countedQuantity !== undefined && line.countedQuantity >= 0
        : (line.quantity ?? 0) > 0,
    );

  return (
    <Modal
      open={open}
      width={900}
      title="Lập phiếu điều chỉnh tồn"
      okText="Lưu phiếu nháp"
      onOk={() => create.mutate()}
      onCancel={onClose}
      confirmLoading={create.isPending}
      okButtonProps={{ disabled: !canSave }}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Input placeholder="Lý do chung (không bắt buộc)" value={reason} onChange={(event) => setReason(event.target.value)} />
        <AutoComplete
          value={batchSearch}
          onChange={setBatchSearch}
          onSelect={(id) => void addBatch(String(id))}
          options={(batches.data ?? []).map((batch) => ({ value: batch.id, label: `${batch.batchNumber} — ${batch.productName} (còn ${batch.quantityOnHand} ${batch.baseUnitName})` }))}
        >
          <Input.Search placeholder="Tìm lô theo tên/mã sản phẩm hoặc số lô" />
        </AutoComplete>
        <Table
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={lines}
          locale={{ emptyText: "Chưa có dòng nào." }}
          columns={[
            { title: "Lô / sản phẩm", width: 220, render: (_, line: DraftLine) => <Space direction="vertical" size={0}><Typography.Text strong>{line.batchNumber}</Typography.Text><Typography.Text type="secondary">{line.productName}</Typography.Text></Space> },
            { title: "Đơn vị", width: 130, render: (_, line: DraftLine) => <Select value={line.unitId} onChange={(unitId) => changeLine(line.key, { unitId })} options={line.units.map((unit) => ({ value: unit.id, label: unit.name }))} /> },
            { title: "Lý do", width: 190, render: (_, line: DraftLine) => <Select value={line.reasonCode} onChange={(reasonCode) => changeLine(line.key, { reasonCode })} options={Object.entries(REASONS).map(([value, label]) => ({ value, label }))} /> },
            {
              title: "Số lượng",
              width: 160,
              render: (_, line: DraftLine) =>
                line.reasonCode === "COUNT_DIFFERENCE" ? (
                  <InputNumber min={0} precision={0} placeholder="Số đếm thực tế" style={{ width: "100%" }} value={line.countedQuantity} onChange={(value) => changeLine(line.key, { countedQuantity: value ?? undefined })} />
                ) : (
                  <InputNumber min={1} precision={0} placeholder="Số lượng xuất hủy" style={{ width: "100%" }} value={line.quantity} onChange={(value) => changeLine(line.key, { quantity: value ?? undefined })} />
                ),
            },
            { title: "", width: 40, render: (_, line: DraftLine) => <Button type="text" danger onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}>Xóa</Button> },
          ]}
        />
      </Space>
    </Modal>
  );
}
