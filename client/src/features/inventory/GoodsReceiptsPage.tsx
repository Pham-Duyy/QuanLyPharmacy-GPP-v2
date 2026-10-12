import {
  AppstoreOutlined,
  CloseCircleOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeOutlined,
  FileSearchOutlined,
  InboxOutlined,
  MoreOutlined,
  PlusOutlined,
  PrinterOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Dropdown,
  Empty,
  Input,
  Select,
  Table,
  Typography,
} from "antd";
import type { Dayjs } from "dayjs";
import { useState } from "react";
import { http } from "../../api/http.js";
import {
  formatVnd,
  type Envelope,
  type GoodsReceiptDetail,
  type GoodsReceiptListItem,
  type GoodsReceiptSummary,
  type Paged,
  type SupplierListItem,
} from "../../api/types.js";
import { formatDate, formatNumber, vnDateKey } from "../../ui/format.js";
import { ExcelExportButton } from "../excel/ExcelButtons.js";
import { rangeParams } from "../excel/excel-api.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/auth-context.js";
import { printDocument, printUrl } from "../printing/printing.js";
import { PrintPreviewModal } from "../printing/PrintPreviewModal.js";
import { ReceiptFormModal } from "./ReceiptFormModal.js";
import { ReceiptDetailPanel, type PanelAction } from "./receipts/ReceiptDetailPanel.js";
import { STATUS } from "./receipts/receipt-status.js";
import { StatusTag } from "./receipts/StatusTag.js";

type SortState = { sortBy: "receivedAt" | "totalCost"; order: "asc" | "desc" };

