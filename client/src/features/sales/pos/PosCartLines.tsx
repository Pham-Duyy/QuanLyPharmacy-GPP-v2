import {
  BarcodeOutlined,
  CheckCircleFilled,
  DeleteOutlined,
  EnvironmentOutlined,
  MinusOutlined,
  PlusOutlined,
  ShoppingCartOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { Button, Input, InputNumber, Select, Typography } from "antd";
import { useState } from "react";
import type { PrescriptionDetail } from "../../../api/types.js";
import { ProductThumb } from "../../catalog/products/ProductThumb.js";
import { remainingText } from "./prescription-cart.js";

import {
  type CartLine,
  lineTotal,
  matchingPrescriptionItems,
  money,
  needsPrescription,
  unitOf,
  usageOf,
} from "./sale-cart.js";

/** Các dòng thuốc trong đơn: đơn vị, số lượng, dòng đơn thuốc, cách dùng, nhãn quét. */
export function PosCartLines({
  cart,
  prescription,
  scanning,
  onUpdate,
  onRemove,
}: {
  cart: CartLine[];
  prescription: PrescriptionDetail | null;
  scanning: boolean;
  onUpdate: (key: string, patch: Partial<CartLine>) => void;
  onRemove: (key: string) => void;
}) {
  const [editingUsage, setEditingUsage] = useState<string | null>(null);
  return (
    <div className="pos-cart">
      {cart.length === 0 ? (
        <div className="pos-cart-empty">
          <ShoppingCartOutlined />
          <strong>Chưa có thuốc trong đơn</strong>
          <span>Quét mã vạch hoặc bấm “Thêm” ở danh sách bên trái.</span>
        </div>
      ) : (
        <>
          <div className="pos-cart-head" aria-hidden>
            <span>Thuốc / Đơn vị</span>
            <span>Số lượng</span>
            <span className="col-num">Thành tiền</span>
            <span />
          </div>
          {cart.map((line) => {
            const unit = unitOf(line);
            const rx = needsPrescription(line.product.drugClass);
            const candidates = rx ? matchingPrescriptionItems(line.product.id, prescription) : [];
            const price = unit?.currentPrice?.salePrice;
            return (
              <div className="pos-cart-line" key={line.key}>
                <div className="pos-cart-product">
                  <ProductThumb
                    src={line.product.images?.[0]?.thumbUrl}
                    alt={line.product.name}
                    size={44}
                  />
                  <div className="pos-cart-text">
                    <strong>{line.product.name}</strong>
                    {line.product.shelfLocation || scanning ? (
                      <span className="pos-cart-tags">
                        {line.product.shelfLocation ? (
                          <span className="pos-shelf">
                            <EnvironmentOutlined /> {line.product.shelfLocation}
                          </span>
                        ) : null}
                        {scanning ? (
                          line.scanned > 0 ? (
                            <span className="pos-scan is-ok">
                              <CheckCircleFilled /> Đã quét
                            </span>
                          ) : (
                            <span className="pos-scan">
                              <BarcodeOutlined /> Chưa quét
                            </span>
                          )
                        ) : null}
                      </span>
                    ) : null}
                    <span className="pos-cart-unit">
                      <Select
                        size="small"
                        variant="borderless"
                        value={line.unitId}
                        aria-label={`Đơn vị ${line.product.name}`}
                        onChange={(unitId) => onUpdate(line.key, { unitId })}
                        options={line.product.units
                          .filter((item) => item.isSellable !== false && item.isActive !== false)
                          .map((item) => ({ value: item.id, label: item.name }))}
                        popupMatchSelectWidth={false}
                      />
                      <span className="muted">
                        · {price === null || price === undefined ? "Chưa đặt giá" : money(price)}
                      </span>
                    </span>
                    {rx ? (
                      candidates.length === 0 ? (
                        <Typography.Text type="danger" className="pos-cart-rx">
                          <WarningFilled />{" "}
                          {prescription ? "Không có trong đơn thuốc" : "Cần chọn đơn thuốc"}
                        </Typography.Text>
                      ) : (
                        <Select
                          size="small"
                          className="pos-cart-rx"
                          value={line.prescriptionItemId ?? undefined}
                          placeholder="Chọn dòng đơn thuốc"
                          onChange={(prescriptionItemId) =>
                            onUpdate(line.key, { prescriptionItemId })
                          }
                          options={candidates.map((item) => ({
                            value: item.id,
                            label: `${remainingText(item, line.product.units.find((candidate) => candidate.conversionToBase === 1)?.name)} còn lại theo đơn`,
                          }))}
                        />
                      )
                    ) : null}
                    {editingUsage === line.key ? (
                      <Input
                        size="small"
                        autoFocus
                        className="pos-cart-usage"
                        maxLength={300}
                        placeholder="Ví dụ: Uống 1 viên x 2 lần/ngày sau ăn"
                        defaultValue={usageOf(line, prescription)}
                        aria-label={`Cách dùng ${line.product.name}`}
                        onBlur={(event) => {
                          onUpdate(line.key, { usage: event.target.value });
                          setEditingUsage(null);
                        }}
                        onPressEnter={(event) => {
                          onUpdate(line.key, { usage: event.currentTarget.value });
                          setEditingUsage(null);
                        }}
                      />
                    ) : (
                      <Button
                        type="link"
                        size="small"
                        className="pos-cart-usage"
                        onClick={() => setEditingUsage(line.key)}
                      >
                        {usageOf(line, prescription)
                          ? `Cách dùng: ${usageOf(line, prescription)}`
                          : "+ Cách dùng"}
                      </Button>
                    )}
                  </div>
                </div>
                <div className="pos-qty">
                  <Button
                    icon={<MinusOutlined />}
                    aria-label={`Giảm số lượng ${line.product.name}`}
                    disabled={line.quantity <= 1}
                    onClick={() => onUpdate(line.key, { quantity: Math.max(1, line.quantity - 1) })}
                  />
                  <InputNumber
                    min={1}
                    precision={0}
                    controls={false}
                    value={line.quantity}
                    onChange={(quantity) => onUpdate(line.key, { quantity: quantity ?? 1 })}
                    aria-label={`Số lượng ${line.product.name}`}
                  />
                  <Button
                    icon={<PlusOutlined />}
                    aria-label={`Tăng số lượng ${line.product.name}`}
                    onClick={() => onUpdate(line.key, { quantity: line.quantity + 1 })}
                  />
                </div>
                <strong className="col-num pos-cart-total">{money(lineTotal(line))}</strong>
                <Button
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label={`Xóa ${line.product.name} khỏi đơn`}
                  onClick={() => onRemove(line.key)}
                />
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
