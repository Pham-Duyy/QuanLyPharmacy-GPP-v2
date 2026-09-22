import {
  AppstoreOutlined,
  CheckCircleFilled,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DatabaseOutlined,
  DollarCircleOutlined,
  DownloadOutlined,
  EditOutlined,
  ExclamationCircleFilled,
  EyeOutlined,
  FileDoneOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  InboxOutlined,
  MoreOutlined,
  PlusOutlined,
  PrinterOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  ShopOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Card, DatePicker, Dropdown, Empty, Input, Modal, Progress, Segmented, Select, Skeleton, Table, Tag, Typography } from "antd";
import type { Dayjs } from "dayjs";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { getErrorMessage, http } from "../../api/http.js";
import {
  formatVnd,
  type Envelope,
  type GoodsReceiptDetail,
  type GoodsReceiptLine,
  type GoodsReceiptListItem,
  type GoodsReceiptSummary,
  type Paged,
  type SupplierListItem,
} from "../../api/types.js";
import { daysUntil, formatDate, formatDateTime, formatNumber, vnDateKey } from "../../ui/format.js";
import { ExcelExportButton } from "../excel/ExcelButtons.js";
import { rangeParams } from "../excel/excel-api.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { StatCard, StatGrid, Trend } from "../../ui/StatCard.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";
import { printDocument, printUrl } from "../printing/printing.js";
import { PrintPreviewModal } from "../printing/PrintPreviewModal.js";
import { ReceiptFormModal } from "./ReceiptFormModal.js";

const STATUS: Record<GoodsReceiptDetail["status"], { text: string; color: string }> = {
  DRAFT: { text: "Chờ kiểm nhập", color: "gold" },
  CONFIRMED: { text: "Đã nhập kho", color: "green" },
  CANCELLED: { text: "Đã hủy", color: "default" },
};

type SortState = { sortBy: "receivedAt" | "totalCost"; order: "asc" | "desc" };

