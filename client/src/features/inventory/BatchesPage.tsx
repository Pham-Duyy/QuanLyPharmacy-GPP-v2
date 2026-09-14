import { DatabaseOutlined, WarningOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Drawer, Form, Input, Modal, Select, Space, Table, Tabs, Tag, Typography, message } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import {
  formatVnd,
  type BatchListItem,
  type Envelope,
  type InventoryOverviewItem,
  type Paged,
  type StockLedgerEntry,
  type StockLedgerPage,
} from "../../api/types.js";
import { useAuth } from "../auth/AuthProvider.js";

const STATUS: Record<BatchListItem["status"], { label: string; color: string }> = {
  AVAILABLE: { label: "Có thể bán", color: "green" },
  QUARANTINED: { label: "Biệt trữ", color: "orange" },
  RECALLED: { label: "Thu hồi", color: "red" },
};
const formatDate = (value: string | null) => (value ? new Intl.DateTimeFormat("vi-VN").format(new Date(value)) : "—");

/** Tồn kho: theo lô (biệt trữ/mở biệt trữ) và theo sản phẩm (tổng hợp, cảnh báo dưới mức tối thiểu). */
export function BatchesPage() {
  return (
    <div className="inventory-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}><DatabaseOutlined /> Quản lý kho</Typography.Title>
          <Typography.Text>Theo dõi tồn kho, lô thuốc, kiểm kê và biến động kho tại cửa hàng.</Typography.Text>
        </div>
        <Tag color="gold" icon={<WarningOutlined />}>Ưu tiên kiểm tra lô gần hết hạn</Tag>
      </div>
    <Card className="inventory-panel" title="Dữ liệu kho">
      <Tabs
        items={[
          { key: "batches", label: "Theo lô", children: <BatchesTab /> },
          { key: "overview", label: "Theo sản phẩm", children: <OverviewTab /> },
        ]}
      />
    </Card>
    </div>
  );
}

