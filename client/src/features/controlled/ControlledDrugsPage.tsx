import { SafetyCertificateOutlined, WarningFilled } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, Card, DatePicker, Empty, Select, Skeleton, Table, Tag, Tooltip } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";
import { formatDate, formatDateTime, formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useAuth } from "../auth/AuthProvider.js";
import { ExcelExportButton } from "../excel/ExcelButtons.js";
import { rangeParams } from "../excel/excel-api.js";

type ControlledProduct = { id: string; code: string; name: string; strengthText: string | null; baseUnitName: string; isActive: boolean; stockOnHand: number };

type LedgerEntry = {
  occurredAt: string;
  documentCode: string;
  documentType: string;
  description: string;
  inQuantity: number;
  outQuantity: number;
  balanceAfter: number;
  batchNumber: string;
  expiryDate: string;
  partyName: string | null;
  buyerName: string | null;
  buyerIdNumber: string | null;
  buyerAddress: string | null;
  relationship: string | null;
  prescriptionCode: string | null;
  prescriberName: string | null;
  facilityName: string | null;
  handledBy: string | null;
};

type LedgerProduct = {
  productId: string;
  code: string;
  name: string;
  strengthText: string | null;
  baseUnitName: string;
  openingBalance: number;
  totalIn: number;
  totalOut: number;
  closingBalance: number;
  stockOnHand: number;
  entries: LedgerEntry[];
};

type LedgerResponse = {
  from: string;
  to: string;
  products: LedgerProduct[];
  mismatches: Array<{ productId: string; name: string; closingBalance: number; stockOnHand: number }>;
};

