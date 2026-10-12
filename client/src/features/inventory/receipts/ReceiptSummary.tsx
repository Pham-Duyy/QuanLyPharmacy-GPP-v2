import {
  CheckCircleFilled,
  ExclamationCircleFilled,
  InfoCircleOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { InputNumber, Typography } from "antd";
import { formatVnd } from "../../../api/types.js";
import type { ReceiptCheck } from "./receipt-draft.js";

/** Kiểm tra trước khi lưu và tổng tiền của phiếu nhập nháp. */
export function ReceiptSummary({
  checks,
  blocked,
  goodsAmount,
  discountAmount,
  discountTooHigh,
  vatAmount,
  totalAmount,
  onDiscountChange: setDiscountAmount,
  onVatChange: setVatAmount,
}: {
  checks: ReceiptCheck[];
  blocked: boolean;
  goodsAmount: number;
  discountAmount: number;
  discountTooHigh: boolean;
  vatAmount: number;
  totalAmount: number;
  onDiscountChange: (value: number) => void;
  onVatChange: (value: number) => void;
}) {
  return (
    <div className="receipt-bottom">
      <div className="receipt-checks">
        <h4>
          {blocked ? (
            <ExclamationCircleFilled className="text-danger" />
          ) : (
            <CheckCircleFilled className="text-success" />
          )}{" "}
          Kiểm tra trước khi lưu
        </h4>
        <ul className="check-list">
          {checks.map((check) => (
            <li
              key={check.label}
              className={
                check.state === "ok" ? "done" : check.state === "warning" ? "warn" : "fail"
              }
            >
              {check.state === "ok" ? (
                <CheckCircleFilled />
              ) : check.state === "warning" ? (
                <WarningFilled />
              ) : (
                <ExclamationCircleFilled />
              )}
              <span>{check.label}</span>
            </li>
          ))}
          <li className="info">
            <InfoCircleOutlined />
            <span>Kiểm nhận thực tế (bao bì, cảm quan) thực hiện sau khi lưu nháp.</span>
          </li>
        </ul>
      </div>
      <div className="receipt-totals">
        <div>
          <strong>Tổng tiền hàng</strong>
          <strong>{formatVnd(goodsAmount)}</strong>
        </div>
        <div>
          <span>Chiết khấu phiếu</span>
          <InputNumber<number>
            min={0}
            precision={0}
            value={discountAmount}
            status={discountTooHigh ? "error" : undefined}
            suffix="₫"
            formatter={(value) => (value ? Number(value).toLocaleString("vi-VN") : "0")}
            parser={(value) => Number((value ?? "").replace(/\D/g, ""))}
            onChange={(value) => setDiscountAmount(value ?? 0)}
          />
        </div>
        <div>
          <span>Thuế theo hóa đơn</span>
          <InputNumber<number>
            min={0}
            precision={0}
            value={vatAmount}
            suffix="₫"
            formatter={(value) => (value ? Number(value).toLocaleString("vi-VN") : "0")}
            parser={(value) => Number((value ?? "").replace(/\D/g, ""))}
            onChange={(value) => setVatAmount(value ?? 0)}
          />
        </div>
        <div className="receipt-grand-total">
          <strong>Tổng giá trị phiếu</strong>
          <strong>{formatVnd(totalAmount)}</strong>
        </div>
        <Typography.Text type="secondary" className="field-hint">
          Chiết khấu và thuế được phân bổ vào giá vốn từng lô theo tỷ lệ thành tiền.
        </Typography.Text>
      </div>
    </div>
  );
}
