import { DollarCircleOutlined, EyeOutlined, FileSearchOutlined, FileTextOutlined, MoreOutlined, PlusOutlined, PrinterOutlined, RollbackOutlined, StopOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Card, DatePicker, Dropdown, Empty, Input, Modal, Segmented, Skeleton, Table, Tag, Typography } from "antd";
import type { Dayjs } from "dayjs";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { getErrorMessage, http } from "../../api/http.js";
import { formatVnd, type DashboardData, type Envelope, type Invoice, type InvoiceListItem, type Paged } from "../../api/types.js";
import { formatDate, formatDateTime, formatNumber, vnDateKey } from "../../ui/format.js";
import { paymentMethodLabel } from "../../ui/labels.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { StatCard, StatGrid, Trend } from "../../ui/StatCard.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";
import { printInvoice } from "./print-invoice.js";
import { ReturnModal } from "./ReturnModal.js";

type StatusFilter = "ALL" | "COMPLETED" | "VOIDED";

const RETURN_STATUS: Record<string, { text: string; color: string } | undefined> = {
  PARTIAL: { text: "Trả một phần", color: "gold" },
  FULL: { text: "Đã trả hết", color: "purple" },
};

/** Sáu cột dữ liệu chia đều phần còn lại sau cột thao tác (88px). */
const COLUMN_WIDTH = "calc((100% - 88px) / 6)";

/**
 * Hóa đơn không có sửa/xóa (contract §14): "sửa" là nhận trả hàng, "xóa" là hủy có lý do
 * và hoàn tồn về lô. Nút không dùng được vẫn hiện nhưng khóa, kèm lý do.
 */
function InvoiceRowActions({
  row,
  canReturn,
  canVoid,
  onView,
  onReturn,
  onVoid,
}: {
  row: InvoiceListItem;
  canReturn: boolean;
  canVoid: boolean;
  onView: () => void;
  onReturn: () => void;
  onVoid: () => void;
}) {
  const completed = row.status === "COMPLETED";
  const returnBlock = !canReturn ? "Vai trò không có quyền nhận trả hàng" : !completed ? "Hóa đơn đã hủy" : row.returnStatus === "FULL" ? "Hóa đơn đã trả hết" : null;
  // Máy chủ mới là nơi quyết định; ở đây chỉ khóa sớm theo quy tắc hủy trong ngày bán.
  const voidBlock = !canVoid
    ? "Vai trò không có quyền hủy hóa đơn"
    : !completed
      ? "Hóa đơn đã hủy"
      : row.returnStatus !== "NONE"
        ? "Hóa đơn đã có phiếu trả, không hủy được"
        : vnDateKey(new Date(row.soldAt)) !== vnDateKey()
          ? "Chỉ hủy được hóa đơn trong ngày bán"
          : null;

  const withReason = (label: string, reason: string | null) =>
    reason ? (
      <span className="menu-item-stack">
        {label}
        <small>{reason}</small>
      </span>
    ) : (
      label
    );

  return (
    <span onClick={(event) => event.stopPropagation()}>
      <Dropdown
        trigger={["click"]}
        placement="bottomRight"
        menu={{
          items: [
            { key: "view", icon: <EyeOutlined />, label: "Xem chi tiết" },
            { key: "k80", icon: <PrinterOutlined />, label: "In khổ K80" },
            { key: "a5", icon: <PrinterOutlined />, label: "In khổ A5" },
            { type: "divider" },
            { key: "return", icon: <RollbackOutlined />, label: withReason("Nhận trả hàng", returnBlock), disabled: returnBlock !== null },
            { key: "void", icon: <StopOutlined />, label: withReason("Hủy hóa đơn", voidBlock), danger: voidBlock === null, disabled: voidBlock !== null },
          ],
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation();
            if (key === "view") onView();
            if (key === "k80" || key === "a5") void printInvoice(row.id, key);
            if (key === "return") onReturn();
            if (key === "void") onVoid();
          },
        }}
      >
        <Button type="text" className="more-btn" icon={<MoreOutlined />} aria-label={`Thao tác với ${row.code}`} />
      </Dropdown>
    </span>
  );
}

