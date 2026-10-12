import {
  AppstoreOutlined,
  CheckCircleFilled,
  CloseCircleOutlined,
  DatabaseOutlined,
  EditOutlined,
  ExclamationCircleFilled,
  FileSearchOutlined,
  FileTextOutlined,
  PrinterOutlined,
  SafetyCertificateOutlined,
  ShopOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Card, Input, Modal, Progress, Skeleton, Typography } from "antd";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { getErrorMessage, http } from "../../../api/http.js";
import { formatVnd, type Envelope, type GoodsReceiptDetail } from "../../../api/types.js";
import { daysUntil, formatDate, formatDateTime, vnDateKey } from "../../../ui/format.js";
import { useAuth } from "../../auth/auth-context.js";
import { printDocument, printUrl } from "../../printing/printing.js";
import { PrintPreviewModal } from "../../printing/PrintPreviewModal.js";
import { ReceiptFormModal } from "../ReceiptFormModal.js";
import { InspectionModal } from "./InspectionModal.js";
import { ReceiptLinesModal } from "./ReceiptLinesModal.js";
import { StatusTag } from "./StatusTag.js";

export type PanelAction = "lines" | "inspect" | "edit" | "cancel";

/** Kiểm tra trước khi kiểm nhập: chỉ dựa trên dữ liệu đã nhập ở phiếu, không thay cho kiểm tra cảm quan thực tế. */
function draftChecks(receipt: GoodsReceiptDetail) {
  const lines = receipt.lines;
  const today = vnDateKey();
  const hasBatch = lines.filter((line) => line.batchNumber.trim().length > 0).length;
  const notExpired = lines.filter((line) => line.expiryDate.slice(0, 10) > today).length;
  const longEnough = lines.filter((line) => daysUntil(line.expiryDate) > 90).length;
  const hasCost = lines.filter((line) => line.quantity > 0 && line.unitCost > 0).length;
  const ready = lines.filter(
    (line) =>
      line.batchNumber.trim() &&
      line.expiryDate.slice(0, 10) > today &&
      line.quantity > 0 &&
      line.unitCost > 0,
  ).length;
  return {
    ready,
    items: [
      {
        label: "Đủ số lô cho từng dòng",
        done: hasBatch === lines.length,
        detail: `${hasBatch}/${lines.length}`,
      },
      {
        label: "Hạn dùng chưa qua",
        done: notExpired === lines.length,
        detail: `${notExpired}/${lines.length}`,
      },
      {
        label: "Có số lượng và giá nhập",
        done: hasCost === lines.length,
        detail: `${hasCost}/${lines.length}`,
      },
      {
        label: "Hạn dùng còn trên 90 ngày",
        done: longEnough === lines.length,
        detail: `${longEnough}/${lines.length}`,
        warnOnly: true,
      },
    ],
  };
}

