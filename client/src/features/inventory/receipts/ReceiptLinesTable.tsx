import { DeleteOutlined, ExclamationCircleFilled, WarningFilled } from "@ant-design/icons";
import { Button, DatePicker, Empty, Input, InputNumber, Select, Table, Tag, Tooltip } from "antd";
import dayjs from "dayjs";
import type { ProductDetail } from "../../../api/types.js";
import { daysUntil, formatNumber, vnDateKey } from "../../../ui/format.js";
import {
  DATE_FORMAT,
  MIN_SHELF_LIFE_DAYS,
  NEAR_EXPIRY_DAYS,
  shelfLifeDays,
  type DraftLine,
  type Issue,
} from "./receipt-draft.js";

/** Bảng dòng hàng của phiếu nhập nháp: mỗi dòng một sản phẩm + số lô. */
export function ReceiptLinesTable({
  lines,
  loading,
  productById,
  issuesByLine,
  duplicateKeys,
  onChange: changeLine,
  onAddBatch: addBatch,
  onRemove: removeLine,
}: {
  lines: DraftLine[];
  loading: boolean;
  productById: Map<string, ProductDetail>;
  issuesByLine: Map<string, Issue[]>;
  duplicateKeys: Set<string>;
  onChange: (key: string, patch: Partial<DraftLine>) => void;
  onAddBatch: (line: DraftLine) => void;
  onRemove: (key: string) => void;
}) {
  const today = vnDateKey();
  return (
    <Table
      rowKey="key"
      size="small"
      className="receipt-lines"
      loading={loading}
      pagination={false}
      dataSource={lines}
      scroll={{ x: 1100 }}
      rowClassName={(line) =>
        issuesByLine.get(line.key)?.some((issue) => issue.level === "error") ? "line-has-error" : ""
      }
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Chưa có hàng — quét mã vạch hoặc tìm sản phẩm ở ô phía trên"
          />
        ),
      }}
      columns={[
        {
          title: "#",
          key: "index",
          width: 40,
          render: (_: unknown, __: DraftLine, index: number) => index + 1,
        },
        {
          title: "Sản phẩm",
          key: "product",
          width: 250,
          render: (_: unknown, line: DraftLine) => {
            const product = productById.get(line.productId);
            const issues = issuesByLine.get(line.key) ?? [];
            const hasError = issues.some((issue) => issue.level === "error");
            const units = product?.units ?? [line.fallbackUnit];
            const current = units.find((unit) => unit.id === line.unitId) ?? line.fallbackUnit;
            const base = units.find((unit) => unit.conversionToBase === 1);
            const info = [
              product?.registrationNumber
                ? `SĐK: ${product.registrationNumber}`
                : product?.productType === "DRUG"
                  ? "Chưa có số đăng ký"
                  : null,
              [product?.manufacturer, product?.countryOfOrigin].filter(Boolean).join(" · ") || null,
              product?.storageCondition ? `Bảo quản: ${product.storageCondition}` : null,
            ].filter(Boolean);
            return (
              <div className="line-product">
                <div className="line-product-name">
                  <Tooltip
                    title={
                      info.length
                        ? info.map((text) => <div key={text}>{text}</div>)
                        : line.productCode
                    }
                  >
                    <strong>{line.productName}</strong>
                  </Tooltip>
                  {line.extraBatch ? <Tag className="extra-batch-tag">Lô bổ sung</Tag> : null}
                  {issues.length > 0 ? (
                    <Tooltip
                      title={issues.map((issue) => (
                        <div key={issue.text}>{issue.text}</div>
                      ))}
                    >
                      {hasError ? (
                        <ExclamationCircleFilled className="text-danger" />
                      ) : (
                        <WarningFilled className="text-warning" />
                      )}
                    </Tooltip>
                  ) : null}
                </div>
                <div className="line-product-meta">
                  <span>
                    {current.conversionToBase > 1
                      ? `1 ${current.name.toLowerCase()} = ${formatNumber(current.conversionToBase)} ${(base?.name ?? "đơn vị lẻ").toLowerCase()}`
                      : line.productCode}
                  </span>
                  <Button type="link" size="small" onClick={() => addBatch(line)}>
                    + Thêm lô
                  </Button>
                </div>
              </div>
            );
          },
        },
        {
          title: "Đơn vị",
          key: "unit",
          width: 96,
          render: (_: unknown, line: DraftLine) => {
            const units = productById
              .get(line.productId)
              ?.units.filter((unit) => unit.isActive !== false || unit.id === line.unitId) ?? [
              line.fallbackUnit,
            ];
            return (
              <Select
                style={{ width: "100%" }}
                value={line.unitId}
                onChange={(unitId) => changeLine(line.key, { unitId })}
                options={units.map((unit) => ({ value: unit.id, label: unit.name }))}
                popupMatchSelectWidth={false}
              />
            );
          },
        },
        {
          title: (
            <span>
              SL nhập <span className="required-mark">*</span>
            </span>
          ),
          key: "qty",
          width: 96,
          render: (_: unknown, line: DraftLine) => (
            <InputNumber<number>
              style={{ width: "100%" }}
              min={1}
              precision={0}
              value={line.quantity}
              status={line.quantity > 0 ? undefined : "error"}
              onChange={(value) => changeLine(line.key, { quantity: value ?? 0 })}
            />
          ),
        },
        {
          title: "Đơn giá nhập",
          key: "cost",
          width: 120,
          render: (_: unknown, line: DraftLine) => (
            <InputNumber<number>
              style={{ width: "100%" }}
              min={0}
              precision={0}
              value={line.unitCost}
              formatter={(value) => (value ? Number(value).toLocaleString("vi-VN") : "0")}
              parser={(value) => Number((value ?? "").replace(/\D/g, ""))}
              onChange={(value) => changeLine(line.key, { unitCost: value ?? 0 })}
            />
          ),
        },
        {
          title: (
            <span>
              Số lô <span className="required-mark">*</span>
            </span>
          ),
          key: "batch",
          width: 126,
          render: (_: unknown, line: DraftLine) => (
            <Input
              value={line.batchNumber}
              placeholder="Theo bao bì"
              status={line.batchNumber.trim() && !duplicateKeys.has(line.key) ? undefined : "error"}
              onChange={(event) =>
                changeLine(line.key, { batchNumber: event.target.value.toUpperCase() })
              }
              maxLength={50}
            />
          ),
        },
        {
          title: "Ngày SX",
          key: "mfg",
          width: 136,
          render: (_: unknown, line: DraftLine) => (
            <DatePicker
              format={DATE_FORMAT}
              placeholder="dd/mm/yyyy"
              status={
                line.manufactureDate &&
                (line.manufactureDate > today ||
                  (shelfLifeDays(line) ?? MIN_SHELF_LIFE_DAYS) < MIN_SHELF_LIFE_DAYS)
                  ? "error"
                  : undefined
              }
              value={line.manufactureDate ? dayjs(line.manufactureDate) : null}
              disabledDate={(date) =>
                date.isAfter(dayjs(), "day") ||
                (Boolean(line.expiryDate) &&
                  date.isAfter(dayjs(line.expiryDate).subtract(MIN_SHELF_LIFE_DAYS, "day"), "day"))
              }
              onChange={(value) =>
                changeLine(line.key, {
                  manufactureDate: value ? value.format("YYYY-MM-DD") : "",
                })
              }
            />
          ),
        },
        {
          title: (
            <span>
              Hạn dùng <span className="required-mark">*</span>
            </span>
          ),
          key: "exp",
          width: 136,
          render: (_: unknown, line: DraftLine) => {
            const invalid =
              !line.expiryDate ||
              line.expiryDate <= today ||
              (shelfLifeDays(line) ?? MIN_SHELF_LIFE_DAYS) < MIN_SHELF_LIFE_DAYS;
            const near = !invalid && daysUntil(line.expiryDate) <= NEAR_EXPIRY_DAYS;
            return (
              <DatePicker
                format={DATE_FORMAT}
                placeholder="dd/mm/yyyy"
                status={invalid ? "error" : near ? "warning" : undefined}
                value={line.expiryDate ? dayjs(line.expiryDate) : null}
                disabledDate={(date) =>
                  !date.isAfter(dayjs(), "day") ||
                  (Boolean(line.manufactureDate) &&
                    date.isBefore(
                      dayjs(line.manufactureDate).add(MIN_SHELF_LIFE_DAYS, "day"),
                      "day",
                    ))
                }
                onChange={(value) =>
                  changeLine(line.key, {
                    expiryDate: value ? value.format("YYYY-MM-DD") : "",
                  })
                }
              />
            );
          },
        },
        {
          title: "Thành tiền",
          key: "total",
          width: 110,
          align: "right",
          render: (_: unknown, line: DraftLine) => (
            <strong>{formatNumber(line.quantity * line.unitCost)}</strong>
          ),
        },
        {
          title: "",
          key: "remove",
          width: 44,
          align: "center",
          render: (_: unknown, line: DraftLine) => (
            <Tooltip title="Xóa dòng">
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                aria-label="Xóa dòng"
                onClick={() => removeLine(line.key)}
              />
            </Tooltip>
          ),
        },
      ]}
    />
  );
}
