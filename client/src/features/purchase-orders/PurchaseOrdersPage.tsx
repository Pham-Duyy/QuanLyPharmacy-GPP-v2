import {
  CloseOutlined,
  EditOutlined,
  FileExcelOutlined,
  InboxOutlined,
  MailOutlined,
  PlusOutlined,
  PrinterOutlined,
  SendOutlined,
  CarryOutOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Radio,
  Segmented,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import { useNavigate } from "react-router";
import { getErrorMessage } from "../../api/http.js";
import { formatVnd } from "../../api/types.js";
import { formatDate, formatDateTime, formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useAuth } from "../auth/auth-context.js";
import { ReceiptFormModal } from "../inventory/ReceiptFormModal.js";
import { PrintPreviewModal } from "../printing/PrintPreviewModal.js";
import { printDocument, printUrl } from "../printing/printing.js";
import { OrderFormModal } from "./OrderFormModal.js";
import {
  canReceive,
  purchaseOrdersApi,
  receiptLinesFromOrder,
  STATUS_COLOR,
  STATUS_LABEL,
  type PurchaseOrderDetail,
  type PurchaseOrderListItem,
  type PurchaseOrderStatus,
} from "./purchase-orders-api.js";

const FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "Tất cả" },
  { value: "DRAFT", label: "Nháp" },
  { value: "SENT,PARTIAL", label: "Chờ hàng về" },
  { value: "RECEIVED", label: "Đã nhận đủ" },
  { value: "CANCELLED", label: "Đã hủy" },
];

function StatusTag({ status }: { status: PurchaseOrderStatus }) {
  return <Tag color={STATUS_COLOR[status]}>{STATUS_LABEL[status]}</Tag>;
}

/**
 * Đơn đặt hàng gửi nhà cung cấp (Phase 7, D32): lập (tay hoặc từ Đề xuất đặt
 * hàng), gửi (in / Excel qua Zalo hoặc email), theo dõi hàng về, lập phiếu nhập từ đơn.
 */
export function PurchaseOrdersPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const list = useQuery({
    queryKey: ["purchase-orders", filter, search, page],
    queryFn: () =>
      purchaseOrdersApi.list({ status: filter || undefined, search: search || undefined, page }),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });

  return (
    <div>
      <PageHeader
        icon={<CarryOutOutlined />}
        title="Đơn đặt hàng"
        extra={
          can("goods_receipt.create") ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              Lập đơn
            </Button>
          ) : null
        }
      />
      <div className={openId ? "split-layout" : undefined}>
        <div className="detail-stack">
          <Card>
            <div className="count-toolbar">
              <Segmented
                value={filter}
                onChange={(value) => {
                  setFilter(String(value));
                  setPage(1);
                }}
                options={FILTERS}
              />
              <Input.Search
                allowClear
                placeholder="Mã đơn, nhà cung cấp"
                onSearch={(value) => {
                  setSearch(value.trim());
                  setPage(1);
                }}
                style={{ maxWidth: 280 }}
              />
            </div>
            {list.isError && <Alert type="error" showIcon title={getErrorMessage(list.error)} />}
            <Table<PurchaseOrderListItem>
              rowKey="id"
              className="compact-cells"
              loading={list.isLoading}
              dataSource={list.data?.items ?? []}
              scroll={{ x: 720 }}
              onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
              rowClassName={(row) => (row.id === openId ? "ant-table-row-selected" : "")}
              locale={{
                emptyText: (
                  <Empty description="Chưa có đơn. Lập đơn tay, hoặc chọn hàng ở Đề xuất đặt hàng rồi bấm Lập đơn đặt hàng." />
                ),
              }}
              pagination={{
                current: page,
                pageSize: 20,
                total: list.data?.pagination.total ?? 0,
                onChange: setPage,
                showSizeChanger: false,
              }}
              columns={[
                {
                  title: "Mã đơn",
                  dataIndex: "code",
                  render: (code: string) => <span className="mono">{code}</span>,
                },
                { title: "Nhà cung cấp", dataIndex: "supplierName" },
                {
                  title: "Trạng thái",
                  dataIndex: "status",
                  render: (status: PurchaseOrderStatus) => <StatusTag status={status} />,
                },
                {
                  title: "Số mặt hàng",
                  dataIndex: "lineCount",
                  align: "right",
                  render: formatNumber,
                },
                {
                  title: "Tạm tính",
                  dataIndex: "estimatedAmount",
                  align: "right",
                  render: (value: number) => (value > 0 ? formatVnd(value) : "—"),
                },
                {
                  title: "Giao dự kiến",
                  dataIndex: "expectedDate",
                  render: (value: string | null) => (value ? formatDate(value) : "—"),
                },
                {
                  title: "Lập lúc",
                  dataIndex: "createdAt",
                  render: (value: string) => formatDateTime(value),
                },
              ]}
            />
          </Card>
        </div>
        {openId ? (
          <aside className="split-aside">
            <OrderDetailPanel id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />
          </aside>
        ) : null}
      </div>
      <OrderFormModal
        open={creating}
        order={null}
        onClose={() => setCreating(false)}
        onSaved={(id) => {
          setCreating(false);
          void refresh();
          setOpenId(id);
        }}
      />
    </div>
  );
}

