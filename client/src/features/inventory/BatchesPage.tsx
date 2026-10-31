import {
  BellOutlined,
  DatabaseOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  FieldTimeOutlined,
  ImportOutlined,
  LockOutlined,
  StopOutlined,
  UnlockOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Segmented,
  Skeleton,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import { useNavigate } from "react-router";
import { getErrorMessage, http } from "../../api/http.js";
import {
  formatVnd,
  type BatchListItem,
  type DashboardData,
  type Envelope,
  type InventoryOverviewItem,
  type Paged,
  type StockLedgerEntry,
  type StockLedgerPage,
} from "../../api/types.js";
import { daysUntil, formatDate, formatDateTime, formatNumber } from "../../ui/format.js";
import { PackHint } from "../../ui/PackHint.js";
import { daysLeftLabel, isExpired } from "./expiry-status.js";
import { ExcelExportButton } from "../excel/ExcelButtons.js";
import { ExcelImportModal } from "../excel/ExcelImportModal.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { StatCard, StatGrid } from "../../ui/StatCard.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/auth-context.js";
import { ShelfLocationInput } from "./ShelfLocationInput.js";
import { useShelfHints } from "./shelf-location-api.js";

const STATUS: Record<BatchListItem["status"], { label: string; color: string }> = {
  AVAILABLE: { label: "Có thể bán", color: "green" },
  QUARANTINED: { label: "Biệt trữ", color: "orange" },
  RECALLED: { label: "Thu hồi", color: "red" },
};

const MOVEMENT_LABEL: Record<string, string> = {
  RECEIPT: "Nhập hàng",
  OPENING_BALANCE: "Tồn đầu kỳ",
  SALE: "Bán hàng",
  SALE_VOID: "Hủy hóa đơn",
  CUSTOMER_RETURN: "Khách trả hàng",
  ADJUSTMENT: "Điều chỉnh",
  DISPOSAL: "Xuất hủy",
  SUPPLIER_RETURN: "Trả nhà cung cấp",
  TRANSFER_OUT: "Chuyển đi cửa hàng khác",
  TRANSFER_IN: "Nhận từ cửa hàng khác",
  TRANSFER_CANCEL: "Hủy chuyển, nhập lại",
};

function ExpiryCell({ value }: { value: string }) {
  const days = daysUntil(value);
  return (
    <div className="cell-main">
      <strong>{formatDate(value)}</strong>
      {isExpired(days) ? (
        <span className="text-danger">{daysLeftLabel(days)}</span>
      ) : days <= 90 ? (
        <span className={days <= 30 ? "text-danger" : "text-warning"}>Còn {days} ngày</span>
      ) : (
        <span>Còn {Math.floor(days / 30)} tháng</span>
      )}
    </div>
  );
}

/** Tồn kho: theo lô (biệt trữ/mở biệt trữ, thẻ kho) và theo sản phẩm (tổng hợp, dưới mức tối thiểu). */
export function BatchesPage() {
  const { storeId, can, me } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<BatchListItem | null>(null);
  const [importingOpening, setImportingOpening] = useState(false);
  // Tồn đầu kỳ ghi vào cửa hàng đang chọn nên bắt buộc đã chọn cửa hàng.
  const canImportOpening = can("stock.opening_balance") && Boolean(storeId);
  const storeName = me?.stores.find((item) => item.id === storeId)?.name;

  // Cùng queryKey với Tổng quan và chuông thông báo: số đếm do máy chủ tính trên toàn bộ lô.
  const dashboard = useQuery({
    queryKey: ["dashboard", storeId, 7],
    queryFn: async () =>
      (await http.get<Envelope<DashboardData>>("/dashboard", { params: { days: 7 } })).data.data,
    enabled: Boolean(storeId),
    staleTime: 60_000,
  });
  const quarantined = useQuery({
    queryKey: ["inventory-batches", "count-quarantined"],
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<BatchListItem>>>("/inventory/batches", {
          params: { status: "QUARANTINED", page: 1, limit: 1 },
        })
      ).data.data.pagination.total,
  });
  const counts = dashboard.data?.inventory.counts;

  return (
    <div>
      <PageHeader
        icon={<DatabaseOutlined />}
        title="Tồn kho"
        extra={
          <>
            {canImportOpening ? (
              <Button icon={<ImportOutlined />} onClick={() => setImportingOpening(true)}>
                Nhập tồn đầu kỳ
              </Button>
            ) : null}
            <ExcelExportButton
              type="inventory"
              label="Xuất tồn theo lô"
              tooltip="Tồn từng lô theo hạn dùng, dùng khi kiểm kê"
            />
            <Button icon={<BellOutlined />} onClick={() => void navigate("/can-han")}>
              Hàng cận hạn
            </Button>
          </>
        }
      />
      {canImportOpening ? (
        <ExcelImportModal
          type="opening-balance"
          title="Tồn đầu kỳ"
          open={importingOpening}
          hint={`Tồn được ghi vào ${storeName ?? "cửa hàng đang chọn"}. Chỉ nhập được trước hóa đơn bán đầu tiên của cửa hàng.`}
          onClose={() => setImportingOpening(false)}
          // Tồn đầu kỳ thay đổi lô, tồn theo sản phẩm lẫn số liệu tổng quan.
          onDone={() => void queryClient.invalidateQueries()}
        />
      ) : null}

      <StatGrid>
        <StatCard
          tone="orange"
          icon={<WarningOutlined />}
          label="Lô sắp hết hạn"
          value={formatNumber(counts?.expiring)}
          loading={dashboard.isLoading}
          hint="Trong 90 ngày tới"
        />
        <StatCard
          tone="red"
          icon={<StopOutlined />}
          label="Lô đã hết hạn"
          value={formatNumber(counts?.expired)}
          loading={dashboard.isLoading}
          hint="Không bán được, cần xử lý"
        />
        <StatCard
          tone="purple"
          icon={<ExclamationCircleOutlined />}
          label="Dưới tồn tối thiểu"
          value={formatNumber(counts?.lowStock)}
          loading={dashboard.isLoading}
          hint="Mặt hàng nên đặt thêm"
        />
        <StatCard
          tone="slate"
          icon={<LockOutlined />}
          label="Lô đang biệt trữ"
          value={formatNumber(quarantined.data)}
          loading={quarantined.isLoading}
          hint="Đang bị chặn bán"
        />
      </StatGrid>

      {/* Chưa chọn lô thì bảng chiếm hết chiều ngang; chọn lô mới mở cột chi tiết. */}
      <div className={selected ? "split-layout" : undefined}>
        <Card>
          <Tabs
            items={[
              {
                key: "batches",
                label: "Theo lô",
                children: <BatchesTab selectedId={selected?.id ?? null} onSelect={setSelected} />,
              },
              { key: "overview", label: "Theo sản phẩm", children: <OverviewTab /> },
            ]}
          />
        </Card>
        {selected ? (
          <aside className="split-aside">
            <BatchPanel
              batch={selected}
              onChanged={setSelected}
              onClose={() => setSelected(null)}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function BatchPanel({
  batch,
  onChanged,
  onClose,
}: {
  batch: BatchListItem;
  onChanged: (batch: BatchListItem) => void;
  onClose: () => void;
}) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [changing, setChanging] = useState(false);
  /** Đang sửa vị trí: chuỗi đang gõ; null là không sửa. */
  const [shelfDraft, setShelfDraft] = useState<string | null>(null);
  const shelfHints = useShelfHints([batch.productId], shelfDraft !== null);
  const showCost = can("stock.cost.read");
  const isAvailable = batch.status === "AVAILABLE";

  const ledger = useQuery({
    queryKey: ["stock-ledger", batch.id],
    queryFn: async () =>
      (
        await http.get<Envelope<StockLedgerPage>>("/inventory/transactions", {
          params: { batchId: batch.id, limit: 50 },
        })
      ).data.data,
  });

  const moveShelf = useMutation({
    mutationFn: async (value: string) =>
      (
        await http.patch<Envelope<{ shelfLocation: string | null }>>(
          `/inventory/batches/${batch.id}/location`,
          { shelfLocation: value.trim() || null },
        )
      ).data.data,
    onSuccess: async (result) => {
      void message.success("Đã cập nhật vị trí");
      setShelfDraft(null);
      onChanged({ ...batch, shelfLocation: result.shelfLocation });
      await queryClient.invalidateQueries({ queryKey: ["inventory-batches"] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không cập nhật được vị trí")),
  });

  const action = useMutation({
    mutationFn: async (reason: string) =>
      http.post(
        `/inventory/batches/${batch.id}/${isAvailable ? "quarantine" : "release"}`,
        { reason, version: batch.version },
        { headers: { "Idempotency-Key": crypto.randomUUID() } },
      ),
    onSuccess: async () => {
      void message.success(
        isAvailable ? "Đã biệt trữ lô, lô bị chặn bán ngay" : "Đã mở biệt trữ, lô bán được trở lại",
      );
      setChanging(false);
      // Tải lại đúng lô đang mở để có trạng thái và version mới, thao tác tiếp không bị báo xung đột.
      const fresh = await http.get<Envelope<Paged<BatchListItem>>>("/inventory/batches", {
        params: { search: batch.batchNumber, page: 1, limit: 20 },
      });
      const updated = fresh.data.data.items.find((item) => item.id === batch.id);
      if (updated) onChanged(updated);
      await queryClient.invalidateQueries({ queryKey: ["inventory-batches"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (error) =>
      void message.error(getErrorMessage(error, "Không cập nhật được trạng thái lô")),
  });

  return (
    <Card
      title={
        <span>
          Lô <span className="mono">{batch.batchNumber}</span>
        </span>
      }
      extra={
        <Button type="text" size="small" onClick={onClose}>
          Đóng
        </Button>
      }
    >
      <div className="detail-stack">
        <div>
          <h3 className="detail-title">{batch.productName}</h3>
          <span className="detail-sub">
            {batch.productCode} ·{" "}
            <Tag color={STATUS[batch.status].color}>{STATUS[batch.status].label}</Tag>
          </span>
        </div>
        <dl className="kv-list">
          <div>
            <dt>Tồn hiện tại</dt>
            <dd>
              <strong>
                {formatNumber(batch.quantityOnHand)} {batch.baseUnitName}
              </strong>
              <PackHint quantity={batch.quantityOnHand} item={batch} block />
            </dd>
          </div>
          <div>
            <dt>Hạn dùng</dt>
            <dd>
              <ExpiryCell value={batch.expiryDate} />
            </dd>
          </div>
          <div>
            <dt>Ngày sản xuất</dt>
            <dd>{formatDate(batch.manufactureDate)}</dd>
          </div>
          <div>
            <dt>Vị trí kệ</dt>
            <dd>
              {shelfDraft === null ? (
                <>
                  {batch.shelfLocation ?? "—"}
                  {can("stock.adjust.create") ? (
                    <Button
                      type="link"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => setShelfDraft(batch.shelfLocation ?? "")}
                    >
                      Sửa
                    </Button>
                  ) : null}
                </>
              ) : (
                <Space.Compact style={{ width: "100%" }}>
                  <ShelfLocationInput
                    size="small"
                    autoFocus
                    value={shelfDraft}
                    onChange={setShelfDraft}
                    locations={shelfHints.data?.locations ?? []}
                  />
                  <Button
                    size="small"
                    type="primary"
                    loading={moveShelf.isPending}
                    onClick={() => moveShelf.mutate(shelfDraft)}
                  >
                    Lưu
                  </Button>
                  <Button size="small" onClick={() => setShelfDraft(null)}>
                    Hủy
                  </Button>
                </Space.Compact>
              )}
            </dd>
          </div>
          {showCost ? (
            <div>
              <dt>Giá vốn</dt>
              <dd>{formatVnd(batch.unitCost ?? null)}</dd>
            </div>
          ) : null}
          {batch.note ? (
            <div>
              <dt>Ghi chú</dt>
              <dd>{batch.note}</dd>
            </div>
          ) : null}
        </dl>

        {can("batch.quarantine") && batch.status !== "RECALLED" ? (
          <Button
            block
            danger={isAvailable}
            icon={isAvailable ? <LockOutlined /> : <UnlockOutlined />}
            onClick={() => setChanging(true)}
          >
            {isAvailable ? "Biệt trữ lô này" : "Mở biệt trữ"}
          </Button>
        ) : null}
        {batch.status === "RECALLED" ? (
          <Typography.Text type="secondary">
            Lô thu hồi chỉ được xử lý qua thông báo thu hồi.
          </Typography.Text>
        ) : null}

        <div className="ledger">
          <div className="ledger-head">
            <FieldTimeOutlined /> Thẻ kho
          </div>
          {ledger.isLoading ? (
            <Skeleton active paragraph={{ rows: 4 }} />
          ) : (ledger.data?.items.length ?? 0) === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có biến động" />
          ) : (
            <ol className="ledger-list">
              {ledger.data!.items.map((row: StockLedgerEntry) => (
                <li key={row.id}>
                  <span
                    className={row.baseQuantity >= 0 ? "ledger-dot in" : "ledger-dot out"}
                    aria-hidden
                  />
                  <div className="ledger-body">
                    <div className="ledger-row">
                      <strong>{MOVEMENT_LABEL[row.type] ?? row.type}</strong>
                      <span className={row.baseQuantity >= 0 ? "ledger-qty in" : "ledger-qty out"}>
                        {row.baseQuantity > 0
                          ? `+${formatNumber(row.baseQuantity)}`
                          : formatNumber(row.baseQuantity)}
                      </span>
                    </div>
                    <div className="ledger-row ledger-meta">
                      <span>
                        {formatDateTime(row.occurredAt)} · {row.userName ?? "Hệ thống"}
                      </span>
                      <span>Tồn {formatNumber(row.balanceAfter)}</span>
                    </div>
                    {row.note ? <div className="ledger-note">{row.note}</div> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {ledger.data?.nextCursor ? (
            <p className="section-note">Chỉ hiển thị 50 biến động gần nhất.</p>
          ) : null}
        </div>
      </div>

      <BatchStatusModal
        open={changing}
        isQuarantine={isAvailable}
        loading={action.isPending}
        onClose={() => setChanging(false)}
        onSubmit={(reason) => action.mutate(reason)}
      />
    </Card>
  );
}

function BatchesTab({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (batch: BatchListItem) => void;
}) {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<BatchListItem["status"] | "ALL">("ALL");
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim(), 300);
  const showCost = can("stock.cost.read");

  const batches = useQuery({
    queryKey: ["inventory-batches", term, status, page],
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<BatchListItem>>>("/inventory/batches", {
          params: {
            search: term || undefined,
            status: status === "ALL" ? undefined : status,
            page,
            limit: 20,
          },
        })
      ).data.data,
    placeholderData: (previous) => previous,
  });

  return (
    <>
      <div className="toolbar">
        <Segmented
          value={status}
          onChange={(value) => {
            setStatus(value as typeof status);
            setPage(1);
          }}
          options={[
            { value: "ALL", label: "Tất cả" },
            { value: "AVAILABLE", label: "Có thể bán" },
            { value: "QUARANTINED", label: "Biệt trữ" },
            { value: "RECALLED", label: "Thu hồi" },
          ]}
        />
        <Input.Search
          allowClear
          className="toolbar-grow"
          placeholder="Tên, mã sản phẩm hoặc số lô"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
      </div>
      <Table
        rowKey="id"
        loading={batches.isFetching}
        dataSource={batches.data?.items ?? []}
        scroll={{ x: 760 }}
        onRow={(item) => ({ onClick: () => onSelect(item), style: { cursor: "pointer" } })}
        rowClassName={(item) => (item.id === selectedId ? "row-selected" : "")}
        locale={{
          emptyText: (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có lô phù hợp" />
          ),
        }}
        pagination={{
          current: page,
          pageSize: batches.data?.pagination.limit ?? 20,
          total: batches.data?.pagination.total ?? 0,
          onChange: setPage,
          showSizeChanger: false,
          showTotal: (total) => `${total} lô`,
        }}
        columns={[
          // Cột Sản phẩm 30%, các cột ngắn rộng bằng nhau và canh giữa: màn rộng thì
          // khoảng trống chia đều giữa các cột, không dồn thành một khoảng lớn.
          {
            title: "Sản phẩm",
            key: "product",
            width: "30%",
            render: (_: unknown, item: BatchListItem) => (
              <div className="cell-main">
                <strong>{item.productName}</strong>
                <span>
                  {item.productCode} · Lô <span className="mono">{item.batchNumber}</span>
                </span>
              </div>
            ),
          },
          {
            title: "Hạn dùng",
            key: "expiry",
            width: "17.5%",
            align: "center",
            render: (_: unknown, item: BatchListItem) => <ExpiryCell value={item.expiryDate} />,
          },
          {
            title: "Tồn",
            key: "qty",
            width: "17.5%",
            align: "center",
            render: (_: unknown, item: BatchListItem) => (
              <div className="cell-main cell-center">
                <div>
                  <strong>{formatNumber(item.quantityOnHand)}</strong> {item.baseUnitName}
                </div>
                <PackHint quantity={item.quantityOnHand} item={item} />
              </div>
            ),
          },
          ...(showCost
            ? [
                {
                  title: "Giá vốn",
                  key: "cost",
                  width: "17.5%",
                  align: "center" as const,
                  render: (_: unknown, item: BatchListItem) => formatVnd(item.unitCost ?? null),
                },
              ]
            : []),
          {
            title: "Trạng thái",
            key: "status",
            width: "17.5%",
            align: "center",
            render: (_: unknown, item: BatchListItem) => (
              <Tag color={STATUS[item.status].color}>{STATUS[item.status].label}</Tag>
            ),
          },
        ]}
      />
    </>
  );
}

function BatchStatusModal({
  open,
  isQuarantine,
  loading,
  onClose,
  onSubmit,
}: {
  open: boolean;
  isQuarantine: boolean;
  loading: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [form] = Form.useForm<{ reason: string }>();
  return (
    <Modal
      open={open}
      title={isQuarantine ? "Biệt trữ lô hàng" : "Mở biệt trữ lô hàng"}
      okText={isQuarantine ? "Xác nhận biệt trữ" : "Xác nhận mở biệt trữ"}
      okButtonProps={{ danger: isQuarantine }}
      cancelText="Hủy"
      onCancel={onClose}
      onOk={() => void form.validateFields().then(({ reason }) => onSubmit(reason))}
      confirmLoading={loading}
      afterOpenChange={(visible) => {
        if (visible) form.resetFields();
      }}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        {isQuarantine
          ? "Lô này sẽ bị chặn bán ngay tại cửa hàng đang chọn, tồn kho giữ nguyên."
          : "Lô này sẽ được phép bán trở lại. Chỉ thực hiện sau khi đã kiểm tra chất lượng."}
      </Typography.Paragraph>
      <Form form={form} layout="vertical">
        <Form.Item
          name="reason"
          label="Lý do"
          rules={[
            { required: true, whitespace: true, min: 3, message: "Nhập lý do tối thiểu 3 ký tự" },
          ]}
        >
          <Input.TextArea
            rows={3}
            placeholder={
              isQuarantine
                ? "Ví dụ: Bao bì rách, chờ kiểm tra"
                : "Ví dụ: Đã kiểm tra, hàng đạt yêu cầu"
            }
            autoFocus
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** Tồn tổng hợp theo sản phẩm, cảnh báo sản phẩm dưới mức tồn tối thiểu (contract §10.1). */
function OverviewTab() {
  const [search, setSearch] = useState("");
  const [belowMinOnly, setBelowMinOnly] = useState(false);
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim(), 300);

  const overview = useQuery({
    queryKey: ["inventory-overview", term, belowMinOnly, page],
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<InventoryOverviewItem>>>("/inventory", {
          params: {
            search: term || undefined,
            belowMinStock: belowMinOnly ? "true" : undefined,
            page,
            limit: 20,
          },
        })
      ).data.data,
    placeholderData: (previous) => previous,
  });

  return (
    <>
      <div className="toolbar">
        <Segmented
          value={belowMinOnly ? "low" : "all"}
          onChange={(value) => {
            setBelowMinOnly(value === "low");
            setPage(1);
          }}
          options={[
            { value: "all", label: "Tất cả sản phẩm" },
            { value: "low", label: "Dưới tồn tối thiểu" },
          ]}
        />
        <Input.Search
          allowClear
          className="toolbar-grow"
          placeholder="Tên hoặc mã sản phẩm"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
      </div>
      <Table
        rowKey="productId"
        loading={overview.isFetching}
        dataSource={overview.data?.items ?? []}
        scroll={{ x: 720 }}
        locale={{
          emptyText: (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có sản phẩm phù hợp" />
          ),
        }}
        pagination={{
          current: page,
          pageSize: overview.data?.pagination.limit ?? 20,
          total: overview.data?.pagination.total ?? 0,
          onChange: setPage,
          showSizeChanger: false,
          showTotal: (total) => `${total} sản phẩm`,
        }}
        columns={[
          {
            title: "Sản phẩm",
            key: "product",
            width: "30%",
            render: (_: unknown, item: InventoryOverviewItem) => (
              <div className="cell-main">
                <strong>{item.name}</strong>
                <span>
                  {item.code} · {item.categoryName}
                </span>
              </div>
            ),
          },
          {
            title: "Bán được",
            key: "sellable",
            width: "17.5%",
            align: "center",
            render: (_: unknown, item: InventoryOverviewItem) => {
              const low = item.stock.sellable < item.minStockBaseQuantity;
              return (
                <div className="cell-main cell-center">
                  <strong className={low ? "text-danger" : undefined}>
                    {formatNumber(item.stock.sellable)} {item.baseUnitName ?? ""}
                  </strong>
                  <PackHint quantity={item.stock.sellable} item={item} />
                  <span>tối thiểu {formatNumber(item.minStockBaseQuantity)}</span>
                </div>
              );
            },
          },
          {
            title: "Biệt trữ",
            key: "quarantined",
            width: "17.5%",
            align: "center",
            render: (_: unknown, item: InventoryOverviewItem) =>
              formatNumber(item.stock.quarantined),
          },
          {
            title: "Thu hồi",
            key: "recalled",
            width: "17.5%",
            align: "center",
            render: (_: unknown, item: InventoryOverviewItem) => formatNumber(item.stock.recalled),
          },
          {
            title: "Hết hạn",
            key: "expired",
            width: "17.5%",
            align: "center",
            render: (_: unknown, item: InventoryOverviewItem) => formatNumber(item.stock.expired),
          },
        ]}
      />
    </>
  );
}