export function ControlledDrugsPage() {
  const { can } = useAuth();
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => [dayjs().startOf("month"), dayjs()]);
  const [productId, setProductId] = useState<string | undefined>();

  const products = useQuery({
    queryKey: ["controlled-products"],
    queryFn: async () => (await http.get<Envelope<ControlledProduct[]>>("/controlled-drugs")).data.data,
  });

  const params = { from: range[0].format("YYYY-MM-DD"), to: range[1].format("YYYY-MM-DD"), productId };
  const ledger = useQuery({
    queryKey: ["controlled-ledger", params],
    queryFn: async () => (await http.get<Envelope<LedgerResponse>>("/controlled-drugs/ledger", { params })).data.data,
  });

  const columns = [
    {
      title: "Thời gian",
      dataIndex: "occurredAt",
      width: 150,
      render: (value: string, row: LedgerEntry) => (
        <div className="cell-main">
          <span className="cell-title">{formatDateTime(value)}</span>
          <span className="cell-sub">{row.documentCode}</span>
        </div>
      ),
    },
    {
      title: "Diễn giải",
      dataIndex: "description",
      width: 190,
      render: (value: string, row: LedgerEntry) => (
        <div className="cell-main">
          <span className="cell-title">{value}</span>
          <span className="cell-sub">
            Lô {row.batchNumber} · HSD {formatDate(row.expiryDate)}
          </span>
        </div>
      ),
    },
    { title: "Nhập", dataIndex: "inQuantity", width: 80, align: "right" as const, render: (value: number) => (value ? formatNumber(value) : "—") },
    { title: "Xuất", dataIndex: "outQuantity", width: 80, align: "right" as const, render: (value: number) => (value ? formatNumber(value) : "—") },
    {
      title: "Tồn sau",
      dataIndex: "balanceAfter",
      width: 90,
      align: "right" as const,
      render: (value: number) => <b>{formatNumber(value)}</b>,
    },
    {
      title: "Người mua / người bệnh",
      dataIndex: "buyerName",
      render: (_: string | null, row: LedgerEntry) =>
        row.buyerName ? (
          <div className="cell-main">
            <span className="cell-title">
              {row.buyerName} {row.relationship ? <Tag variant="filled">{row.relationship}</Tag> : null}
            </span>
            <span className="cell-sub">
              {row.buyerIdNumber} · {row.buyerAddress}
              {row.partyName ? ` · Người bệnh: ${row.partyName}` : ""}
            </span>
          </div>
        ) : (
          <span className="cell-sub">{row.partyName ?? "—"}</span>
        ),
    },
    {
      title: "Đơn thuốc",
      dataIndex: "prescriptionCode",
      width: 210,
      render: (value: string | null, row: LedgerEntry) =>
        value ? (
          <div className="cell-main">
            <span className="cell-title">{value}</span>
            <span className="cell-sub">
              {row.prescriberName}
              {row.facilityName ? ` · ${row.facilityName}` : ""}
            </span>
          </div>
        ) : (
          <span className="cell-sub">—</span>
        ),
    },
    { title: "Người thực hiện", dataIndex: "handledBy", width: 150, render: (value: string | null) => value ?? "—" },
  ];

  return (
    <div>
      <PageHeader
        icon={<SafetyCertificateOutlined />}
        title="Thuốc kiểm soát đặc biệt"
        description="Sổ theo dõi xuất nhập thuốc gây nghiện, hướng thần và tiền chất. Sổ dựng lại từ chứng từ thật nên luôn khớp tồn kho."
        extra={
          <>
            <DatePicker.RangePicker
              value={range}
              allowClear={false}
              format="DD/MM/YYYY"
              disabledDate={(day) => day.isAfter(dayjs(), "day")}
              presets={[
                { label: "Tháng này", value: [dayjs().startOf("month"), dayjs()] },
                { label: "Tháng trước", value: [dayjs().subtract(1, "month").startOf("month"), dayjs().subtract(1, "month").endOf("month")] },
                { label: "Quý này", value: [dayjs().startOf("month").subtract(dayjs().month() % 3, "month"), dayjs()] },
              ]}
              onChange={(value) => {
                if (value?.[0] && value[1]) setRange([value[0], value[1]]);
              }}
            />
            {can("controlled.read") ? <ExcelExportButton type="controlled-ledger" label="Xuất sổ" range={rangeParams(range)} tooltip="Xuất sổ theo dõi ra Excel để in hoặc nộp khi thanh tra" /> : null}
          </>
        }
      />

      {products.isError ? <Alert type="error" showIcon title="Không đọc được danh mục thuốc kiểm soát đặc biệt" description={getErrorMessage(products.error)} /> : null}

      {products.data && products.data.length === 0 ? (
        <Empty description="Nhà thuốc chưa có thuốc nào thuộc nhóm kiểm soát đặc biệt. Đánh dấu ở danh mục Thuốc & sản phẩm nếu có kinh doanh nhóm này." />
      ) : null}

      {products.data && products.data.length > 0 ? (
        <>
          <div className="controlled-toolbar">
            <Select
              allowClear
              placeholder="Tất cả thuốc kiểm soát đặc biệt"
              value={productId}
              onChange={setProductId}
              className="controlled-select"
              options={products.data.map((item) => ({
                value: item.id,
                label: `${item.name}${item.strengthText ? ` · ${item.strengthText}` : ""} — tồn ${formatNumber(item.stockOnHand)} ${item.baseUnitName}`,
              }))}
            />
          </div>

          {ledger.data?.mismatches.length ? (
            <Alert
              type="error"
              showIcon
              icon={<WarningFilled />}
              className="controlled-banner"
              title="Sổ không khớp tồn kho"
              description={ledger.data.mismatches
                .map((item) => `${item.name}: sổ ${formatNumber(item.closingBalance)}, kho ${formatNumber(item.stockOnHand)}`)
                .join(" · ")}
            />
          ) : null}

          {ledger.isLoading ? <Skeleton active /> : null}

          {(ledger.data?.products ?? []).map((product) => (
            <Card
              key={product.productId}
              className="controlled-card"
              title={
                <span>
                  {product.name}
                  {product.strengthText ? <span className="cell-sub"> · {product.strengthText}</span> : null}
                </span>
              }
              extra={
                <div className="controlled-figures">
                  <span>
                    Đầu kỳ <b>{formatNumber(product.openingBalance)}</b>
                  </span>
                  <span>
                    Nhập <b className="count-diff-plus">+{formatNumber(product.totalIn)}</b>
                  </span>
                  <span>
                    Xuất <b className="count-diff-minus">−{formatNumber(product.totalOut)}</b>
                  </span>
                  <span>
                    Cuối kỳ <b>{formatNumber(product.closingBalance)}</b> {product.baseUnitName}
                  </span>
                </div>
              }
            >
              <Table
                rowKey={(row) => `${row.documentCode}-${row.occurredAt}-${row.batchNumber}-${row.balanceAfter}`}
                size="small"
                dataSource={product.entries}
                columns={columns}
                scroll={{ x: 1000 }}
                pagination={product.entries.length > 25 ? { pageSize: 25, size: "small" } : false}
                locale={{ emptyText: "Kỳ này không có phát sinh. Số dư mang sang giữ nguyên." }}
                summary={() => (
                  <Table.Summary fixed>
                    <Table.Summary.Row>
                      <Table.Summary.Cell index={0} colSpan={2}>
                        <b>Cộng kỳ (đơn vị: {product.baseUnitName})</b>
                      </Table.Summary.Cell>
                      <Table.Summary.Cell index={2} align="right">
                        <b>{formatNumber(product.totalIn)}</b>
                      </Table.Summary.Cell>
                      <Table.Summary.Cell index={3} align="right">
                        <b>{formatNumber(product.totalOut)}</b>
                      </Table.Summary.Cell>
                      <Table.Summary.Cell index={4} align="right">
                        <Tooltip title={`Tồn kho hiện tại: ${formatNumber(product.stockOnHand)}`}>
                          <b>{formatNumber(product.closingBalance)}</b>
                        </Tooltip>
                      </Table.Summary.Cell>
                      <Table.Summary.Cell index={5} colSpan={3} />
                    </Table.Summary.Row>
                  </Table.Summary>
                )}
              />
            </Card>
          ))}
        </>
      ) : null}
    </div>
  );
}