function OrderDetailPanel({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const detail = useQuery({
    queryKey: ["purchase-order", id],
    queryFn: () => purchaseOrdersApi.detail(id),
  });

  async function changed() {
    await queryClient.invalidateQueries({ queryKey: ["purchase-order", id] });
    await onChanged();
  }

  if (detail.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (detail.isError || !detail.data)
    return <Alert type="error" showIcon title={getErrorMessage(detail.error)} />;
  const order = detail.data;
  const draft = order.status === "DRAFT";
  const canSend = can("goods_receipt.confirm");

  return (
    <Card
      className="receipt-panel"
      title={
        <span className="panel-title">
          <CarryOutOutlined /> {order.code}
        </span>
      }
      extra={
        <Space>
          <StatusTag status={order.status} />
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined />}
            onClick={onClose}
            aria-label="Đóng"
          />
        </Space>
      }
    >
      <div className="detail-stack">
        {order.status === "CANCELLED" && (
          <Alert
            type="error"
            showIcon
            title={`Đã hủy${order.cancelReason ? `: ${order.cancelReason}` : ""}`}
          />
        )}
        <dl className="kv-list">
          <div>
            <dt>Nhà cung cấp</dt>
            <dd>{order.supplier.name}</dd>
          </div>
          <div>
            <dt>Liên hệ</dt>
            <dd>
              {[order.supplier.phone, order.supplier.email].filter(Boolean).join(" · ") || "—"}
            </dd>
          </div>
          <div>
            <dt>Giao dự kiến</dt>
            <dd>{order.expectedDate ? formatDate(order.expectedDate) : "—"}</dd>
          </div>
          <div>
            <dt>Lập</dt>
            <dd>
              {formatDateTime(order.createdAt)}
              {order.createdBy ? ` · ${order.createdBy.fullName}` : ""}
            </dd>
          </div>
          {order.sentAt && (
            <div>
              <dt>Đã gửi</dt>
              <dd>
                {formatDateTime(order.sentAt)}
                {order.sentBy ? ` · ${order.sentBy.fullName}` : ""}
                {order.sentVia === "EMAIL" ? ` · email ${order.sentTo ?? ""}` : " · tự gửi"}
              </dd>
            </div>
          )}
          {order.note && (
            <div>
              <dt>Ghi chú</dt>
              <dd>{order.note}</dd>
            </div>
          )}
        </dl>

        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={order.lines}
          scroll={{ x: 460 }}
          columns={[
            {
              title: "Hàng",
              render: (_, line) => (
                <span>
                  {line.productName}
                  <br />
                  <span className="text-secondary">{line.productCode}</span>
                </span>
              ),
            },
            {
              title: "Đặt",
              align: "right",
              render: (_, line) => `${formatNumber(line.quantity)} ${line.unitName}`,
            },
            {
              title: "Đã nhận",
              align: "right",
              render: (_, line) =>
                draft ? (
                  "—"
                ) : (
                  <span className={line.remainingBaseQuantity > 0 ? undefined : "text-success"}>
                    {formatNumber(line.receivedBaseQuantity)}/{formatNumber(line.baseQuantity)}{" "}
                    {line.baseUnitName}
                  </span>
                ),
            },
            {
              title: "Đơn giá",
              align: "right",
              render: (_, line) => (line.unitPrice === null ? "—" : formatVnd(line.unitPrice)),
            },
          ]}
        />
        {order.estimatedAmount > 0 && (
          <p className="section-note" style={{ margin: 0, textAlign: "right" }}>
            Tạm tính <b>{formatVnd(order.estimatedAmount)}</b>
          </p>
        )}

        {order.goodsReceipts.length > 0 && (
          <section className="panel-section">
            <h4>Phiếu nhập từ đơn</h4>
            <ul className="plain-list">
              {order.goodsReceipts.map((receipt) => (
                <li key={receipt.id}>
                  <Typography.Link onClick={() => void navigate("/phieu-nhap")}>
                    {receipt.code}
                  </Typography.Link>{" "}
                  · {formatDateTime(receipt.receivedAt)} ·{" "}
                  {receipt.status === "CONFIRMED"
                    ? "đã nhập kho"
                    : receipt.status === "DRAFT"
                      ? "chờ kiểm nhập"
                      : "đã hủy"}
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="panel-actions-row">
          {draft && can("goods_receipt.create") && (
            <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
              Sửa
            </Button>
          )}
          {order.status !== "CANCELLED" && canSend && (draft || order.mailEnabled) && (
            <Button
              type={draft ? "primary" : "default"}
              icon={<SendOutlined />}
              onClick={() => setSending(true)}
            >
              {draft ? "Gửi nhà cung cấp" : "Gửi lại email"}
            </Button>
          )}
          {canReceive(order.status) && can("goods_receipt.create") && (
            <Button type="primary" icon={<InboxOutlined />} onClick={() => setReceiving(true)}>
              Lập phiếu nhập từ đơn
            </Button>
          )}
          <Button
            icon={<PrinterOutlined />}
            onClick={() => void printDocument(printUrl.purchaseOrder(order.id), message)}
          >
            In / Lưu PDF
          </Button>
          <Button onClick={() => setPreviewing(true)}>Xem trước</Button>
          <Button
            icon={<FileExcelOutlined />}
            onClick={() =>
              void purchaseOrdersApi
                .excel(order.id, order.code)
                .catch((error: unknown) =>
                  message.error(error instanceof Error ? error.message : "Không tải được tệp"),
                )
            }
          >
            Tải Excel
          </Button>
          {["DRAFT", "SENT", "PARTIAL"].includes(order.status) && canSend && (
            <Button danger icon={<StopOutlined />} onClick={() => setCancelling(true)}>
              Hủy đơn
            </Button>
          )}
        </div>
      </div>

      <OrderFormModal
        open={editing}
        order={order}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          void changed();
        }}
      />
      <SendModal
        open={sending}
        order={order}
        onClose={() => setSending(false)}
        onSent={() => {
          setSending(false);
          void changed();
        }}
      />
      <CancelModal
        open={cancelling}
        order={order}
        onClose={() => setCancelling(false)}
        onDone={() => {
          setCancelling(false);
          void changed();
        }}
      />
      <ReceiptFormModal
        open={receiving}
        receipt={null}
        prefill={{
          supplierId: order.supplier.id,
          purchaseOrderId: order.id,
          lines: receiptLinesFromOrder(order),
        }}
        onClose={() => setReceiving(false)}
        onSaved={() => {
          setReceiving(false);
          void message.success("Đã lập phiếu nhập; kiểm nhập ở trang Phiếu nhập để cộng tồn kho");
          void changed();
        }}
      />
      <PrintPreviewModal
        url={previewing ? printUrl.purchaseOrder(order.id) : null}
        title={`Xem trước đơn ${order.code}`}
        onClose={() => setPreviewing(false)}
      />
    </Card>
  );
}

function SendModal({
  open,
  order,
  onClose,
  onSent,
}: {
  open: boolean;
  order: PurchaseOrderDetail;
  onClose: () => void;
  onSent: () => void;
}) {
  const { message } = App.useApp();
  const draft = order.status === "DRAFT";
  const [channel, setChannel] = useState<"EMAIL" | "MANUAL">(
    order.mailEnabled && order.supplier.email ? "EMAIL" : "MANUAL",
  );
  const [to, setTo] = useState(order.supplier.email ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await purchaseOrdersApi.send(
        order.id,
        channel === "EMAIL"
          ? { channel, to: to.trim(), message: note.trim() || null }
          : { channel: "MANUAL" },
      );
      void message.success(
        channel === "EMAIL" ? `Đã gửi email tới ${to.trim()}` : "Đã ghi nhận đơn đã gửi",
      );
      onSent();
    } catch (caught) {
      setError(getErrorMessage(caught, "Không gửi được"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => void submit()}
      okText={channel === "EMAIL" ? "Gửi email" : "Đã gửi xong"}
      cancelText="Quay lại"
      confirmLoading={busy}
      title={`Gửi đơn ${order.code} cho ${order.supplier.name}`}
      destroyOnHidden
    >
      <div className="detail-stack">
        {error && <Alert type="error" showIcon title={error} />}
        {draft && (
          <Radio.Group
            value={channel}
            onChange={(event) => setChannel(event.target.value as "EMAIL" | "MANUAL")}
          >
            <Space direction="vertical">
              <Radio value="EMAIL" disabled={!order.mailEnabled}>
                <MailOutlined /> Gửi email từ phần mềm (kèm tệp Excel)
                {!order.mailEnabled && (
                  <Typography.Text type="secondary"> — chưa cấu hình máy chủ thư</Typography.Text>
                )}
              </Radio>
              <Radio value="MANUAL">
                Tôi đã tự gửi (in, lưu PDF hoặc tải Excel rồi gửi qua Zalo, điện thoại)
              </Radio>
            </Space>
          </Radio.Group>
        )}
        {channel === "EMAIL" ? (
          <>
            <label className="field">
              <span>Email nhà cung cấp</span>
              <Input value={to} onChange={(event) => setTo(event.target.value)} type="email" />
            </label>
            <label className="field">
              <span>Lời nhắn (tùy chọn)</span>
              <Input.TextArea
                rows={3}
                maxLength={2000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Ví dụ: Nhờ anh/chị xác nhận đơn và báo ngày giao."
              />
            </label>
            {order.mailFrom && (
              <Typography.Text type="secondary">Gửi từ địa chỉ {order.mailFrom}.</Typography.Text>
            )}
          </>
        ) : (
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            Dùng nút <b>In / Lưu PDF</b> hoặc <b>Tải Excel</b> ở đơn để gửi nhà cung cấp, rồi bấm{" "}
            <b>Đã gửi xong</b> để đơn chuyển sang Đã gửi và lập được phiếu nhập khi hàng về.
          </Typography.Paragraph>
        )}
      </div>
    </Modal>
  );
}

function CancelModal({
  open,
  order,
  onClose,
  onDone,
}: {
  open: boolean;
  order: PurchaseOrderDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open={open}
      onCancel={onClose}
      okText="Hủy đơn"
      okButtonProps={{ danger: true, disabled: !reason.trim() }}
      cancelText="Quay lại"
      confirmLoading={busy}
      title={`Hủy đơn ${order.code}?`}
      destroyOnHidden
      onOk={() => {
        setBusy(true);
        setError(null);
        purchaseOrdersApi
          .cancel(order.id, reason.trim())
          .then(onDone)
          .catch((caught: unknown) => setError(getErrorMessage(caught)))
          .finally(() => setBusy(false));
      }}
    >
      <div className="detail-stack">
        {order.status === "PARTIAL" && (
          <Alert
            type="info"
            showIcon
            title="Đơn đã nhận một phần: hủy là không chờ phần còn lại nữa. Hàng đã nhập giữ nguyên."
          />
        )}
        {error && <Alert type="error" showIcon title={error} />}
        <label className="field">
          <span>Lý do hủy</span>
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            placeholder="Ví dụ: nhà cung cấp hết hàng"
          />
        </label>
      </div>
    </Modal>
  );
}