function BatchesTab() {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<BatchListItem["status"] | undefined>();
  const [page, setPage] = useState(1);
  const [changing, setChanging] = useState<BatchListItem | null>(null);
  const [ledgerBatch, setLedgerBatch] = useState<BatchListItem | null>(null);
  const queryClient = useQueryClient();
  const showCost = can("stock.cost.read");

  const batches = useQuery({
    queryKey: ["inventory-batches", search, status, page],
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<BatchListItem>>>("/inventory/batches", {
          params: { search: search || undefined, status, page, limit: 20 },
        })
      ).data.data,
  });
  const action = useMutation({
    mutationFn: async ({ batch, reason }: { batch: BatchListItem; reason: string }) =>
      http.post(
        `/inventory/batches/${batch.id}/${batch.status === "AVAILABLE" ? "quarantine" : "release"}`,
        { reason, version: batch.version },
        { headers: { "Idempotency-Key": crypto.randomUUID() } },
      ),
    onSuccess: async () => {
      void message.success("Đã cập nhật trạng thái lô");
      setChanging(null);
      await queryClient.invalidateQueries({ queryKey: ["inventory-batches"] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không cập nhật được trạng thái lô")),
  });

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder="Tất cả trạng thái"
          style={{ width: 180 }}
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
          options={Object.entries(STATUS).map(([value, info]) => ({ value, label: info.label }))}
        />
        <Input.Search
          allowClear
          placeholder="Tên, mã sản phẩm hoặc số lô"
          style={{ width: 280 }}
          onSearch={(value) => {
            setSearch(value);
            setPage(1);
          }}
        />
      </Space>
      <Typography.Paragraph type="secondary">
        Biệt trữ chặn lô khỏi bán hàng nhưng không xóa tồn. Lô thu hồi chỉ được quản lý qua thông báo thu hồi.
      </Typography.Paragraph>
      <Table
        rowKey="id"
        size="small"
        loading={batches.isLoading}
        dataSource={batches.data?.items ?? []}
        pagination={{
          current: page,
          pageSize: batches.data?.pagination.limit ?? 20,
          total: batches.data?.pagination.total ?? 0,
          onChange: setPage,
          showSizeChanger: false,
        }}
        columns={[
          {
            title: "Sản phẩm",
            render: (_, item: BatchListItem) => (
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{item.productName}</Typography.Text>
                <Typography.Text type="secondary">{item.productCode}</Typography.Text>
              </Space>
            ),
          },
          { title: "Số lô", dataIndex: "batchNumber", width: 150 },
          { title: "Hạn dùng", dataIndex: "expiryDate", width: 120, render: formatDate },
          { title: "Tồn", width: 110, align: "right", render: (_, item: BatchListItem) => `${item.quantityOnHand} ${item.baseUnitName}` },
          ...(showCost
            ? [{ title: "Giá vốn", width: 120, align: "right" as const, render: (_: unknown, item: BatchListItem) => formatVnd(item.unitCost ?? null) }]
            : []),
          { title: "Trạng thái", width: 130, render: (_, item: BatchListItem) => <Tag color={STATUS[item.status].color}>{STATUS[item.status].label}</Tag> },
          {
            title: "Thao tác",
            width: 220,
            render: (_, item: BatchListItem) => (
              <Space>
                <Button size="small" onClick={() => setLedgerBatch(item)}>
                  Thẻ kho
                </Button>
                {can("batch.quarantine") && item.status !== "RECALLED" ? (
                  <Button danger={item.status === "AVAILABLE"} size="small" onClick={() => setChanging(item)}>
                    {item.status === "AVAILABLE" ? "Biệt trữ" : "Mở biệt trữ"}
                  </Button>
                ) : null}
              </Space>
            ),
          },
        ]}
      />
      <BatchStatusModal batch={changing} loading={action.isPending} onClose={() => setChanging(null)} onSubmit={(reason) => changing && action.mutate({ batch: changing, reason })} />
      <LedgerDrawer batch={ledgerBatch} onClose={() => setLedgerBatch(null)} />
    </>
  );
}

function BatchStatusModal({ batch, loading, onClose, onSubmit }: { batch: BatchListItem | null; loading: boolean; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [form] = Form.useForm<{ reason: string }>();
  const isQuarantine = batch?.status === "AVAILABLE";
  return (
    <Modal
      open={batch !== null}
      title={isQuarantine ? "Biệt trữ lô hàng" : "Mở biệt trữ lô hàng"}
      okText={isQuarantine ? "Xác nhận biệt trữ" : "Xác nhận mở biệt trữ"}
      cancelText="Hủy"
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      onOk={() => void form.validateFields().then(({ reason }) => onSubmit(reason))}
      confirmLoading={loading}
      afterOpenChange={(visible) => {
        if (visible) form.resetFields();
      }}
      destroyOnHidden
    >
      <Typography.Paragraph>
        {isQuarantine ? "Lô này sẽ bị chặn bán ngay tại cửa hàng đang chọn." : "Lô này sẽ được phép bán trở lại. Chỉ thực hiện sau khi đã kiểm tra chất lượng."}
      </Typography.Paragraph>
      <Form form={form} layout="vertical">
        <Form.Item name="reason" label="Lý do" rules={[{ required: true, whitespace: true, min: 3, message: "Nhập lý do tối thiểu 3 ký tự" }]}>
          <Input.TextArea rows={3} placeholder={isQuarantine ? "Ví dụ: Bao bì rách, chờ kiểm tra" : "Ví dụ: Đã kiểm tra, hàng đạt yêu cầu"} autoFocus />
        </Form.Item>
      </Form>
    </Modal>
  );
}

const MOVEMENT_LABEL: Record<string, string> = {
  RECEIPT: "Nhập hàng",
  OPENING_BALANCE: "Tồn đầu kỳ",
  SALE: "Bán hàng",
  SALE_VOID: "Hủy hóa đơn",
  CUSTOMER_RETURN: "Khách trả hàng",
  ADJUSTMENT: "Điều chỉnh",
  DISPOSAL: "Xuất hủy",
};

/** Thẻ kho của một lô: mọi biến động, chỉ thêm không sửa (contract §10.2). */
function LedgerDrawer({ batch, onClose }: { batch: BatchListItem | null; onClose: () => void }) {
  const ledger = useQuery({
    queryKey: ["stock-ledger", batch?.id],
    enabled: batch !== null,
    queryFn: async () =>
      (await http.get<Envelope<StockLedgerPage>>("/inventory/transactions", { params: { batchId: batch!.id, limit: 100 } })).data.data,
  });

  return (
    <Drawer width={720} open={batch !== null} onClose={onClose} title={batch ? `Thẻ kho — ${batch.batchNumber} (${batch.productName})` : "Thẻ kho"}>
      <Table
        rowKey="id"
        size="small"
        loading={ledger.isLoading}
        dataSource={ledger.data?.items ?? []}
        pagination={false}
        locale={{ emptyText: "Chưa có biến động" }}
        columns={[
          { title: "Thời điểm", width: 150, render: (_, row: StockLedgerEntry) => new Date(row.occurredAt).toLocaleString("vi-VN") },
          { title: "Loại", width: 120, render: (_, row: StockLedgerEntry) => MOVEMENT_LABEL[row.type] ?? row.type },
          { title: "Số lượng", width: 100, align: "right", render: (_, row: StockLedgerEntry) => (row.baseQuantity > 0 ? `+${row.baseQuantity}` : row.baseQuantity) },
          { title: "Tồn sau", width: 90, align: "right", dataIndex: "balanceAfter" },
          { title: "Người thực hiện", render: (_, row: StockLedgerEntry) => row.userName ?? "—" },
        ]}
      />
      {ledger.data?.nextCursor ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
          Còn biến động cũ hơn chưa hiển thị. Chỉ hiển thị 100 dòng gần nhất.
        </Typography.Paragraph>
      ) : null}
    </Drawer>
  );
}

/** Tồn tổng hợp theo sản phẩm, cảnh báo sản phẩm dưới mức tồn tối thiểu (contract §10.1). */
function OverviewTab() {
  const [search, setSearch] = useState("");
  const [belowMinOnly, setBelowMinOnly] = useState(false);
  const [page, setPage] = useState(1);

  const overview = useQuery({
    queryKey: ["inventory-overview", belowMinOnly, page],
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<InventoryOverviewItem>>>("/inventory", {
          params: { belowMinStock: belowMinOnly ? "true" : undefined, page, limit: 20 },
        })
      ).data.data,
  });

  const filtered = (overview.data?.items ?? []).filter((item) => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return item.name.toLowerCase().includes(term) || item.code.toLowerCase().includes(term);
  });

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Input.Search allowClear placeholder="Tên hoặc mã sản phẩm" style={{ width: 260 }} onSearch={setSearch} />
        <Select
          style={{ width: 220 }}
          value={belowMinOnly}
          onChange={(value) => {
            setBelowMinOnly(value);
            setPage(1);
          }}
          options={[
            { value: false, label: "Tất cả sản phẩm" },
            { value: true, label: "Chỉ dưới mức tồn tối thiểu" },
          ]}
        />
      </Space>
      <Table
        rowKey="productId"
        size="small"
        loading={overview.isLoading}
        dataSource={filtered}
        pagination={{
          current: page,
          pageSize: overview.data?.pagination.limit ?? 20,
          total: overview.data?.pagination.total ?? 0,
          onChange: setPage,
          showSizeChanger: false,
        }}
        columns={[
          {
            title: "Sản phẩm",
            render: (_, item: InventoryOverviewItem) => (
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{item.name}</Typography.Text>
                <Typography.Text type="secondary">
                  {item.code} · {item.categoryName}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: "Tồn bán được",
            width: 130,
            align: "right",
            render: (_, item: InventoryOverviewItem) => (
              <Space direction="vertical" size={0} style={{ alignItems: "flex-end" }}>
                <Typography.Text strong type={item.stock.sellable < item.minStockBaseQuantity ? "danger" : undefined}>
                  {item.stock.sellable}
                </Typography.Text>
                <Typography.Text type="secondary">tối thiểu {item.minStockBaseQuantity}</Typography.Text>
              </Space>
            ),
          },
          { title: "Biệt trữ", width: 100, align: "right", render: (_, item: InventoryOverviewItem) => item.stock.quarantined },
          { title: "Thu hồi", width: 100, align: "right", render: (_, item: InventoryOverviewItem) => item.stock.recalled },
          { title: "Hết hạn", width: 100, align: "right", render: (_, item: InventoryOverviewItem) => item.stock.expired },
        ]}
      />
    </>
  );
}