/** Số hóa đơn dạng HD-NT01-20260915-0003: tách tiền tố cửa hàng xuống dòng phụ để cột hẹp vẫn đọc đủ. */
function DocCode({ code }: { code: string }) {
  const parts = code.split("-");
  if (parts.length < 3) return <strong className="doc-code">{code}</strong>;
  return (
    <span className="doc-code-stack" title={code}>
      <strong>{parts.slice(2).join("-")}</strong>
      <span>{parts.slice(0, 2).join("-")}</span>
    </span>
  );
}

function StatusTags({ status, returnStatus }: { status: string; returnStatus: string }) {
  const returned = RETURN_STATUS[returnStatus];
  return (
    <>
      {status === "VOIDED" ? <Tag color="red">Đã hủy</Tag> : <Tag color="green">Hoàn tất</Tag>}
      {returned ? <Tag color={returned.color}>{returned.text}</Tag> : null}
    </>
  );
}

export function InvoicesPage() {
  const { storeId, can } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const openId = params.get("id");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [code, setCode] = useState("");
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voiding, setVoiding] = useState(false);
  const [returning, setReturning] = useState(false);
  const codeTerm = useDebounced(code.trim(), 300);

  const list = useQuery({
    queryKey: ["invoices", page, status, codeTerm, range?.[0].format("YYYY-MM-DD"), range?.[1].format("YYYY-MM-DD")],
    queryFn: async () => {
      const response = await http.get<Envelope<Paged<InvoiceListItem>>>("/invoices", {
        params: {
          page,
          limit: 20,
          status: status === "ALL" ? undefined : status,
          code: codeTerm || undefined,
          from: range ? range[0].startOf("day").toISOString() : undefined,
          to: range ? range[1].add(1, "day").startOf("day").toISOString() : undefined,
        },
      });
      return response.data.data;
    },
    placeholderData: (previous) => previous,
  });

  const dashboard = useQuery({
    queryKey: ["dashboard", storeId, 7],
    queryFn: async () => (await http.get<Envelope<DashboardData>>("/dashboard", { params: { days: 7 } })).data.data,
    enabled: Boolean(storeId),
    staleTime: 60_000,
  });
  const today = dashboard.data?.permissions.sales ? dashboard.data.sales.today : null;

  const detail = useQuery({
    queryKey: ["invoice", openId],
    enabled: openId !== null,
    queryFn: async () => {
      const response = await http.get<Envelope<Invoice>>(`/invoices/${openId}`);
      return response.data.data;
    },
  });

  const voidInvoice = useMutation({
    mutationFn: async () => {
      await http.post(`/invoices/${openId}/void`, { reason: voidReason }, { headers: { "Idempotency-Key": crypto.randomUUID() } });
    },
    onSuccess: async () => {
      void message.success("Đã hủy hóa đơn và hoàn tồn về đúng lô");
      setVoiding(false);
      setVoidReason("");
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      await queryClient.invalidateQueries({ queryKey: ["invoice", openId] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không hủy được hóa đơn")),
  });

  return (
    <div>
      <PageHeader
        icon={<FileTextOutlined />}
        title="Hóa đơn"
        description="Tra cứu hóa đơn bán hàng, in lại, nhận trả hàng hoặc hủy hóa đơn trong ngày."
        extra={
          can("invoice.create") ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => void navigate("/ban-hang")}>
              Tạo hóa đơn
            </Button>
          ) : null
        }
      />

      {today ? (
        <StatGrid>
          <StatCard tone="green" icon={<DollarCircleOutlined />} label="Doanh thu hôm nay" value={formatVnd(today.revenue)} hint={<Trend value={today.revenueChangePercent} suffix="so với hôm qua" />} />
          <StatCard tone="blue" icon={<FileTextOutlined />} label="Hóa đơn hôm nay" value={formatNumber(today.invoiceCount)} hint={<Trend value={today.invoiceChangePercent} suffix="so với hôm qua" />} />
          <StatCard tone="slate" icon={<FileSearchOutlined />} label="Kết quả đang lọc" value={formatNumber(list.data?.pagination.total)} loading={list.isLoading} hint="Theo bộ lọc bên dưới" />
        </StatGrid>
      ) : null}

      <div className={openId !== null ? "split-layout" : undefined}>
        <Card>
          <div className="toolbar">
            <Segmented
              value={status}
              onChange={(value) => {
                setStatus(value as StatusFilter);
                setPage(1);
              }}
              options={[
                { value: "ALL", label: "Tất cả" },
                { value: "COMPLETED", label: "Hoàn tất" },
                { value: "VOIDED", label: "Đã hủy" },
              ]}
            />
            <DatePicker.RangePicker
              value={range}
              format="DD/MM/YYYY"
              placeholder={["Từ ngày", "Đến ngày"]}
              onChange={(value) => {
                setRange(value && value[0] && value[1] ? [value[0], value[1]] : null);
                setPage(1);
              }}
            />
            <Input.Search
              allowClear
              className="toolbar-grow"
              placeholder="Số hóa đơn"
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <Table
            rowKey="id"
            loading={list.isFetching}
            dataSource={list.data?.items ?? []}
            tableLayout="fixed"
            className="compact-cells"
            scroll={{ x: 980 }}
            onRow={(row) => ({ onClick: () => setParams({ id: row.id }), style: { cursor: "pointer" } })}
            rowClassName={(row) => (row.id === openId ? "row-selected" : "")}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có hóa đơn phù hợp" /> }}
            pagination={{
              current: page,
              pageSize: list.data?.pagination.limit ?? 20,
              total: list.data?.pagination.total ?? 0,
              onChange: setPage,
              showSizeChanger: false,
              showTotal: (total) => `${total} hóa đơn`,
            }}
            columns={[
              { title: "Số hóa đơn", key: "code", width: COLUMN_WIDTH, render: (_: unknown, row: InvoiceListItem) => <DocCode code={row.code} /> },
              { title: "Thời điểm", key: "soldAt", width: COLUMN_WIDTH, render: (_: unknown, row: InvoiceListItem) => formatDateTime(row.soldAt) },
              { title: "Khách hàng", key: "customer", width: COLUMN_WIDTH, ellipsis: true, render: (_: unknown, row: InvoiceListItem) => row.customerName ?? <span className="text-secondary">Khách lẻ</span> },
              { title: "Người bán", key: "seller", width: COLUMN_WIDTH, ellipsis: true, render: (_: unknown, row: InvoiceListItem) => row.sellerName },
              { title: "Tổng tiền", key: "total", width: COLUMN_WIDTH, align: "right", render: (_: unknown, row: InvoiceListItem) => <Typography.Text strong>{formatVnd(row.totalAmount)}</Typography.Text> },
              { title: "Trạng thái", key: "status", width: COLUMN_WIDTH, render: (_: unknown, row: InvoiceListItem) => <StatusTags status={row.status} returnStatus={row.returnStatus} /> },
              {
                title: "Thao tác",
                key: "actions",
                width: 88,
                align: "center",
                fixed: "right",
                render: (_: unknown, row: InvoiceListItem) => (
                  <InvoiceRowActions
                    row={row}
                    canReturn={can("return.create")}
                    canVoid={can("invoice.void")}
                    onView={() => setParams({ id: row.id })}
                    onReturn={() => {
                      setParams({ id: row.id });
                      setReturning(true);
                    }}
                    onVoid={() => {
                      setParams({ id: row.id });
                      setVoiding(true);
                    }}
                  />
                ),
              },
            ]}
          />
        </Card>

        {openId !== null ? (
          <aside className="split-aside">
            <Card
              title={detail.data ? <span className="mono">{detail.data.code}</span> : "Chi tiết hóa đơn"}
              extra={
                <span className="row-actions">
                  {detail.data ? (
                    <Dropdown
                      menu={{
                        items: [
                          { key: "k80", label: "Khổ K80 (máy in nhiệt)" },
                          { key: "a5", label: "Khổ A5" },
                        ],
                        onClick: ({ key }) => void printInvoice(detail.data!.id, key as "k80" | "a5"),
                      }}
                    >
                      <Button size="small" icon={<PrinterOutlined />}>
                        In
                      </Button>
                    </Dropdown>
                  ) : null}
                  <Button type="text" size="small" onClick={() => setParams({})}>
                    Đóng
                  </Button>
                </span>
              }
            >
              {detail.isLoading || !detail.data ? (
                <Skeleton active paragraph={{ rows: 8 }} />
              ) : (
                <InvoiceDetail invoice={detail.data} canReturn={can("return.create")} canVoid={can("invoice.void")} onReturn={() => setReturning(true)} onVoid={() => setVoiding(true)} />
              )}
            </Card>
          </aside>
        ) : null}
      </div>

      {detail.data ? <ReturnModal invoice={detail.data} open={returning} onClose={() => setReturning(false)} /> : null}

      <Modal
        open={voiding}
        title="Hủy hóa đơn"
        okText="Xác nhận hủy"
        cancelText="Đóng"
        okButtonProps={{ danger: true, disabled: voidReason.trim().length === 0 }}
        confirmLoading={voidInvoice.isPending}
        onOk={() => voidInvoice.mutate()}
        onCancel={() => setVoiding(false)}
      >
        <Typography.Paragraph type="secondary">
          Tồn sẽ được hoàn về đúng các lô đã xuất và ghi thẻ kho loại “Hủy hóa đơn”. Chỉ hủy được hóa đơn trong ngày bán và chưa có phiếu trả.
        </Typography.Paragraph>
        <Input.TextArea rows={3} placeholder="Lý do hủy (bắt buộc)" value={voidReason} onChange={(event) => setVoidReason(event.target.value)} />
      </Modal>
    </div>
  );
}

