import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Form, Input, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { type BatchListItem, type Envelope, type Paged } from "../../api/types.js";
import { useAuth } from "../auth/AuthProvider.js";

const STATUS: Record<BatchListItem["status"], { label: string; color: string }> = {
  AVAILABLE: { label: "Có thể bán", color: "green" },
  QUARANTINED: { label: "Biệt trữ", color: "orange" },
  RECALLED: { label: "Thu hồi", color: "red" },
};
const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat("vi-VN").format(new Date(value)) : "—";

/** Tồn kho theo lô tại cửa hàng đang chọn; lô biệt trữ và thu hồi không được bán. */
export function BatchesPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<BatchListItem["status"] | undefined>();
  const [page, setPage] = useState(1);
  const [changing, setChanging] = useState<BatchListItem | null>(null);
  const queryClient = useQueryClient();
  const batches = useQuery({
    queryKey: ["inventory-batches", search, status, page],
    queryFn: async () => (await http.get<Envelope<Paged<BatchListItem>>>("/inventory/batches", { params: { search: search || undefined, status, page, limit: 20 } })).data.data,
  });
  const action = useMutation({
    mutationFn: async ({ batch, reason }: { batch: BatchListItem; reason: string }) => http.post(`/inventory/batches/${batch.id}/${batch.status === "AVAILABLE" ? "quarantine" : "release"}`, { reason, version: batch.version }, { headers: { "Idempotency-Key": crypto.randomUUID() } }),
    onSuccess: async () => { void message.success("Đã cập nhật trạng thái lô"); setChanging(null); await queryClient.invalidateQueries({ queryKey: ["inventory-batches"] }); },
    onError: (error) => void message.error(getErrorMessage(error, "Không cập nhật được trạng thái lô")),
  });
  return <Card title="Tồn kho theo lô" extra={<Space><Select allowClear placeholder="Tất cả trạng thái" style={{ width: 180 }} value={status} onChange={(value) => { setStatus(value); setPage(1); }} options={Object.entries(STATUS).map(([value, info]) => ({ value, label: info.label }))} /><Input.Search allowClear placeholder="Tên, mã sản phẩm hoặc số lô" style={{ width: 280 }} onSearch={(value) => { setSearch(value); setPage(1); }} /></Space>}>
    <Typography.Paragraph type="secondary">Biệt trữ chặn lô khỏi bán hàng nhưng không xóa tồn. Lô thu hồi chỉ được quản lý qua thông báo thu hồi.</Typography.Paragraph>
    <Table rowKey="id" size="small" loading={batches.isLoading} dataSource={batches.data?.items ?? []} pagination={{ current: page, pageSize: batches.data?.pagination.limit ?? 20, total: batches.data?.pagination.total ?? 0, onChange: setPage, showSizeChanger: false }} columns={[
      { title: "Sản phẩm", render: (_, item: BatchListItem) => <Space direction="vertical" size={0}><Typography.Text strong>{item.productName}</Typography.Text><Typography.Text type="secondary">{item.productCode}</Typography.Text></Space> },
      { title: "Số lô", dataIndex: "batchNumber", width: 150 },
      { title: "Hạn dùng", dataIndex: "expiryDate", width: 120, render: formatDate },
      { title: "Tồn", width: 110, align: "right", render: (_, item: BatchListItem) => `${item.quantityOnHand} ${item.baseUnitName}` },
      { title: "Trạng thái", width: 130, render: (_, item: BatchListItem) => <Tag color={STATUS[item.status].color}>{STATUS[item.status].label}</Tag> },
      { title: "Thao tác", width: 150, render: (_, item: BatchListItem) => can("batch.quarantine") && item.status !== "RECALLED" ? <Button danger={item.status === "AVAILABLE"} size="small" onClick={() => setChanging(item)}>{item.status === "AVAILABLE" ? "Biệt trữ" : "Mở biệt trữ"}</Button> : null },
    ]} />
    <BatchStatusModal batch={changing} loading={action.isPending} onClose={() => setChanging(null)} onSubmit={(reason) => changing && action.mutate({ batch: changing, reason })} />
  </Card>;
}

function BatchStatusModal({ batch, loading, onClose, onSubmit }: { batch: BatchListItem | null; loading: boolean; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [form] = Form.useForm<{ reason: string }>();
  const isQuarantine = batch?.status === "AVAILABLE";
  return <Modal open={batch !== null} title={isQuarantine ? "Biệt trữ lô hàng" : "Mở biệt trữ lô hàng"} okText={isQuarantine ? "Xác nhận biệt trữ" : "Xác nhận mở biệt trữ"} cancelText="Hủy" onCancel={() => { form.resetFields(); onClose(); }} onOk={() => void form.validateFields().then(({ reason }) => onSubmit(reason))} confirmLoading={loading} afterOpenChange={(visible) => { if (visible) form.resetFields(); }} destroyOnHidden><Typography.Paragraph>{isQuarantine ? "Lô này sẽ bị chặn bán ngay tại cửa hàng đang chọn." : "Lô này sẽ được phép bán trở lại. Chỉ thực hiện sau khi đã kiểm tra chất lượng."}</Typography.Paragraph><Form form={form} layout="vertical"><Form.Item name="reason" label="Lý do" rules={[{ required: true, whitespace: true, min: 3, message: "Nhập lý do tối thiểu 3 ký tự" }]}><Input.TextArea rows={3} placeholder={isQuarantine ? "Ví dụ: Bao bì rách, chờ kiểm tra" : "Ví dụ: Đã kiểm tra, hàng đạt yêu cầu"} autoFocus /></Form.Item></Form></Modal>;
}