export function ReceiptDetailPanel({
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
    queryFn: async () =>
      (await http.get<Envelope<GoodsReceiptDetail>>(`/goods-receipts/${receiptId}`)).data.data,
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
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["goods-receipt", receiptId] }),
      onChanged(),
    ]);
  }

  const cancel = useMutation({
    mutationFn: () =>
      http.post(
        `/goods-receipts/${receiptId}/cancel`,
        { reason: cancelReason },
        { headers: { "Idempotency-Key": keyFor("cancel") } },
      ),
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

          {isDraft && receipt.complianceWarnings?.length ? (
            <Alert
              type="warning"
              showIcon
              title="Hồ sơ GPP còn thiếu — kiểm tra trước khi kiểm nhập"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {receipt.complianceWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              }
            />
          ) : null}

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
              <Typography.Text type="secondary">
                Phiếu không gắn nhà cung cấp (ví dụ tồn đầu kỳ).
              </Typography.Text>
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
                    {formatVnd(receipt.goodsAmount)} − {formatVnd(receipt.discountAmount)} +{" "}
                    {formatVnd(receipt.vatAmount)}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>Người lập</dt>
                <dd>
                  {receipt.createdBy
                    ? `${receipt.createdBy.fullName}${receipt.createdAt ? ` · ${formatDateTime(receipt.createdAt)}` : ""}`
                    : "—"}
                </dd>
              </div>
              {receipt.status === "CONFIRMED" ? (
                <div>
                  <dt>Người kiểm nhập</dt>
                  <dd>
                    {receipt.confirmedBy
                      ? `${receipt.confirmedBy.fullName} · ${formatDateTime(receipt.confirmedAt)}`
                      : formatDateTime(receipt.confirmedAt)}
                  </dd>
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
                  <SafetyCertificateOutlined />{" "}
                  {isDraft ? "Kiểm tra lô – hạn dùng" : "Kết quả nhập kho"}
                </span>
                <span className="text-secondary">
                  {progressDone}/{lineCount}
                </span>
              </h4>
              <Progress
                percent={Math.round((progressDone / lineCount) * 100)}
                showInfo={false}
                strokeColor={
                  progressDone === lineCount ? "var(--tone-green)" : "var(--tone-orange)"
                }
              />
              <ul className="check-list">
                {checks
                  ? checks.items.map((item) => (
                      <li
                        key={item.label}
                        className={item.done ? "done" : item.warnOnly ? "warn" : "fail"}
                      >
                        {item.done ? <CheckCircleFilled /> : <ExclamationCircleFilled />}
                        <span>{item.label}</span>
                        <em>{item.detail}</em>
                      </li>
                    ))
                  : [
                      <li key="ok" className="done">
                        <CheckCircleFilled />
                        <span>Lô đang bán được</span>
                        <em>
                          {available}/{lineCount}
                        </em>
                      </li>,
                      <li key="q" className={quarantined > 0 ? "warn" : "done"}>
                        {quarantined > 0 ? <ExclamationCircleFilled /> : <CheckCircleFilled />}
                        <span>Lô đang biệt trữ</span>
                        <em>{quarantined}</em>
                      </li>,
                    ]}
              </ul>
              {isDraft ? (
                <p className="section-note">
                  Đây là kiểm tra dữ liệu trên phiếu. Kiểm tra cảm quan thực tế làm ở bước “Kiểm
                  nhập & xác nhận”.
                </p>
              ) : null}
            </section>
          ) : null}

          <div className="panel-actions">
            {isDraft ? (
              <Button
                type="primary"
                size="large"
                block
                icon={<SafetyCertificateOutlined />}
                disabled={!can("goods_receipt.confirm")}
                onClick={() => setInspecting(true)}
              >
                Kiểm nhập &amp; xác nhận
              </Button>
            ) : null}
            <Button
              size="large"
              block
              icon={<AppstoreOutlined />}
              onClick={() => setViewingLines(true)}
            >
              Xem chi tiết hàng hóa
            </Button>
            <div className="panel-actions-row">
              <Button icon={<FileSearchOutlined />} onClick={() => setPreviewingPrint(true)}>
                Xem trước bản in
              </Button>
              <Button
                icon={<PrinterOutlined />}
                onClick={() => void printDocument(printUrl.goodsReceipt(receipt.id), message)}
              >
                In phiếu nhập
              </Button>
            </div>
            {isDraft ? (
              <div className="panel-actions-row">
                <Button
                  icon={<EditOutlined />}
                  disabled={!can("goods_receipt.create")}
                  onClick={() => setEditing(true)}
                >
                  Sửa phiếu
                </Button>
                <Button
                  danger
                  icon={<CloseCircleOutlined />}
                  disabled={!can("goods_receipt.confirm")}
                  onClick={() => setCancelling(true)}
                >
                  Hủy phiếu
                </Button>
              </div>
            ) : null}
            {receipt.status === "CONFIRMED" && can("stock.read") ? (
              <Button
                type="link"
                icon={<DatabaseOutlined />}
                onClick={() => void navigate("/ton-kho")}
              >
                Xem tồn kho sau nhập
              </Button>
            ) : null}
          </div>
        </div>
      </Card>

      <ReceiptLinesModal open={linesOpen} receipt={receipt} onClose={closeDialogs} />
      <PrintPreviewModal
        url={previewingPrint ? printUrl.goodsReceipt(receipt.id) : null}
        title={`Xem trước phiếu nhập ${receipt.code}`}
        onClose={() => setPreviewingPrint(false)}
      />
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
        <Typography.Paragraph type="secondary">
          Phiếu hủy được giữ lại để tra cứu, không ảnh hưởng tồn kho.
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          placeholder="Lý do hủy phiếu (bắt buộc)"
          value={cancelReason}
          onChange={(event) => setCancelReason(event.target.value)}
        />
      </Modal>
    </>
  );
}
