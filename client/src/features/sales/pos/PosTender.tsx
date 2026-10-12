import { BankOutlined, CreditCardOutlined, DollarOutlined } from "@ant-design/icons";
import { InputNumber } from "antd";

import { money } from "./sale-cart.js";

const PAYMENT_METHODS = [
  { value: "CASH", label: "Tiền mặt", icon: <DollarOutlined /> },
  { value: "BANK_TRANSFER", label: "Chuyển khoản", icon: <BankOutlined /> },
  { value: "CARD", label: "Thẻ", icon: <CreditCardOutlined /> },
];

/** Mệnh giá gợi ý cho "Khách đưa": đúng số tiền, rồi làm tròn lên các mệnh giá hay gặp. */
function quickTenders(total: number): number[] {
  if (total <= 0) return [];
  const candidates = [
    total,
    ...[10_000, 50_000, 100_000, 200_000, 500_000].map((step) => Math.ceil(total / step) * step),
  ];
  return [...new Set(candidates)]
    .filter((value) => value >= total)
    .sort((a, b) => a - b)
    .slice(0, 3);
}

/** Hình thức thanh toán; tiền mặt thì ghi khách đưa và gợi ý mệnh giá. */
export function PosTender({
  total,
  paymentMethod,
  onMethodChange,
  tendered,
  onTenderedChange,
  change,
  shortfall,
}: {
  total: number;
  paymentMethod: string;
  onMethodChange: (method: string) => void;
  tendered: number | null;
  onTenderedChange: (value: number | null) => void;
  change: number | null;
  shortfall: number | null;
}) {
  const cash = paymentMethod === "CASH";
  return (
    <>
      <div className="pos-pay-methods" role="radiogroup" aria-label="Hình thức thanh toán">
        {PAYMENT_METHODS.map((method) => (
          <button
            key={method.value}
            type="button"
            role="radio"
            aria-checked={paymentMethod === method.value}
            className={
              paymentMethod === method.value ? "pos-pay-method is-active" : "pos-pay-method"
            }
            onClick={() => onMethodChange(method.value)}
          >
            {method.icon} {method.label}
          </button>
        ))}
      </div>

      {cash ? (
        <div className="pos-tender">
          <div className="pos-summary-row">
            <span>Khách đưa</span>
            <InputNumber<number>
              className="pos-tender-input"
              min={0}
              step={1000}
              value={tendered}
              onChange={onTenderedChange}
              suffix="đ"
              placeholder="Để trống nếu không cần tiền thừa"
              formatter={(value) => (value ? Number(value).toLocaleString("vi-VN") : "")}
              parser={(value) => Number((value ?? "").replace(/\D/g, ""))}
              aria-label="Khách đưa"
            />
          </div>
          {quickTenders(total).length > 0 ? (
            <div className="pos-quick-tender">
              {quickTenders(total).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={tendered === value ? "is-active" : undefined}
                  onClick={() => onTenderedChange(value)}
                >
                  {money(value)}
                </button>
              ))}
            </div>
          ) : null}
          {change !== null ? (
            <div className="pos-summary-row pos-change">
              <span>Tiền thừa</span>
              <strong>{money(change)}</strong>
            </div>
          ) : shortfall !== null ? (
            <div className="pos-summary-row pos-shortfall">
              <span>Còn thiếu</span>
              <strong>{money(shortfall)}</strong>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
