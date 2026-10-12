import { Input, InputNumber, Select, Space } from "antd";
import { money } from "./sale-cart.js";

type DiscountType = "PERCENT" | "AMOUNT";

/** Giảm giá trên cả đơn: theo số tiền hoặc phần trăm, có lý do; vai trò không được giảm thì khóa. */
export function PosDiscount({
  type,
  onTypeChange,
  value,
  onValueChange,
  reason,
  onReasonChange,
  disabled,
  estimated,
}: {
  type: DiscountType;
  onTypeChange: (type: DiscountType) => void;
  value: number;
  onValueChange: (value: number) => void;
  reason: string;
  onReasonChange: (reason: string) => void;
  disabled: boolean;
  estimated: number;
}) {
  return (
    <>
      <div className="pos-summary-row pos-discount">
        <span>Giảm giá</span>
        <Space.Compact>
          <Select
            value={type}
            onChange={onTypeChange}
            aria-label="Kiểu giảm giá"
            options={[
              { value: "AMOUNT", label: "đ" },
              { value: "PERCENT", label: "%" },
            ]}
            disabled={disabled}
          />
          <InputNumber<number>
            min={0}
            max={type === "PERCENT" ? 100 : undefined}
            value={value}
            onChange={(next) => onValueChange(next ?? 0)}
            formatter={(value) => (value ? Number(value).toLocaleString("vi-VN") : "0")}
            parser={(value) => Number((value ?? "").replace(/\D/g, ""))}
            aria-label="Mức giảm giá"
            disabled={disabled}
          />
        </Space.Compact>
      </div>
      {value > 0 ? (
        <Input
          placeholder="Lý do giảm giá (bắt buộc)"
          value={reason}
          onChange={(event) => onReasonChange(event.target.value)}
          aria-label="Lý do giảm giá"
        />
      ) : null}
      {estimated > 0 ? (
        <div className="pos-summary-row muted">
          <span>Giảm tạm tính</span>
          <span>−{money(estimated)}</span>
        </div>
      ) : null}
    </>
  );
}