/** Xuất CSV từ các dòng đang chọn, không gọi thêm API. */
function downloadCsv(filename: string, rows: GoodsReceiptListItem[]): void {
  const header = ["Mã phiếu", "Nhà cung cấp", "Ngày nhập", "Số mặt hàng", "Tổng tiền", "Trạng thái"];
  const body = rows.map((row) => [row.code, row.supplierName ?? "", formatDate(row.receivedAt), row.lineCount, row.totalCost, STATUS[row.status].text]);
  const csv = [header, ...body].map((cells) => cells.map((cell) => JSON.stringify(String(cell))).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Danh sách phiếu nhập của cửa hàng đang chọn. */
export function GoodsReceiptsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const [previewing, setPreviewing] = useState<{ id: string; code: string } | null>(null);
  const canCreate = can("goods_receipt.create");
  const canConfirm = can("goods_receipt.confirm");
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [status, setStatus] = useState<GoodsReceiptDetail["status"]>();
  const [supplierId, setSupplierId] = useState<string>();
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ sortBy: "receivedAt", order: "desc" });
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Các thao tác mở từ menu ba chấm chạy trong panel chi tiết của phiếu đó.
  const [pendingAction, setPendingAction] = useState<PanelAction | null>(null);
  const term = useDebounced(search.trim(), 300);

  const list = useQuery({
    queryKey: ["goods-receipts", page, pageSize, status, supplierId, term, sort, range?.[0].format("YYYY-MM-DD"), range?.[1].format("YYYY-MM-DD")],
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<GoodsReceiptListItem>>>("/goods-receipts", {
          params: {
            page,
            limit: pageSize,
            status,
            supplierId,
            search: term || undefined,
            sortBy: sort.sortBy,
            order: sort.order,
            from: range ? range[0].startOf("day").toISOString() : undefined,
            to: range ? range[1].add(1, "day").startOf("day").toISOString() : undefined,
          },
        })
      ).data.data,
    placeholderData: (previous) => previous,
  });
  const summary = useQuery({
    queryKey: ["goods-receipts", "summary"],
    queryFn: async () => (await http.get<Envelope<GoodsReceiptSummary>>("/goods-receipts/summary")).data.data,
  });
  const suppliers = useQuery({
    queryKey: ["receipt-suppliers"],
    queryFn: async () => (await http.get<Envelope<Paged<SupplierListItem>>>("/suppliers", { params: { page: 1, limit: 100 } })).data.data.items,
  });

  const items = list.data?.items ?? [];
  const total = list.data?.pagination.total ?? 0;
  const hasFilter = Boolean(status || supplierId || range || term);
  // Khi panel chi tiết mở, bảng hẹp lại: gộp nhà cung cấp vào cột mã phiếu, ẩn số mặt hàng.
  const compact = openId !== null;

  function resetPage() {
    setPage(1);
    setSelectedKeys([]);
  }

  async function refreshAll(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["goods-receipts"] });
  }

  function openWith(id: string, action: PanelAction | null) {
    setOpenId(id);
    setPendingAction(action);
  }

  return (
    <div>
      <PageHeader
        icon={<InboxOutlined />}
        title="Nhập hàng"
        description="Quản lý phiếu nhập hàng từ nhà cung cấp, kiểm tra hàng hóa và nhập kho."
        extra={
          <>
            <ExcelExportButton type="goods-receipts" range={rangeParams(range)} tooltip={range ? "Xuất phiếu nhập trong khoảng ngày đang lọc" : "Xuất phiếu nhập 30 ngày gần nhất"} />
            {canCreate ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                Tạo phiếu nhập
              </Button>
            ) : null}
          </>
        }
      />

      <StatGrid>
        <StatCard tone="orange" icon={<ClockCircleOutlined />} label="Phiếu chờ kiểm nhập" value={formatNumber(summary.data?.draftCount)} loading={summary.isLoading} hint="Phiếu nháp chưa cộng tồn kho" />
        <StatCard
          tone="blue"
          icon={<FileDoneOutlined />}
          label="Đã nhập kho tháng này"
          value={formatNumber(summary.data?.confirmedCount)}
          loading={summary.isLoading}
          hint={summary.data ? <Trend value={summary.data.confirmedCountChangePercent} suffix="so với tháng trước" /> : null}
        />
        <StatCard
          tone="purple"
          icon={<DollarCircleOutlined />}
          label="Giá trị nhập hàng tháng này"
          value={formatVnd(summary.data?.confirmedValue)}
          loading={summary.isLoading}
          hint={summary.data ? <Trend value={summary.data.confirmedValueChangePercent} suffix="so với tháng trước" /> : null}
        />
      </StatGrid>

      <div className={openId ? "split-layout" : undefined}>
        <div className="detail-stack">
          <Card className="filter-card">
            <div className="filter-bar">
              <label className="field">
                <span>Nhà cung cấp</span>
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder="Tất cả nhà cung cấp"
                  loading={suppliers.isLoading}
                  value={supplierId}
                  onChange={(value) => {
                    setSupplierId(value);
                    resetPage();
                  }}
                  options={(suppliers.data ?? []).map((item) => ({ value: item.id, label: item.name }))}
                />
              </label>
              <label className="field">
                <span>Thời gian nhập</span>
                <DatePicker.RangePicker
                  value={range}
                  format="DD/MM/YYYY"
                  placeholder={["Từ ngày", "Đến ngày"]}
                  onChange={(value) => {
                    setRange(value && value[0] && value[1] ? [value[0], value[1]] : null);
                    resetPage();
                  }}
                />
              </label>
              <label className="field">
                <span>Trạng thái</span>
                <Select
                  allowClear
                  placeholder="Tất cả trạng thái"
                  value={status}
                  onChange={(value) => {
                    setStatus(value);
                    resetPage();
                  }}
                  options={Object.entries(STATUS).map(([value, info]) => ({ value, label: info.text }))}
                />
              </label>
              <div className="filter-actions">
                {hasFilter ? (
                  <Button
                    type="link"
                    onClick={() => {
                      setStatus(undefined);
                      setSupplierId(undefined);
                      setRange(null);
                      setSearch("");
                      resetPage();
                    }}
                  >
                    Xóa lọc
                  </Button>
                ) : null}
                <Button icon={<ReloadOutlined spin={list.isFetching} />} onClick={() => void refreshAll()}>
                  Làm mới
                </Button>
              </div>
            </div>
          </Card>

          <Card
            title={
              <span>
                Danh sách phiếu nhập <span className="text-secondary">({formatNumber(total)})</span>
              </span>
            }
            extra={<Input allowClear prefix={<SearchOutlined />} placeholder="Tìm theo mã phiếu, nhà cung cấp, số HĐ…" className="card-search" value={search} onChange={(event) => { setSearch(event.target.value); resetPage(); }} />}
          >
            {selectedKeys.length > 0 ? (
              <div className="bulk-bar">
                <span>
                  Đã chọn <strong>{selectedKeys.length}</strong> phiếu
                </span>
                <Button size="small" icon={<DownloadOutlined />} onClick={() => downloadCsv(`phieu-nhap-${vnDateKey()}.csv`, items.filter((item) => selectedKeys.includes(item.id)))}>
                  Xuất CSV
                </Button>
                <Button size="small" type="text" onClick={() => setSelectedKeys([])}>
                  Bỏ chọn
                </Button>
              </div>
            ) : null}
            <Table
              rowKey="id"
              className="compact-cells"
              tableLayout="fixed"
              loading={list.isFetching}
              dataSource={items}
              scroll={{ x: compact ? 600 : 900 }}
              rowSelection={{ selectedRowKeys: selectedKeys, onChange: (keys) => setSelectedKeys(keys as string[]), columnWidth: 44 }}
              onRow={(row) => ({ onClick: () => openWith(row.id, null), style: { cursor: "pointer" } })}
              rowClassName={(row) => (row.id === openId ? "row-selected" : "")}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={hasFilter ? "Không có phiếu nào khớp bộ lọc" : "Chưa có phiếu nhập nào"} /> }}
              onChange={(_, __, sorter) => {
                const single = Array.isArray(sorter) ? sorter[0] : sorter;
                if (single?.order && (single.columnKey === "receivedAt" || single.columnKey === "totalCost")) {
                  setSort({ sortBy: single.columnKey, order: single.order === "ascend" ? "asc" : "desc" });
                } else {
                  setSort({ sortBy: "receivedAt", order: "desc" });
                }
              }}
              pagination={{
                current: page,
                pageSize,
                total,
                showSizeChanger: true,
                pageSizeOptions: [10, 20, 50],
                onChange: (nextPage, nextSize) => {
                  if (nextSize !== pageSize) {
                    setPageSize(nextSize);
                    setPage(1);
                  } else setPage(nextPage);
                },
                showTotal: (count, [start, end]) => `${start} – ${end} của ${formatNumber(count)} phiếu`,
              }}
              columns={[
                {
                  title: compact ? "Mã phiếu · Nhà cung cấp" : "Mã phiếu",
                  key: "code",
                  width: compact ? undefined : 160,
                  render: (_: unknown, row: GoodsReceiptListItem) => {
                    const parts = row.code.split("-");
                    const main = parts.length >= 3 ? parts.slice(2).join("-") : row.code;
                    const prefix = parts.length >= 3 ? parts.slice(0, 2).join("-") : null;
                    return (
                      <span className="doc-code-stack" title={row.code}>
                        <Typography.Link
                          className="doc-link"
                          onClick={(event) => {
                            event.stopPropagation();
                            openWith(row.id, null);
                          }}
                        >
                          {main}
                        </Typography.Link>
                        <span>{compact ? row.supplierName ?? "Không có NCC" : prefix}</span>
                      </span>
                    );
                  },
                },
                ...(compact
                  ? []
                  : [{ title: "Nhà cung cấp", key: "supplier", ellipsis: true, render: (_: unknown, row: GoodsReceiptListItem) => row.supplierName ?? <span className="text-secondary">Không có NCC</span> }]),
                {
                  title: "Ngày nhập",
                  key: "receivedAt",
                  width: 120,
                  sorter: true,
                  sortOrder: sort.sortBy === "receivedAt" ? (sort.order === "asc" ? "ascend" : "descend") : null,
                  render: (_: unknown, row: GoodsReceiptListItem) => formatDate(row.receivedAt),
                },
                ...(compact ? [] : [{ title: "Số mặt hàng", key: "lines", width: 110, align: "right" as const, render: (_: unknown, row: GoodsReceiptListItem) => formatNumber(row.lineCount) }]),
                {
                  title: "Tổng tiền",
                  key: "totalCost",
                  width: 140,
                  align: "right",
                  sorter: true,
                  sortOrder: sort.sortBy === "totalCost" ? (sort.order === "asc" ? "ascend" : "descend") : null,
                  render: (_: unknown, row: GoodsReceiptListItem) => <strong>{formatVnd(row.totalCost)}</strong>,
                },
                { title: "Trạng thái", key: "status", width: 130, render: (_: unknown, row: GoodsReceiptListItem) => <StatusTag status={row.status} /> },
                {
                  title: "Thao tác",
                  key: "actions",
                  width: 84,
                  align: "center",
                  fixed: "right",
                  render: (_: unknown, row: GoodsReceiptListItem) => {
                    const draft = row.status === "DRAFT";
                    return (
                      <span onClick={(event) => event.stopPropagation()}>
                        <Dropdown
                          trigger={["click"]}
                          placement="bottomRight"
                          menu={{
                            items: [
                              { key: "view", icon: <EyeOutlined />, label: "Xem chi tiết" },
                              { key: "lines", icon: <AppstoreOutlined />, label: "Xem chi tiết hàng hóa" },
                              { key: "preview", icon: <FileSearchOutlined />, label: "Xem trước bản in" },
                              { key: "print", icon: <PrinterOutlined />, label: "In phiếu nhập" },
                              ...(draft
                                ? [
                                    { type: "divider" as const },
                                    { key: "inspect", icon: <SafetyCertificateOutlined />, label: "Kiểm nhập & xác nhận", disabled: !canConfirm },
                                    { key: "edit", icon: <EditOutlined />, label: "Sửa phiếu", disabled: !canCreate },
                                    { key: "cancel", icon: <CloseCircleOutlined />, label: "Hủy phiếu", danger: canConfirm, disabled: !canConfirm },
                                  ]
                                : []),
                            ],
                            onClick: ({ key, domEvent }) => {
                              domEvent.stopPropagation();
                              if (key === "preview") setPreviewing({ id: row.id, code: row.code });
                              else if (key === "print") void printDocument(printUrl.goodsReceipt(row.id), message);
                              else openWith(row.id, key === "view" ? null : (key as PanelAction));
                            },
                          }}
                        >
                          <Button type="text" className="more-btn" icon={<MoreOutlined />} aria-label={`Thao tác với ${row.code}`} />
                        </Dropdown>
                      </span>
                    );
                  },
                },
              ]}
            />
          </Card>
        </div>

        {openId ? (
          <aside className="split-aside">
            <ReceiptDetailPanel
              receiptId={openId}
              pendingAction={pendingAction}
              onActionHandled={() => setPendingAction(null)}
              onClose={() => setOpenId(null)}
              onChanged={refreshAll}
            />
          </aside>
        ) : null}
      </div>

      <ReceiptFormModal
        open={creating}
        receipt={null}
        onClose={() => setCreating(false)}
        onSaved={async (id, options) => {
          setCreating(false);
          await refreshAll();
          openWith(id, options.inspect ? "inspect" : null);
        }}
      />
      <PrintPreviewModal
        url={previewing ? printUrl.goodsReceipt(previewing.id) : null}
        title={`Xem trước phiếu nhập ${previewing?.code ?? ""}`}
        onClose={() => setPreviewing(null)}
      />
    </div>
  );
}

