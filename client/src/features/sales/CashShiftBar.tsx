import { LockOutlined, SwapOutlined, WalletOutlined } from "@ant-design/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Tag,
} from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { useSubmitKey } from "../../api/submit-key.js";
import { formatVnd, type Envelope } from "../../api/types.js";
import { formatDateTime } from "../../ui/format.js";
import { useAuth } from "../auth/auth-context.js";
import { printDocument } from "../printing/printing.js";
import {
  cashShiftKeys,
  cashShiftPrintUrl,
  useCurrentShift,
  type CashShift,
  type CurrentShift,
} from "./cash-shift-api.js";

const moneyInput = {
  min: 0,
  step: 1000,
  style: { width: "100%" },
  formatter: (value: number | string | undefined) =>
    value === undefined || value === "" ? "" : Number(value).toLocaleString("vi-VN"),
  parser: (value: string | undefined) => Number((value ?? "").replace(/\D/g, "")),
} as const;

const time = (value: string) =>
  new Date(value).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });

/** Dòng trạng thái ca ở quầy bán: mở ca, thu chi, chốt ca. Không chặn bán khi chưa mở ca. */
export function CashShiftBar() {
  const { can } = useAuth();
  const allowed = can("cash_shift.manage");
  const current = useCurrentShift(allowed);
  const [dialog, setDialog] = useState<null | "open" | "move" | "close">(null);

  if (!allowed || !current.data) return null;
  const shift = current.data.shift;

  return (
    <div className="cash-shift-bar">
      {shift ? (
        <>
          <span className="cash-shift-status">
            <WalletOutlined /> Ca từ {time(shift.openedAt)} · Két dự kiến{" "}
            <strong>{formatVnd(shift.totals.expectedCash)}</strong>
          </span>
          <Button size="small" icon={<SwapOutlined />} onClick={() => setDialog("move")}>
            Thu/chi
          </Button>
          <Button
            size="small"
            icon={<LockOutlined />}
            onClick={() => {
              // Lấy số mới nhất trước khi đếm két: quầy có thể vừa bán thêm.
              void current.refetch();
              setDialog("close");
            }}
          >
            Chốt ca
          </Button>
        </>
      ) : (
        <>
          <Tag>Chưa mở ca</Tag>
          <Button
            size="small"
            type="primary"
            icon={<WalletOutlined />}
            onClick={() => setDialog("open")}
          >
            Mở ca
          </Button>
        </>
      )}
      {dialog === "open" ? (
        <OpenShiftModal current={current.data} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "move" && shift ? (
        <MovementModal shift={shift} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "close" && shift ? (
        <CloseShiftModal shift={shift} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

function useShiftMutation<T>(
  send: (values: T) => Promise<CashShift>,
  done: (shift: CashShift) => void,
) {
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  return useMutation({
    mutationFn: send,
    onSuccess: async (shift) => {
      done(shift);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: cashShiftKeys.current }),
        queryClient.invalidateQueries({ queryKey: cashShiftKeys.list }),
      ]);
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được"), 8),
  });
}

function OpenShiftModal({ current, onClose }: { current: CurrentShift; onClose: () => void }) {
  const { message } = App.useApp();
  const submitKey = useSubmitKey();
  const outside = current.outsideShift;
  // Mặc định: tiền để lại lúc chốt ca trước cộng tiền mặt bán ngoài ca.
  const suggested = (current.lastCountedCash ?? 0) + (outside?.cash ?? 0);
  const [openingCash, setOpeningCash] = useState<number | null>(suggested);
  const open = useShiftMutation(
    async (cash: number) => {
      const body = { openingCash: cash };
      return (
        await http.post<Envelope<CashShift>>("/cash-shifts", body, {
          headers: submitKey.headers(body),
        })
      ).data.data;
    },
    (shift) => {
      submitKey.done();
      void message.success(`Đã mở ca ${shift.code}`);
      onClose();
    },
  );

  return (
    <Modal
      open
      title="Mở ca"
      okText="Mở ca"
      cancelText="Hủy"
      onCancel={onClose}
      confirmLoading={open.isPending}
      okButtonProps={{ disabled: openingCash === null }}
      onOk={() => open.mutate(openingCash ?? 0)}
    >
      <Form layout="vertical">
        <Form.Item label="Tiền đang có trong két" extra="Đếm két rồi nhập tổng số tiền.">
          <InputNumber<number>
            {...moneyInput}
            autoFocus
            value={openingCash}
            onChange={setOpeningCash}
            suffix="₫"
          />
        </Form.Item>
      </Form>
      {outside ? (
        <Alert
          type="info"
          showIcon
          title={`Từ lúc chốt ca trước (${formatDateTime(outside.since)}) đã bán ${outside.invoiceCount} hóa đơn tiền mặt, ${formatVnd(outside.cash)} ngoài ca — tiền này đang nằm trong két.`}
        />
      ) : null}
    </Modal>
  );
}

function MovementModal({ shift, onClose }: { shift: CashShift; onClose: () => void }) {
  const { message } = App.useApp();
  const submitKey = useSubmitKey();
  const [direction, setDirection] = useState<"OUT" | "IN">("OUT");
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const save = useShiftMutation(
    async () => {
      const body = { direction, amount, reason: reason.trim() };
      return (
        await http.post<Envelope<CashShift>>(`/cash-shifts/${shift.id}/movements`, body, {
          headers: submitKey.headers(shift.id, body),
        })
      ).data.data;
    },
    () => {
      submitKey.done();
      void message.success(direction === "OUT" ? "Đã ghi phiếu chi" : "Đã ghi phiếu thu");
      onClose();
    },
  );

  return (
    <Modal
      open
      title="Thu/chi tiền mặt trong ca"
      okText="Ghi"
      cancelText="Hủy"
      onCancel={onClose}
      confirmLoading={save.isPending}
      okButtonProps={{ disabled: !amount || !reason.trim() }}
      onOk={() => save.mutate(undefined)}
    >
      <Form layout="vertical">
        <Form.Item>
          <Segmented<"OUT" | "IN">
            block
            value={direction}
            onChange={setDirection}
            options={[
              { value: "OUT", label: "Chi ra khỏi két" },
              { value: "IN", label: "Thu vào két" },
            ]}
          />
        </Form.Item>
        <Form.Item label="Số tiền">
          <InputNumber<number>
            {...moneyInput}
            min={1}
            autoFocus
            value={amount}
            onChange={setAmount}
            suffix="₫"
          />
        </Form.Item>
        <Form.Item label="Lý do">
          <Input
            maxLength={300}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={
              direction === "OUT"
                ? "Ví dụ: nộp tiền cho chủ, mua nước"
                : "Ví dụ: chủ đưa thêm tiền lẻ"
            }
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function CloseShiftModal({ shift, onClose }: { shift: CashShift; onClose: () => void }) {
  const { message } = App.useApp();
  const submitKey = useSubmitKey();
  const [counted, setCounted] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [print, setPrint] = useState(true);
  const t = shift.totals;
  const difference = counted === null ? null : counted - t.expectedCash;
  const needNote = difference !== null && difference !== 0;

  const close = useShiftMutation(
    async () => {
      const body = { countedCash: counted, note: note.trim() || null };
      return (
        await http.post<Envelope<CashShift>>(`/cash-shifts/${shift.id}/close`, body, {
          headers: submitKey.headers(shift.id, body),
        })
      ).data.data;
    },
    (closed) => {
      submitKey.done();
      void message.success(`Đã chốt ca ${closed.code}`);
      onClose();
      if (print) void printDocument(cashShiftPrintUrl(closed.id), message);
    },
  );

  const lines: Array<[string, number, boolean?]> = [
    ["Tiền đầu ca", t.openingCash],
    ["+ Bán tiền mặt", t.cashSales],
    ["− Hủy hóa đơn tiền mặt", t.cashVoided],
    ["− Hoàn tiền trả hàng", t.cashRefunds],
    ["+ Thu khác", t.cashIn],
    ["− Chi khác", t.cashOut],
  ];

  return (
    <Modal
      open
      title={`Chốt ca ${shift.code}`}
      okText="Chốt ca"
      cancelText="Hủy"
      onCancel={onClose}
      confirmLoading={close.isPending}
      okButtonProps={{ disabled: counted === null || (needNote && !note.trim()) }}
      onOk={() => close.mutate(undefined)}
    >
      <dl className="cash-shift-sum">
        {lines
          .filter(
            ([label, value]) =>
              value !== 0 || label === "Tiền đầu ca" || label === "+ Bán tiền mặt",
          )
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{formatVnd(value)}</dd>
            </div>
          ))}
        <div className="is-total">
          <dt>Tiền mặt dự kiến</dt>
          <dd>{formatVnd(t.expectedCash)}</dd>
        </div>
      </dl>
      <p className="section-note">
        {t.invoiceCount} hóa đơn · chuyển khoản {formatVnd(t.salesByMethod.BANK_TRANSFER)} · thẻ{" "}
        {formatVnd(t.salesByMethod.CARD)} (không vào két)
      </p>
      <Form layout="vertical">
        <Form.Item label="Tiền đếm thực tế trong két">
          <InputNumber<number>
            {...moneyInput}
            autoFocus
            value={counted}
            onChange={setCounted}
            suffix="₫"
          />
        </Form.Item>
        {difference !== null ? (
          <p
            className={`cash-shift-diff ${difference === 0 ? "is-ok" : difference < 0 ? "is-short" : "is-over"}`}
          >
            {difference === 0
              ? "Khớp với dự kiến"
              : `${difference < 0 ? "Thiếu" : "Thừa"} ${formatVnd(Math.abs(difference))}`}
          </p>
        ) : null}
        {needNote ? (
          <Form.Item label="Lý do chênh lệch" required>
            <Input.TextArea
              rows={2}
              maxLength={500}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Form.Item>
        ) : null}
        <Checkbox checked={print} onChange={(event) => setPrint(event.target.checked)}>
          In phiếu chốt ca
        </Checkbox>
      </Form>
    </Modal>
  );
}