/** Xuất CSV từ các dòng đang chọn, không gọi thêm API. */
function downloadCsv(filename: string, rows: GoodsReceiptListItem[]): void {
  const header = [
    "Mã phiếu",
    "Nhà cung cấp",
    "Ngày nhập",
    "Số mặt hàng",
    "Tổng tiền",
    "Trạng thái",
  ];
  const body = rows.map((row) => [
    row.code,
    row.supplierName ?? "",
    formatDate(row.receivedAt),
    row.lineCount,
    row.totalCost,
    STATUS[row.status].text,
  ]);
  const csv = [header, ...body]
    .map((cells) => cells.map((cell) => JSON.stringify(String(cell))).join(","))
    .join("\n");
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
    queryKey: [
      "goods-receipts",
      page,
      pageSize,
      status,
      supplierId,
      term,
      sort,
      range?.[0].format("YYYY-MM-DD"),
      range?.[1].format("YYYY-MM-DD"),
    ],
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
    queryFn: async () =>
      (await http.get<Envelope<GoodsReceiptSummary>>("/goods-receipts/summary")).data.data,
  });
  const suppliers = useQuery({
    queryKey: ["receipt-suppliers"],
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<SupplierListItem>>>("/suppliers", {
          params: { page: 1, limit: 100 },
        })
      ).data.data.items,
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
        extra={
          <>
            <ExcelExportButton
              type="goods-receipts"
              range={rangeParams(range)}
              tooltip={
                range
                  ? "Xuất phiếu nhập trong khoảng ngày đang lọc"
                  : "Xuất phiếu nhập 30 ngày gần nhất"
              }
            />
            {canCreate ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                Tạo phiếu nhập
              </Button>
            ) : null}
          </>
        }
      />

      {/* Chỉ nhắc việc cần làm; số liệu nhập hàng theo tháng xem ở Báo cáo. */}
      {(summary.data?.draftCount ?? 0) > 0 && status !== "DRAFT" ? (
        <Alert
          type="warning"
          showIcon
          className="count-banner"
          title={`${formatNumber(summary.data!.draftCount)} phiếu chờ kiểm nhập — chưa cộng tồn kho`}
          action={
            <Button
              size="small"
              onClick={() => {
                setStatus("DRAFT");
                resetPage();
              }}
            >
              Xem
            </Button>
          }
        />
      ) : null}

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
                  options={(suppliers.data ?? []).map((item) => ({
                    value: item.id,
                    label: item.name,
                  }))}
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
                  options={Object.entries(STATUS).map(([value, info]) => ({
                    value,
                    label: info.text,
                  }))}
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
                <Button
                  icon={<ReloadOutlined spin={list.isFetching} />}
                  onClick={() => void refreshAll()}
                >
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
            extra={
              <Input
                allowClear
                prefix={<SearchOutlined />}
                placeholder="Tìm theo mã phiếu, nhà cung cấp, số HĐ…"
                className="card-search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  resetPage();
                }}
              />
            }
          >
            {selectedKeys.length > 0 ? (
              <div className="bulk-bar">
                <span>
                  Đã chọn <strong>{selectedKeys.length}</strong> phiếu
                </span>
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  onClick={() =>
                    downloadCsv(
                      `phieu-nhap-${vnDateKey()}.csv`,
                      items.filter((item) => selectedKeys.includes(item.id)),
                    )
                  }
                >
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
              rowSelection={{
                selectedRowKeys: selectedKeys,
                onChange: (keys) => setSelectedKeys(keys as string[]),
                columnWidth: 44,
              }}
              onRow={(row) => ({
                onClick: () => openWith(row.id, null),
                style: { cursor: "pointer" },
              })}
              rowClassName={(row) => (row.id === openId ? "row-selected" : "")}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={
                      hasFilter ? "Không có phiếu nào khớp bộ lọc" : "Chưa có phiếu nhập nào"
                    }
                  />
                ),
              }}
              onChange={(_, __, sorter) => {
                const single = Array.isArray(sorter) ? sorter[0] : sorter;
                if (
                  single?.order &&
                  (single.columnKey === "receivedAt" || single.columnKey === "totalCost")
                ) {
                  setSort({
                    sortBy: single.columnKey,
                    order: single.order === "ascend" ? "asc" : "desc",
                  });
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
                showTotal: (count, [start, end]) =>
                  `${start} – ${end} của ${formatNumber(count)} phiếu`,
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
                        <span>{compact ? (row.supplierName ?? "Không có NCC") : prefix}</span>
                      </span>
                    );
                  },
                },
                ...(compact
                  ? []
                  : [
                      {
                        title: "Nhà cung cấp",
                        key: "supplier",
                        ellipsis: true,
                        render: (_: unknown, row: GoodsReceiptListItem) =>
                          row.supplierName ?? <span className="text-secondary">Không có NCC</span>,
                      },
                    ]),
                {
                  title: "Ngày nhập",
                  key: "receivedAt",
                  width: 120,
                  sorter: true,
                  sortOrder:
                    sort.sortBy === "receivedAt"
                      ? sort.order === "asc"
                        ? "ascend"
                        : "descend"
                      : null,
                  render: (_: unknown, row: GoodsReceiptListItem) => formatDate(row.receivedAt),
                },
                ...(compact
                  ? []
                  : [
                      {
                        title: "Số mặt hàng",
                        key: "lines",
                        width: 110,
                        align: "right" as const,
                        render: (_: unknown, row: GoodsReceiptListItem) =>
                          formatNumber(row.lineCount),
                      },
                    ]),
                {
                  title: "Tổng tiền",
                  key: "totalCost",
                  width: 140,
                  align: "right",
                  sorter: true,
                  sortOrder:
                    sort.sortBy === "totalCost"
                      ? sort.order === "asc"
                        ? "ascend"
                        : "descend"
                      : null,
                  render: (_: unknown, row: GoodsReceiptListItem) => (
                    <strong>{formatVnd(row.totalCost)}</strong>
                  ),
                },
                {
                  title: "Trạng thái",
                  key: "status",
                  width: 130,
                  render: (_: unknown, row: GoodsReceiptListItem) => (
                    <StatusTag status={row.status} />
                  ),
                },
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
                              {
                                key: "lines",
                                icon: <AppstoreOutlined />,
                                label: "Xem chi tiết hàng hóa",
                              },
                              {
                                key: "preview",
                                icon: <FileSearchOutlined />,
                                label: "Xem trước bản in",
                              },
                              { key: "print", icon: <PrinterOutlined />, label: "In phiếu nhập" },
                              ...(draft
                                ? [
                                    { type: "divider" as const },
                                    {
                                      key: "inspect",
                                      icon: <SafetyCertificateOutlined />,
                                      label: "Kiểm nhập & xác nhận",
                                      disabled: !canConfirm,
                                    },
                                    {
                                      key: "edit",
                                      icon: <EditOutlined />,
                                      label: "Sửa phiếu",
                                      disabled: !canCreate,
                                    },
                                    {
                                      key: "cancel",
                                      icon: <CloseCircleOutlined />,
                                      label: "Hủy phiếu",
                                      danger: canConfirm,
                                      disabled: !canConfirm,
                                    },
                                  ]
                                : []),
                            ],
                            onClick: ({ key, domEvent }) => {
                              domEvent.stopPropagation();
                              if (key === "preview") setPreviewing({ id: row.id, code: row.code });
                              else if (key === "print")
                                void printDocument(printUrl.goodsReceipt(row.id), message);
                              else openWith(row.id, key === "view" ? null : (key as PanelAction));
                            },
                          }}
                        >
                          <Button
                            type="text"
                            className="more-btn"
                            icon={<MoreOutlined />}
                            aria-label={`Thao tác với ${row.code}`}
                          />
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