type PanelAction = "lines" | "inspect" | "edit" | "cancel";

/** Kiểm tra trước khi kiểm nhập: chỉ dựa trên dữ liệu đã nhập ở phiếu, không thay cho kiểm tra cảm quan thực tế. */
function draftChecks(receipt: GoodsReceiptDetail) {
  const lines = receipt.lines;
  const today = vnDateKey();
  const hasBatch = lines.filter((line) => line.batchNumber.trim().length > 0).length;
  const notExpired = lines.filter((line) => line.expiryDate.slice(0, 10) > today).length;
  const longEnough = lines.filter((line) => daysUntil(line.expiryDate) > 90).length;
  const hasCost = lines.filter((line) => line.quantity > 0 && line.unitCost > 0).length;
  const ready = lines.filter((line) => line.batchNumber.trim() && line.expiryDate.slice(0, 10) > today && line.quantity > 0 && line.unitCost > 0).length;
  return {
    ready,
    items: [
      { label: "Đủ số lô cho từng dòng", done: hasBatch === lines.length, detail: `${hasBatch}/${lines.length}` },
      { label: "Hạn dùng chưa qua", done: notExpired === lines.length, detail: `${notExpired}/${lines.length}` },
      { label: "Có số lượng và giá nhập", done: hasCost === lines.length, detail: `${hasCost}/${lines.length}` },
      { label: "Hạn dùng còn trên 90 ngày", done: longEnough === lines.length, detail: `${longEnough}/${lines.length}`, warnOnly: true },
    ],
  };
}