function InvoiceDetail({ invoice, canReturn, canVoid, onReturn, onVoid }: { invoice: Invoice; canReturn: boolean; canVoid: boolean; onReturn: () => void; onVoid: () => void }) {
  return (
    <div className="detail-stack">
      <div className="invoice-total">
        <span>Tổng thanh toán</span>
        <strong>{formatVnd(invoice.totalAmount)}</strong>
        <div>
          <StatusTags status={invoice.status} returnStatus={invoice.returnStatus} />
        </div>
      </div>
      <dl className="kv-list">
        <div>
          <dt>Thời điểm</dt>
          <dd>{formatDateTime(invoice.soldAt)}</dd>
        </div>
        <div>
          <dt>Khách hàng</dt>
          <dd>{invoice.customer?.fullName ?? "Khách lẻ"}</dd>
        </div>
        <div>
          <dt>Người bán</dt>
          <dd>{invoice.seller.fullName}</dd>
        </div>
        <div>
          <dt>Thanh toán</dt>
          <dd>{paymentMethodLabel(invoice.paymentMethod)}</dd>
        </div>
        <div>
          <dt>Tạm tính</dt>
          <dd>{formatVnd(invoice.subtotal)}</dd>
        </div>
        <div>
          <dt>Giảm giá</dt>
          <dd>
            {invoice.discountAmount > 0 ? `−${formatVnd(invoice.discountAmount)}` : formatVnd(0)}
            {invoice.discountReason ? <span className="text-secondary"> · {invoice.discountReason}</span> : null}
          </dd>
        </div>
        <div>
          <dt>Trong đó VAT</dt>
          <dd>{formatVnd(invoice.vatAmount)}</dd>
        </div>
        {invoice.changeAmount !== null ? (
          <div>
            <dt>Khách đưa / tiền thừa</dt>
            <dd>
              {formatVnd(invoice.amountTendered)} / {formatVnd(invoice.changeAmount)}
            </dd>
          </div>
        ) : null}
        {invoice.voidReason ? (
          <div>
            <dt>Lý do hủy</dt>
            <dd className="text-danger">{invoice.voidReason}</dd>
          </div>
        ) : null}
      </dl>

      <div className="line-list">
        <div className="line-list-head">
          <span>{invoice.lines.length} dòng hàng</span>
        </div>
        {invoice.lines.map((line) => (
          <div className="line-item" key={line.id}>
            <div className="line-item-main">
              <strong>{line.productName}</strong>
              {line.allocations.map((allocation) => (
                <span key={allocation.id}>
                  Lô <span className="mono">{allocation.batchNumber}</span> · HSD {formatDate(allocation.expiryDate)} · {formatNumber(allocation.baseQuantity)}
                </span>
              ))}
            </div>
            <div className="line-item-side">
              <strong>{formatVnd(line.lineTotal)}</strong>
              <span>
                {formatNumber(line.quantity)} {line.unitName} × {formatVnd(line.unitPrice)}
              </span>
            </div>
          </div>
        ))}
      </div>

      {invoice.status === "COMPLETED" ? (
        <div className="panel-actions-row">
          {canReturn && invoice.returnStatus !== "FULL" ? (
            <Button icon={<RollbackOutlined />} onClick={onReturn}>
              Nhận trả hàng
            </Button>
          ) : null}
          {canVoid && invoice.returnStatus === "NONE" ? (
            <Button danger icon={<StopOutlined />} onClick={onVoid}>
              Hủy hóa đơn
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
