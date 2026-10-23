import {
  CalendarOutlined,
  DollarCircleOutlined,
  DownloadOutlined,
  InboxOutlined,
  ReloadOutlined,
  RiseOutlined,
  ShoppingCartOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Empty,
  Input,
  Result,
  Segmented,
  Select,
  Skeleton,
  Table,
  Tabs,
  Tag,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useState, type ReactNode } from "react";
import { http } from "../../api/http.js";
import { formatVnd, type Envelope } from "../../api/types.js";
import { formatDate, formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { StatCard, StatGrid } from "../../ui/StatCard.js";
import { downloadExport } from "../excel/excel-api.js";
import {
  longIdle,
  matchesProduct,
  rankSales,
  type IdleRow,
  type MovementRow,
  type PeriodSummary,
  type PurchaseRow,
  type SalesMetric,
} from "./period-summary.js";

const PAGE_SIZE = 20;
const pagination = (count: number) =>
  count > PAGE_SIZE
    ? { pageSize: PAGE_SIZE, size: "small" as const, showSizeChanger: false }
    : false;
const emptyText = (text: string) => ({
  emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text} />,
});

/** Ô tên thuốc dùng chung cho các bảng: tên đậm, mã bên dưới. */
const productColumn = {
  title: "Thuốc",
  dataIndex: "name",
  render: (_: string, row: { name: string; code: string }) => (
    <div className="cell-main">
      <span className="cell-title">{row.name}</span>
      <span className="cell-sub">{row.code}</span>
    </div>
  ),
};
const quantity = (value: number, row: { unit: string }) => `${formatNumber(value)} ${row.unit}`;
const moneyOrDash = (value: number | null) => (value === null ? "—" : formatVnd(value));

/** Tổng kết một tháng: nhập gì, bán gì, thuốc nào đứng yên, nhập – xuất – tồn. */
export function MonthlySummaryPage() {
  const { message } = App.useApp();
  const [month, setMonth] = useState<Dayjs>(dayjs().startOf("month"));
  const [search, setSearch] = useState("");
  const monthKey = month.format("YYYY-MM");

  const report = useQuery({
    queryKey: ["monthly-summary", monthKey],
    queryFn: async () =>
      (await http.get<Envelope<PeriodSummary>>("/reports/monthly", { params: { month: monthKey } }))
        .data.data,
    placeholderData: (previous) => previous,
  });
  const data = report.data;

  async function exportExcel() {
    if (!data) return;
    try {
      await downloadExport("period-summary", { from: data.from, to: data.to });
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "Không xuất được Excel");
    }
  }

  const filter = <T extends { code: string; name: string }>(rows: T[]) =>
    rows.filter((row) => matchesProduct(row, search));

  return (
    <div>
      <PageHeader
        icon={<CalendarOutlined />}
        title="Tổng kết tháng"
        extra={
          <>
            <DatePicker
              picker="month"
              value={month}
              format="[Tháng] MM/YYYY"
              allowClear={false}
              disabledDate={(value) => value.isAfter(dayjs(), "month")}
              onChange={(value) => value && setMonth(value.startOf("month"))}
            />
            <Button icon={<DownloadOutlined />} disabled={!data} onClick={() => void exportExcel()}>
              Xuất Excel
            </Button>
          </>
        }
      />

      {report.isError ? (
        <Result
          status="warning"
          title="Không tải được tổng kết tháng"
          extra={
            <Button icon={<ReloadOutlined />} onClick={() => void report.refetch()}>
              Thử lại
            </Button>
          }
        />
      ) : null}
      {report.isLoading ? <Skeleton active /> : null}

      {data ? (
        <>
          {data.partial ? (
            <Alert
              type="info"
              showIcon
              className="count-banner"
              title={`Tháng đang chạy: số liệu tính đến hết ngày ${formatDate(data.to)}`}
            />
          ) : null}
          <SummaryCards data={data} />

          <Card>
            <Tabs
              tabBarExtraContent={
                <Input.Search
                  allowClear
                  className="period-search"
                  placeholder="Tìm thuốc theo tên hoặc mã"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              }
              items={[
                {
                  key: "purchases",
                  label: `Nhập hàng (${formatNumber(data.purchases.length)})`,
                  children: <PurchasesTab data={data} rows={filter(data.purchases)} />,
                },
                {
                  key: "sales",
                  label: `Xếp hạng bán (${formatNumber(data.sales.length)})`,
                  children: <SalesTab data={data} search={search} />,
                },
                {
                  key: "idle",
                  label: `Chưa bán / tồn lâu (${formatNumber(data.idle.length)})`,
                  children: <IdleTab data={data} rows={filter(data.idle)} />,
                },
                {
                  key: "movements",
                  label: "Nhập – xuất – tồn",
                  children: <MovementsTab rows={filter(data.movements)} />,
                },
              ]}
            />
          </Card>
        </>
      ) : null}
    </div>
  );
}

