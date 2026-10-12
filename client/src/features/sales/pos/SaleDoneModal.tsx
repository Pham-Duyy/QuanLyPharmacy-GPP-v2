import { CheckCircleFilled, PrinterOutlined } from "@ant-design/icons";
import { App, Button, Modal } from "antd";
import { formatVnd, type Invoice } from "../../../api/types.js";
import { formatNumber } from "../../../ui/format.js";
import { printDocument, printInvoice, printUrl } from "../../printing/printing.js";

/** Thanh toán xong: tổng tiền, tiền thừa, lô đã xuất, in lại hóa đơn và nhãn. */
export function SaleDoneModal({
  invoice: done,
  onClose,
  afterClose,
}: {
  invoice: Invoice | null;
  onClose: () => void;
  afterClose: () => void;
}) {
  const { message } = App.useApp();
  return (
    <Modal
      open={done !== null}
      onCancel={onClose}
      afterClose={afterClose}
      title={null}
      width={460}
      footer={
        <div className="sale-done-actions">
          <Button
            icon={<PrinterOutlined />}
            onClick={() => done && void printInvoice(done.id, message)}
          >
            In lại hóa đơn
          </Button>
          {done?.lines.some((line) => line.usageInstruction) ? (
            <Button
              icon={<PrinterOutlined />}
              onClick={() => void printDocument(printUrl.usageLabels(done.id), message)}
            >
              In nhãn cách dùng
            </Button>
          ) : null}
          <Button type="primary" autoFocus onClick={onClose}>
            Bán đơn mới
          </Button>
        </div>
      }
    >
      {done ? (
        <div className="sale-done">
          <CheckCircleFilled className="sale-done-icon" />
          <h3>Thanh toán thành công</h3>
          <span className="mono">{done.code}</span>
          <div className="sale-done-total">{formatVnd(done.totalAmount)}</div>
          {done.changeAmount !== null ? (
            <div className="sale-done-change">
              Tiền thừa trả khách <strong>{formatVnd(done.changeAmount)}</strong>
            </div>
          ) : null}
          <dl className="sale-done-summary">
            <div>
              <dt>Tạm tính</dt>
              <dd>{formatVnd(done.subtotal)}</dd>
            </div>
            <div>
              <dt>Giảm giá</dt>
              <dd>
                {done.discountAmount - done.loyaltyDiscountAmount > 0
                  ? `−${formatVnd(done.discountAmount - done.loyaltyDiscountAmount)}`
                  : formatVnd(0)}
              </dd>
            </div>
            <div>
              <dt>Trong đó VAT</dt>
              <dd>{formatVnd(done.vatAmount)}</dd>
            </div>
            {done.loyaltyPointsRedeemed > 0 ? (
              <div>
                <dt>Đổi điểm</dt>
                <dd>
                  {formatNumber(done.loyaltyPointsRedeemed)} điểm · −
                  {formatVnd(done.loyaltyDiscountAmount)}
                </dd>
              </div>
            ) : null}
            {done.loyaltyPointsEarned > 0 ? (
              <div>
                <dt>Điểm tích được</dt>
                <dd>+{formatNumber(done.loyaltyPointsEarned)} điểm</dd>
              </div>
            ) : null}
          </dl>
          <div className="sale-done-batches">
            <span>Lô đã xuất (FEFO)</span>
            {done.lines.flatMap((line) =>
              line.allocations.map((allocation) => (
                <div key={allocation.id}>
                  <span>
                    {line.productName} · lô <span className="mono">{allocation.batchNumber}</span>
                  </span>
                  <strong>{allocation.baseQuantity}</strong>
                </div>
              )),
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
