import { DollarCircleOutlined, FileSearchOutlined, FileTextOutlined, PrinterOutlined, RollbackOutlined, StopOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Card, DatePicker, Dropdown, Empty, Input, Modal, Segmented, Skeleton, Table, Tag, Typography } from "antd";
import type { Dayjs } from "dayjs";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { getErrorMessage, http } from "../../api/http.js";
import { formatVnd, type DashboardData, type Envelope, type Invoice, type InvoiceListItem, type Paged } from "../../api/types.js";
import { formatDate, formatDateTime, formatNumber } from "../../ui/format.js";
import { paymentMethodLabel } from "../../ui/labels.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { PanelEmpty } from "../../ui/PanelEmpty.js";
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
      <PageHeader icon={<FileTextOutlined />} title="Hóa đơn" description="Tra cứu hóa đơn bán hàng, in lại, nhận trả hàng hoặc hủy hóa đơn trong ngày." />

      {today ? (
        <StatGrid>
          <StatCard tone="green" icon={<DollarCircleOutlined />} label="Doanh thu hôm nay" value={formatVnd(today.revenue)} hint={<Trend value={today.revenueChangePercent} suffix="so với hôm qua" />} />
          <StatCard tone="blue" icon={<FileTextOutlined />} label="Hóa đơn hôm nay" value={formatNumber(today.invoiceCount)} hint={<Trend value={today.invoiceChangePercent} suffix="so với hôm qua" />} />
          <StatCard tone="slate" icon={<FileSearchOutlined />} label="Kết quả đang lọc" value={formatNumber(list.data?.pagination.total)} loading={list.isLoading} hint="Theo bộ lọc bên dưới" />
        </StatGrid>
      ) : null}

      <div className="split-layout">
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
            scroll={{ x: 720 }}
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
              {
                title: "Hóa đơn",
                key: "code",
                render: (_: unknown, row: InvoiceListItem) => (
                  <div className="cell-main">
                    <strong className="mono">{row.code}</strong>
                    <span>{formatDateTime(row.soldAt)}</span>
                  </div>
                ),
              },
              {
                title: "Khách · Người bán",
                key: "people",
                ellipsis: true,
                render: (_: unknown, row: InvoiceListItem) => (
                  <div className="cell-main">
                    <strong>{row.customerName ?? "Khách lẻ"}</strong>
                    <span>{row.sellerName}</span>
                  </div>
                ),
              },
              { title: "Tổng tiền", key: "total", width: 120, align: "right", render: (_: unknown, row: InvoiceListItem) => <Typography.Text strong>{formatVnd(row.totalAmount)}</Typography.Text> },
              { title: "Trạng thái", key: "status", width: 150, render: (_: unknown, row: InvoiceListItem) => <StatusTags status={row.status} returnStatus={row.returnStatus} /> },
            ]}
          />
        </Card>

        <aside className="split-aside">
          {openId === null ? (
            <Card title="Chi tiết hóa đơn">
              <PanelEmpty icon={<FileSearchOutlined />} title="Chưa chọn hóa đơn" description="Bấm vào một hóa đơn để xem dòng hàng, lô đã xuất và thao tác." />
            </Card>
          ) : (
            <Card
              title={detail.data ? <span className="mono">{detail.data.code}</span> : "Chi tiết hóa đơn"}
              extra={
                detail.data ? (
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
                ) : null
              }
            >
              {detail.isLoading || !detail.data ? (
                <Skeleton active paragraph={{ rows: 8 }} />
              ) : (
                <InvoiceDetail invoice={detail.data} canReturn={can("return.create")} canVoid={can("invoice.void")} onReturn={() => setReturning(true)} onVoid={() => setVoiding(true)} />
              )}
            </Card>
          )}
        </aside>
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