function SummaryCards({ data }: { data: PeriodSummary }) {
  const { purchases, sales, idle } = data.summary;
  return (
    <StatGrid>
      <StatCard
        tone="blue"
        icon={<InboxOutlined />}
        label="Nhập hàng"
        value={
          purchases.totalCost === null
            ? `${formatNumber(purchases.receipts)} phiếu`
            : formatVnd(purchases.totalCost)
        }
        hint={`${formatNumber(purchases.receipts)} phiếu · ${formatNumber(purchases.products)} mặt hàng`}
      />
      <StatCard
        tone="green"
        icon={<ShoppingCartOutlined />}
        label="Bán ra (doanh thu thuần)"
        value={formatVnd(sales.netRevenue)}
        hint={`${formatNumber(sales.invoiceCount)} hóa đơn · ${formatNumber(sales.products)} mặt hàng`}
      />
      {sales.grossProfit !== null ? (
        <StatCard
          tone="purple"
          icon={<RiseOutlined />}
          label="Lãi gộp"
          value={formatVnd(sales.grossProfit)}
          hint={
            sales.costExact
              ? sales.netRevenue > 0
                ? `Biên lãi ${formatNumber(Math.round((sales.grossProfit / sales.netRevenue) * 1000) / 10)}%`
                : undefined
              : "Có dòng bán thiếu giá vốn, chưa phải số chính xác"
          }
        />
      ) : null}
      <StatCard
        tone={idle.products > 0 ? "orange" : "slate"}
        icon={<DollarCircleOutlined />}
        label="Có tồn mà không bán được"
        value={`${formatNumber(idle.products)} mặt hàng`}
        hint={idle.value === null ? undefined : `Giá trị tồn ${formatVnd(idle.value)}`}
      />
    </StatGrid>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="period-note">{children}</p>;
}

function PurchasesTab({ data, rows }: { data: PeriodSummary; rows: PurchaseRow[] }) {
  const totals = data.summary.purchases;
  // Chỉ ghi phép tính khi tháng có chiết khấu hoặc VAT; không thì tổng tiền nhập là đủ.
  const breakdown = [
    totals.discountAmount ? ` − chiết khấu ${formatVnd(totals.discountAmount)}` : "",
    totals.vatAmount ? ` + VAT ${formatVnd(totals.vatAmount)}` : "",
  ].join("");
  return (
    <>
      {totals.totalCost !== null ? (
        <Note>
          <b>Tổng tiền nhập {formatVnd(totals.totalCost)}</b>
          {breakdown ? ` = tiền hàng ${formatVnd(totals.goodsAmount ?? 0)}${breakdown}` : ""}, đã
          gồm chiết khấu và VAT. Không tính tồn đầu kỳ và hàng nhận chuyển.
        </Note>
      ) : null}
      <Table
        rowKey="productId"
        size="small"
        dataSource={rows}
        pagination={pagination(rows.length)}
        scroll={{ x: 760 }}
        locale={emptyText("Tháng này chưa nhập thuốc nào")}
        columns={[
          productColumn,
          {
            title: "Số lượng nhập",
            dataIndex: "quantity",
            width: 140,
            align: "right" as const,
            render: quantity,
          },
          ...(data.showCost
            ? [
                {
                  title: "Tiền nhập",
                  dataIndex: "amount",
                  width: 140,
                  align: "right" as const,
                  render: moneyOrDash,
                },
              ]
            : []),
          { title: "Số phiếu", dataIndex: "receipts", width: 90, align: "right" as const },
          {
            title: "Nhà cung cấp",
            dataIndex: "suppliers",
            width: 260,
            render: (suppliers: string[]) => suppliers.join(", ") || "—",
          },
        ]}
      />
      {data.supplierReturns.length > 0 ? (
        <>
          <h4 className="period-subtitle">
            Trả nhà cung cấp trong tháng
            {totals.supplierReturnValue !== null
              ? `: ${formatVnd(totals.supplierReturnValue)}`
              : ""}
          </h4>
          <Table
            rowKey="productId"
            size="small"
            dataSource={data.supplierReturns}
            pagination={pagination(data.supplierReturns.length)}
            columns={[
              productColumn,
              {
                title: "Số lượng trả",
                dataIndex: "quantity",
                width: 140,
                align: "right" as const,
                render: quantity,
              },
              ...(data.showCost
                ? [
                    {
                      title: "Giá trị",
                      dataIndex: "value",
                      width: 140,
                      align: "right" as const,
                      render: moneyOrDash,
                    },
                  ]
                : []),
            ]}
          />
        </>
      ) : null}
    </>
  );
}

function SalesTab({ data, search }: { data: PeriodSummary; search: string }) {
  const [metric, setMetric] = useState<SalesMetric>("revenue");
  const [order, setOrder] = useState<"desc" | "asc">("desc");
  const rows = rankSales(data.sales, metric, order).filter((row) => matchesProduct(row, search));
  return (
    <>
      <div className="count-toolbar">
        <Segmented
          value={metric}
          onChange={(value) => setMetric(value as SalesMetric)}
          options={[
            { value: "revenue", label: "Theo doanh thu" },
            { value: "quantity", label: "Theo số lượng" },
          ]}
        />
        <Segmented
          value={order}
          onChange={(value) => setOrder(value as "desc" | "asc")}
          options={[
            { value: "desc", label: "Bán nhiều nhất trước" },
            { value: "asc", label: "Bán ít nhất trước" },
          ]}
        />
      </div>
      <Note>
        Doanh thu đã trừ hàng khách trả, cùng cách tính với Báo cáo kinh doanh.
        {metric === "quantity"
          ? " Số lượng tính theo đơn vị nhỏ nhất (viên, chai…), chỉ so được giữa các thuốc cùng đơn vị."
          : ""}{" "}
        Thuốc không bán được cái nào nằm ở thẻ "Chưa bán / tồn lâu".
      </Note>
      <Table
        rowKey="productId"
        size="small"
        dataSource={rows}
        pagination={pagination(rows.length)}
        scroll={{ x: 820 }}
        locale={emptyText("Tháng này chưa bán thuốc nào")}
        columns={[
          {
            title: "Hạng",
            dataIndex: "rank",
            width: 64,
            render: (rank: number) => <span className="rank-badge period-rank">{rank}</span>,
          },
          productColumn,
          {
            title: "Số lượng bán",
            dataIndex: "quantity",
            width: 140,
            align: "right" as const,
            render: quantity,
          },
          {
            title: "Doanh thu",
            dataIndex: "revenue",
            width: 140,
            align: "right" as const,
            render: (value: number) => <b>{formatVnd(value)}</b>,
          },
          ...(data.showCost
            ? [
                {
                  title: "Lãi gộp",
                  dataIndex: "grossProfit",
                  width: 130,
                  align: "right" as const,
                  render: moneyOrDash,
                },
              ]
            : []),
          { title: "Số hóa đơn", dataIndex: "invoices", width: 100, align: "right" as const },
          {
            title: "Tỷ trọng",
            dataIndex: "share",
            width: 90,
            align: "right" as const,
            render: (value: number) => `${formatNumber(value)}%`,
          },
        ]}
      />
    </>
  );
}

const IDLE_DAYS = [30, 60, 90];

function IdleTab({ data, rows }: { data: PeriodSummary; rows: IdleRow[] }) {
  const [mode, setMode] = useState<"month" | "long">("month");
  const [days, setDays] = useState(90);
  const shown = mode === "month" ? rows : longIdle(rows, days);
  return (
    <>
      <div className="count-toolbar">
        <Segmented
          value={mode}
          onChange={(value) => setMode(value as "month" | "long")}
          options={[
            { value: "month", label: "Cả tháng không bán" },
            { value: "long", label: "Tồn lâu" },
          ]}
        />
        {mode === "long" ? (
          <label className="expiry-filter">
            Không bán từ
            <Select
              size="small"
              value={days}
              onChange={setDays}
              options={IDLE_DAYS.map((value) => ({ value, label: `${value} ngày trở lên` }))}
            />
          </label>
        ) : null}
      </div>
      <Note>
        Thuốc còn tồn cuối tháng mà cả tháng không bán được cái nào
        {mode === "long" ? `, đã đứng yên từ ${days} ngày trở lên` : ""}.
        {data.showCost ? " Xếp theo giá trị tồn: chỗ đang chôn nhiều tiền nhất lên đầu." : ""}
      </Note>
      <Table
        rowKey="productId"
        size="small"
        dataSource={shown}
        pagination={pagination(shown.length)}
        scroll={{ x: 980 }}
        locale={emptyText("Không có thuốc nào đứng yên")}
        columns={[
          productColumn,
          {
            title: "Tồn cuối tháng",
            dataIndex: "stock",
            width: 130,
            align: "right" as const,
            render: quantity,
          },
          ...(data.showCost
            ? [
                {
                  title: "Giá trị tồn",
                  dataIndex: "value",
                  width: 130,
                  align: "right" as const,
                  render: (value: number, row: IdleRow) =>
                    row.withoutCost ? (
                      <div className="cell-main" style={{ alignItems: "flex-end" }}>
                        <span className="cell-title">{formatVnd(value)}</span>
                        <span className="cell-sub">Có lô chưa có giá vốn</span>
                      </div>
                    ) : (
                      formatVnd(value)
                    ),
                },
              ]
            : []),
          {
            title: "Lần bán gần nhất",
            dataIndex: "lastSoldDate",
            width: 140,
            render: (value: string | null) =>
              value ? formatDate(value) : <Tag variant="filled">Chưa từng bán</Tag>,
          },
          {
            title: "Số ngày không bán",
            dataIndex: "daysIdle",
            width: 130,
            align: "right" as const,
            render: (value: number) => `${formatNumber(value)} ngày`,
          },
          {
            title: "Lần nhập gần nhất",
            dataIndex: "lastReceivedDate",
            width: 140,
            render: formatDate,
          },
          {
            title: "Hạn dùng gần nhất",
            dataIndex: "nearestExpiry",
            width: 140,
            render: formatDate,
          },
        ]}
      />
    </>
  );
}

function MovementsTab({ rows }: { rows: MovementRow[] }) {
  const number = (value: number) => formatNumber(value);
  return (
    <>
      <Note>
        Theo sổ kho, tính bằng đơn vị nhỏ nhất: <b>tồn đầu + nhập − xuất = tồn cuối</b>. Nhập khác:
        tồn đầu kỳ, nhận chuyển từ cửa hàng khác, điều chỉnh tăng. Xuất khác: xuất hủy, trả nhà cung
        cấp, chuyển đi, điều chỉnh giảm. Xuất bán đã trừ hàng khách trả về kho.
      </Note>
      <Table
        rowKey="productId"
        size="small"
        dataSource={rows}
        pagination={pagination(rows.length)}
        scroll={{ x: 900 }}
        locale={emptyText("Tháng này kho không có biến động")}
        columns={[
          {
            ...productColumn,
            render: (_: string, row: MovementRow) => (
              <div className="cell-main">
                <span className="cell-title">{row.name}</span>
                <span className="cell-sub">
                  {row.code} · {row.unit}
                </span>
              </div>
            ),
          },
          {
            title: "Tồn đầu",
            dataIndex: "opening",
            width: 100,
            align: "right" as const,
            render: number,
          },
          {
            title: "Nhập mua",
            dataIndex: "received",
            width: 100,
            align: "right" as const,
            render: number,
          },
          {
            title: "Nhập khác",
            dataIndex: "otherIn",
            width: 100,
            align: "right" as const,
            render: number,
          },
          {
            title: "Xuất bán",
            dataIndex: "sold",
            width: 100,
            align: "right" as const,
            render: number,
          },
          {
            title: "Xuất khác",
            dataIndex: "otherOut",
            width: 100,
            align: "right" as const,
            render: number,
          },
          {
            title: "Tồn cuối",
            dataIndex: "closing",
            width: 100,
            align: "right" as const,
            render: (value: number) => <b>{formatNumber(value)}</b>,
          },
        ]}
      />
    </>
  );
}
