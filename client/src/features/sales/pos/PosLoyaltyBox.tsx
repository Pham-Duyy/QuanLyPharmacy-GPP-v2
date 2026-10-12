import { GiftOutlined } from "@ant-design/icons";
import { Button, InputNumber } from "antd";
import { formatNumber } from "../../../ui/format.js";

import { money } from "./sale-cart.js";
import type { LoyaltySettings } from "../../loyalty/loyalty-api.js";

/** Điểm của khách và ô đổi điểm trừ vào đơn. */
export function PosLoyaltyBox({
  program,
  loading,
  pointsAvailable,
  canRedeem,
  maxRedeem,
  redeemPoints,
  onRedeemChange,
  appliedRedeem,
  loyaltyDiscount,
  eligibleSubtotal,
}: {
  program: LoyaltySettings;
  loading: boolean;
  pointsAvailable: number;
  canRedeem: boolean;
  maxRedeem: number;
  redeemPoints: number;
  onRedeemChange: (points: number) => void;
  appliedRedeem: number;
  loyaltyDiscount: number;
  eligibleSubtotal: number;
}) {
  return (
    <div className="pos-loyalty">
      <div className="pos-loyalty-head">
        <span>
          <GiftOutlined /> Điểm của khách
        </span>
        <strong>{loading ? "…" : `${formatNumber(pointsAvailable)} điểm`}</strong>
      </div>
      {canRedeem ? (
        <>
          <div className="pos-loyalty-input">
            <InputNumber<number>
              min={0}
              max={maxRedeem}
              step={program.minRedeemPoints || 1}
              value={redeemPoints}
              onChange={(value) => onRedeemChange(value ?? 0)}
              aria-label="Số điểm khách muốn đổi"
              placeholder="Số điểm đổi"
            />
            <Button size="small" onClick={() => onRedeemChange(maxRedeem)}>
              Đổi tối đa {formatNumber(maxRedeem)}
            </Button>
            {redeemPoints > 0 ? (
              <Button size="small" type="text" onClick={() => onRedeemChange(0)}>
                Bỏ
              </Button>
            ) : null}
          </div>
          <span className="muted">
            {appliedRedeem > 0
              ? `Giảm ${money(loyaltyDiscount)} · sau đơn này còn ${formatNumber(pointsAvailable - appliedRedeem)} điểm`
              : `Mỗi lần đổi từ ${formatNumber(program.minRedeemPoints)} điểm, 1 điểm = ${money(program.pointValue)}`}
          </span>
        </>
      ) : (
        <span className="muted">
          {eligibleSubtotal === 0
            ? "Giỏ hàng chưa có mặt hàng nào được đổi điểm."
            : pointsAvailable < program.minRedeemPoints
              ? `Cần tối thiểu ${formatNumber(program.minRedeemPoints)} điểm mới đổi được.`
              : `Hóa đơn này chỉ giảm được tối đa ${program.maxRedeemPercent}% giá trị hàng tính điểm, chưa đủ một lần đổi.`}
        </span>
      )}
    </div>
  );
}