function ReceiptDetailPanel({
  receiptId,
  pendingAction,
  onActionHandled,
  onClose,
  onChanged,
}: {
  receiptId: string;
  pendingAction: PanelAction | null;
  onActionHandled: () => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [viewingLines, setViewingLines] = useState(false);
  const [previewingPrint, setPreviewingPrint] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const keys = useRef<Record<string, string>>({});
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ["goods-receipt", receiptId],
    queryFn: async () => (await http.get<Envelope<GoodsReceiptDetail>>(`/goods-receipts/${receiptId}`)).data.data,
  });
  const receipt = detail.data;

  // Thao tác chọn từ menu ba chấm ở bảng: hộp thoại tương ứng mở khi dữ liệu phiếu đã tải xong.
  const pending = receipt && receipt.id === receiptId ? pendingAction : null;
  const pendingOnDraft = receipt?.status === "DRAFT" ? pending : null;
  const linesOpen = viewingLines || pending === "lines";
  const inspectOpen = inspecting || pendingOnDraft === "inspect";
  const editOpen = editing || pendingOnDraft === "edit";
  const cancelOpen = cancelling || pendingOnDraft === "cancel";
  function closeDialogs() {
    setViewingLines(false);
    setInspecting(false);
    setEditing(false);
    setCancelling(false);
    if (pendingAction) onActionHandled();
  }

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
      closeDialogs();
      setCancelReason("");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không hủy được phiếu nhập")),
  });

  if (detail.isLoading || !receipt) {
    return (
      <Card>
        <Skeleton active paragraph={{ rows: 10 }} />
      </Card>
    );
  }

  const isDraft = receipt.status === "DRAFT";
  const checks = isDraft ? draftChecks(receipt) : null;
  const quarantined = receipt.lines.filter((line) => line.batchStatus === "QUARANTINED").length;
  const available = receipt.lines.filter((line) => line.batchStatus === "AVAILABLE").length;
  const progressDone = checks ? checks.ready : available;
  const lineCount = receipt.lines.length;

  return (
    <>
      <Card
        className="receipt-panel"
        title={
          <span className="panel-title">
            <FileTextOutlined /> Chi tiết phiếu nhập
          </span>
        }
        extra={
          <span className="row-actions">
            <StatusTag status={receipt.status} />
            <Button type="text" size="small" onClick={onClose}>
              Đóng
            </Button>
          </span>
        }
      >
        <div className="detail-stack">
          <div className="receipt-head">
            <strong>{receipt.code}</strong>
            <span>{formatDateTime(receipt.receivedAt)}</span>
          </div>

          <section className="panel-section">
            <h4>
              <ShopOutlined /> Thông tin nhà cung cấp
            </h4>
            {receipt.supplier ? (
              <dl className="kv-list">
                <div className="kv-strong">
                  <dt>Tên</dt>
                  <dd>{receipt.supplier.name}</dd>
                </div>
                <div>
                  <dt>Mã số thuế</dt>
                  <dd>{receipt.supplier.taxCode ?? "—"}</dd>
                </div>
                <div>
                  <dt>Điện thoại</dt>
                  <dd>{receipt.supplier.phone ?? "—"}</dd>
                </div>
                <div>
                  <dt>Địa chỉ</dt>
                  <dd>{receipt.supplier.address ?? "—"}</dd>
                </div>
              </dl>
            ) : (
              <Typography.Text type="secondary">Phiếu không gắn nhà cung cấp (ví dụ tồn đầu kỳ).</Typography.Text>
            )}
          </section>

          <section className="panel-section">
            <h4>
              <FileTextOutlined /> Thông tin hóa đơn &amp; xử lý
            </h4>
            <dl className="kv-list">
              <div>
                <dt>Số hóa đơn NCC</dt>
                <dd>{receipt.supplierInvoiceNumber ?? "—"}</dd>
              </div>
              <div>
                <dt>Ngày hóa đơn</dt>
                <dd>{formatDate(receipt.supplierInvoiceDate)}</dd>
              </div>
              <div>
                <dt>Tổng giá trị</dt>
                <dd>
                  <strong>{formatVnd(receipt.totalCost)}</strong> · {lineCount} mặt hàng
                </dd>
              </div>
              {receipt.discountAmount || receipt.vatAmount ? (
                <div>
                  <dt>Tiền hàng / CK / thuế</dt>
                  <dd>
                    {formatVnd(receipt.goodsAmount)} − {formatVnd(receipt.discountAmount)} + {formatVnd(receipt.vatAmount)}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>Người lập</dt>
                <dd>{receipt.createdBy ? `${receipt.createdBy.fullName}${receipt.createdAt ? ` · ${formatDateTime(receipt.createdAt)}` : ""}` : "—"}</dd>
              </div>
              {receipt.status === "CONFIRMED" ? (
                <div>
                  <dt>Người kiểm nhập</dt>
                  <dd>{receipt.confirmedBy ? `${receipt.confirmedBy.fullName} · ${formatDateTime(receipt.confirmedAt)}` : formatDateTime(receipt.confirmedAt)}</dd>
                </div>
              ) : null}
              {receipt.status === "CANCELLED" ? (
                <div>
                  <dt>Đã hủy</dt>
                  <dd className="text-danger">
                    {receipt.cancelReason ?? "—"}
                    {receipt.cancelledBy ? ` · ${receipt.cancelledBy.fullName}` : ""}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>Ghi chú</dt>
                <dd>{receipt.note ?? "—"}</dd>
              </div>
            </dl>
          </section>

          {receipt.status !== "CANCELLED" && lineCount > 0 ? (
            <section className="panel-section">
              <h4 className="panel-section-row">
                <span>
                  <SafetyCertificateOutlined /> {isDraft ? "Kiểm tra lô – hạn dùng" : "Kết quả nhập kho"}
                </span>
                <span className="text-secondary">
                  {progressDone}/{lineCount}
                </span>
              </h4>
              <Progress percent={Math.round((progressDone / lineCount) * 100)} showInfo={false} strokeColor={progressDone === lineCount ? "var(--tone-green)" : "var(--tone-orange)"} />
              <ul className="check-list">
                {checks
                  ? checks.items.map((item) => (
                      <li key={item.label} className={item.done ? "done" : item.warnOnly ? "warn" : "fail"}>
                        {item.done ? <CheckCircleFilled /> : <ExclamationCircleFilled />}
                        <span>{item.label}</span>
                        <em>{item.detail}</em>
                      </li>
                    ))
                  : [
                      <li key="ok" className="done">
                        <CheckCircleFilled />
                        <span>Lô đang bán được</span>
                        <em>{available}/{lineCount}</em>
                      </li>,
                      <li key="q" className={quarantined > 0 ? "warn" : "done"}>
                        {quarantined > 0 ? <ExclamationCircleFilled /> : <CheckCircleFilled />}
                        <span>Lô đang biệt trữ</span>
                        <em>{quarantined}</em>
                      </li>,
                    ]}
              </ul>
              {isDraft ? <p className="section-note">Đây là kiểm tra dữ liệu trên phiếu. Kiểm tra cảm quan thực tế làm ở bước “Kiểm nhập & xác nhận”.</p> : null}
            </section>
          ) : null}

          <div className="panel-actions">
            {isDraft ? (
              <Button type="primary" size="large" block icon={<SafetyCertificateOutlined />} disabled={!can("goods_receipt.confirm")} onClick={() => setInspecting(true)}>
                Kiểm nhập &amp; xác nhận
              </Button>
            ) : null}
            <Button size="large" block icon={<AppstoreOutlined />} onClick={() => setViewingLines(true)}>
              Xem chi tiết hàng hóa
            </Button>
            <div className="panel-actions-row">
              <Button icon={<FileSearchOutlined />} onClick={() => setPreviewingPrint(true)}>
                Xem trước bản in
              </Button>
              <Button icon={<PrinterOutlined />} onClick={() => void printDocument(printUrl.goodsReceipt(receipt.id), message)}>
                In phiếu nhập
              </Button>
            </div>
            {isDraft ? (
              <div className="panel-actions-row">
                <Button icon={<EditOutlined />} disabled={!can("goods_receipt.create")} onClick={() => setEditing(true)}>
                  Sửa phiếu
                </Button>
                <Button danger icon={<CloseCircleOutlined />} disabled={!can("goods_receipt.confirm")} onClick={() => setCancelling(true)}>
                  Hủy phiếu
                </Button>
              </div>
            ) : null}
            {receipt.status === "CONFIRMED" && can("stock.read") ? (
              <Button type="link" icon={<DatabaseOutlined />} onClick={() => void navigate("/ton-kho")}>
                Xem tồn kho sau nhập
              </Button>
            ) : null}
          </div>
        </div>
      </Card>

      <ReceiptLinesModal open={linesOpen} receipt={receipt} onClose={closeDialogs} />
      <PrintPreviewModal url={previewingPrint ? printUrl.goodsReceipt(receipt.id) : null} title={`Xem trước phiếu nhập ${receipt.code}`} onClose={() => setPreviewingPrint(false)} />
      <ReceiptFormModal
        open={editOpen}
        receipt={receipt}
        onClose={closeDialogs}
        onSaved={async (_id, options) => {
          closeDialogs();
          await refresh();
          if (options.inspect) setInspecting(true);
        }}
      />
      <InspectionModal
        open={inspectOpen}
        receipt={receipt}
        getIdempotencyKey={() => keyFor("confirm")}
        onClose={closeDialogs}
        onConfirmed={async () => {
          closeDialogs();
          await refresh();
        }}
      />
      <Modal
        open={cancelOpen}
        title={`Hủy phiếu ${receipt.code}`}
        okText="Hủy phiếu"
        cancelText="Đóng"
        onOk={() => cancel.mutate()}
        onCancel={closeDialogs}
        confirmLoading={cancel.isPending}
        okButtonProps={{ danger: true, disabled: cancelReason.trim().length === 0 }}
      >
        <Typography.Paragraph type="secondary">Phiếu hủy được giữ lại để tra cứu, không ảnh hưởng tồn kho.</Typography.Paragraph>
        <Input.TextArea rows={3} placeholder="Lý do hủy phiếu (bắt buộc)" value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} />
      </Modal>
    </>
  );
}

function ReceiptLinesModal({ open, receipt, onClose }: { open: boolean; receipt: GoodsReceiptDetail; onClose: () => void }) {
  const BATCH_STATUS: Record<string, { text: string; color: string }> = {
    AVAILABLE: { text: "Bán được", color: "green" },
    QUARANTINED: { text: "Biệt trữ", color: "orange" },
    RECALLED: { text: "Thu hồi", color: "red" },
  };
  return (
    <Modal open={open} onCancel={onClose} footer={null} width={1040} title={`Hàng hóa trong phiếu ${receipt.code}`}>
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={receipt.lines}
        scroll={{ x: 960, y: 460 }}
        summary={() => (
          <Table.Summary fixed>
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={6}>
                <strong>Tổng cộng {receipt.lines.length} mặt hàng</strong>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">
                <strong>{formatVnd(receipt.totalCost)}</strong>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={2} />
            </Table.Summary.Row>
          </Table.Summary>
        )}
        columns={[
          {
            title: "Sản phẩm",
            key: "product",
            width: 230,
            render: (_: unknown, line: GoodsReceiptLine) => (
              <div className="cell-main">
                <strong>{line.productName}</strong>
                <span>{line.productCode}</span>
              </div>
            ),
          },
          { title: "Số lô", dataIndex: "batchNumber", width: 120 },
          { title: "NSX", key: "mfg", width: 100, render: (_: unknown, line: GoodsReceiptLine) => formatDate(line.manufactureDate) },
          { title: "HSD", key: "exp", width: 100, render: (_: unknown, line: GoodsReceiptLine) => formatDate(line.expiryDate) },
          { title: "Số lượng", key: "qty", width: 110, align: "right", render: (_: unknown, line: GoodsReceiptLine) => `${formatNumber(line.quantity)} ${line.unitName}` },
          { title: "Giá nhập", key: "cost", width: 110, align: "right", render: (_: unknown, line: GoodsReceiptLine) => formatVnd(line.unitCost) },
          { title: "Thành tiền", key: "lineCost", width: 120, align: "right", render: (_: unknown, line: GoodsReceiptLine) => <strong>{formatVnd(line.lineCost)}</strong> },
          {
            title: "Lô trong kho",
            key: "batch",
            width: 130,
            render: (_: unknown, line: GoodsReceiptLine) => (line.batchStatus ? <Tag color={BATCH_STATUS[line.batchStatus]?.color}>{BATCH_STATUS[line.batchStatus]?.text}</Tag> : <span className="text-secondary">Chưa nhập kho</span>),
          },
        ]}
      />
    </Modal>
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

function StatusTag({ status }: { status: GoodsReceiptDetail["status"] }) {
  const item = STATUS[status];
  return <Tag color={item.color}>{item.text}</Tag>;
}
