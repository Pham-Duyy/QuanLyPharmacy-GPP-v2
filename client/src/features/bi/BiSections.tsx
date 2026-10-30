import {
  AlertOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  ExclamationCircleOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Empty, Input, Segmented, Skeleton, Table, Tag } from "antd";
import { useState } from "react";
import { getErrorMessage } from "../../api/http.js";
import { formatNumber } from "../../ui/format.js";
import { StatCard, StatGrid } from "../../ui/StatCard.js";
import { RankBars } from "../analytics/AnalysisCharts.js";
import {
  LEVEL_LABELS,
  SEVERITY_LABELS,
  STATUS_LABELS,
  biApi,
  clockText,
  errorText,
  matchesText,
  money,
  type Alert as BiAlert,
  type AnomalyEvent,
  type DemandRow,
  type ExpiryLevel,
  type Lot,
  type Overview,
  type Period,
  type ProductRanking,
  type ProductRow,
  type Severity,
  type StockItem,
  type StockStatus,
  type Stockout,
} from "./bi-api.js";

/**
 * Các khối Phase 2–3 của Bảng điều hành: cảnh báo, thẻ tồn kho, tab Sản phẩm /
 * Tồn kho / Hạn dùng / Bất thường / Dự báo. Chỉ hiển thị số analytics-service đã
 * tính, không tính lại.
 */

const SEVERITY_COLORS: Record<Severity, string> = {
  critical: "red",
  high: "volcano",
  medium: "orange",
  low: "default",
};

const STATUS_COLORS: Record<StockStatus, string> = {
  out_of_stock: "red",
  low: "orange",
  dead: "purple",
  high: "gold",
  normal: "green",
};

/** Màu thanh biểu đồ, cùng ý nghĩa với màu thẻ trạng thái. */
const STATUS_BAR_COLORS: Record<StockStatus, string> = {
  out_of_stock: "#dc2626",
  low: "#f97316",
  dead: "#7c3aed",
  high: "#ca8a04",
  normal: "#16a34a",
};

const LEVEL_BAR_COLORS: Record<ExpiryLevel, string> = {
  expired: "#b91c1c",
  critical: "#ef4444",
  warning: "#f97316",
  monitor: "#ca8a04",
  normal: "#16a34a",
};

const LEVEL_COLORS: Record<ExpiryLevel, string> = {
  expired: "red",
  critical: "volcano",
  warning: "orange",
  monitor: "gold",
  normal: "green",
};

/** Khối cảnh báo nằm đầu trang: việc cần làm ngay, nặng nhất trước. */
export function AlertsPanel({
  store,
  version,
  onOpen,
}: {
  store: string;
  version: number;
  onOpen: (section: BiAlert["section"]) => void;
}) {
  const query = useQuery({
    queryKey: ["bi", "alerts", store, version],
    queryFn: () => biApi.alerts(store),
    placeholderData: (previous) => previous,
  });
  const alerts = query.data?.alerts ?? [];
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 2 }} />;
  if (alerts.length === 0) {
    return (
      <Alert
        type="success"
        showIcon
        style={{ marginBottom: 14 }}
        title="Không có cảnh báo: tồn kho, hạn dùng và doanh thu đều trong ngưỡng"
      />
    );
  }
  return (
    <Card
      size="small"
      style={{ marginBottom: 14 }}
      title={
        <span>
          <AlertOutlined /> Cảnh báo ({alerts.length})
        </span>
      }
    >
      <div className="bi-alerts">
        {alerts.map((alert) => (
          <div key={alert.code} className={`bi-alert severity-${alert.severity}`}>
            <Tag color={SEVERITY_COLORS[alert.severity]}>{SEVERITY_LABELS[alert.severity]}</Tag>
            <div className="bi-alert-body">
              <strong>{alert.title}</strong>
              {alert.items.length ? (
                <span className="muted">
                  {alert.items.join(", ")}
                  {alert.count && alert.count > alert.items.length ? "…" : ""}
                </span>
              ) : null}
            </div>
            <Button size="small" type="link" onClick={() => onOpen(alert.section)}>
              Xem
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Thẻ KPI tồn kho (master prompt §18): giá trị tồn, sắp hết, sắp hết hạn, tiền có nguy cơ. */
export function InventoryCards({ overview }: { overview: Overview }) {
  if (!overview.inventory_available) {
    return (
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        title="Chưa có tệp tồn kho"
        description="Đặt inventory.xlsx (tồn theo lô: cửa hàng, mã thuốc, số lô, số lượng, hạn dùng) vào thư mục data/inbox để xem tồn kho và hạn dùng."
      />
    );
  }
  return (
    <div className="bi-kpis">
      <StatGrid>
        <StatCard
          tone="slate"
          icon={<DatabaseOutlined />}
          label="Giá trị tồn kho"
          value={money(overview.total_stock_value ?? null)}
          hint={
            <span className="muted">
              Theo giá nhập, tệp lưu lúc {clockText(overview.stock_as_of)}
            </span>
          }
        />
        <StatCard
          tone="orange"
          icon={<WarningOutlined />}
          label="Sắp hết / hết hàng"
          value={`${formatNumber(overview.low_stock ?? 0)} / ${formatNumber(overview.out_of_stock ?? 0)}`}
          hint={<span className="muted">Sản phẩm cần nhập thêm</span>}
        />
        <StatCard
          tone="red"
          icon={<ClockCircleOutlined />}
          label="Lô hết hạn trong 30 ngày"
          value={formatNumber(overview.expiring_30d_lots ?? 0)}
          hint={
            overview.expired_lots ? (
              <span className="trend trend-down">
                {overview.expired_lots} lô đã hết hạn còn trong kho
              </span>
            ) : (
              <span className="muted">Không có lô đã hết hạn</span>
            )
          }
        />
        <StatCard
          tone="purple"
          icon={<ExclamationCircleOutlined />}
          label="Có nguy cơ hết hạn"
          value={money(overview.at_risk_value ?? null)}
          hint={<span className="muted">Không bán kịp trước hạn (theo FEFO)</span>}
        />
      </StatGrid>
    </div>
  );
}

const RANKING_OPTIONS: Array<{ value: ProductRanking; label: string }> = [
  { value: "revenue", label: "Doanh thu cao" },
  { value: "profit", label: "Lợi nhuận cao" },
  { value: "low_profit", label: "Biên thấp" },
  { value: "declining", label: "Giảm mạnh" },
  { value: "slow", label: "Bán chậm" },
  { value: "not_sold", label: "Không bán được" },
];

const nameColumn = {
  title: "Thuốc",
  key: "name",
  render: (_: unknown, row: { medicine_name: string | null; medicine_code: string }) => (
    <span>
      {row.medicine_name ?? row.medicine_code} <span className="muted">{row.medicine_code}</span>
    </span>
  ),
};

const percent = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${value.toLocaleString("vi-VN")}%`;

export function ProductsTab({
  store,
  period,
  version,
}: {
  store: string;
  period: Period;
  version: number;
}) {
  const [ranking, setRanking] = useState<ProductRanking>("revenue");
  const query = useQuery({
    queryKey: ["bi", "products", store, period, version],
    queryFn: () => biApi.products(store, period),
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  if (query.isError) return <Alert type="warning" showIcon title={getErrorMessage(query.error)} />;
  if (!data) return <Skeleton active />;

  const stockRanking = ranking === "slow" || ranking === "not_sold";
  const rows: ProductRow[] = stockRanking ? data.stock[ranking] : data[ranking];
  const showStock = stockRanking && rows.some((row) => row.stock_quantity !== undefined);
  const columns = [
    {
      title: "#",
      key: "rank",
      width: 48,
      render: (_: unknown, __: ProductRow, index: number) => index + 1,
    },
    nameColumn,
    ...(ranking === "declining"
      ? [
          {
            title: data.previous_label,
            dataIndex: "previous_revenue",
            align: "right" as const,
            render: money,
          },
          { title: data.label, dataIndex: "revenue", align: "right" as const, render: money },
          {
            title: "Thay đổi",
            dataIndex: "growth_pct",
            align: "right" as const,
            render: (value: number) => <span className="trend trend-down">{percent(value)}</span>,
          },
        ]
      : ranking === "not_sold"
        ? [
            {
              title: "Lần bán cuối",
              key: "last",
              render: (_: unknown, row: ProductRow) =>
                row.last_sale ? `${row.days_since_sale} ngày trước` : "Chưa bán bao giờ",
            },
          ]
        : [
            { title: "Doanh thu", dataIndex: "revenue", align: "right" as const, render: money },
            ...(stockRanking
              ? [
                  {
                    title: "Số đơn",
                    dataIndex: "orders",
                    align: "right" as const,
                    render: formatNumber,
                  },
                ]
              : [
                  {
                    title: "Lợi nhuận",
                    dataIndex: "profit",
                    align: "right" as const,
                    render: money,
                  },
                  {
                    title: "Biên",
                    dataIndex: "margin_pct",
                    align: "right" as const,
                    render: percent,
                  },
                ]),
          ]),
    ...(showStock
      ? [
          {
            title: "Tồn",
            dataIndex: "stock_quantity",
            align: "right" as const,
            render: formatNumber,
          },
          {
            title: "Vốn đang nằm",
            dataIndex: "stock_value",
            align: "right" as const,
            render: money,
          },
        ]
      : []),
  ];

  const hint: Record<ProductRanking, string> = {
    revenue: `${data.label}, xếp theo doanh thu.`,
    profit: `${data.label}, xếp theo lợi nhuận gộp.`,
    low_profit: `${data.label}, biên lợi nhuận thấp nhất (chỉ thuốc có từ 3 đơn).`,
    declining: `So với ${data.previous_label.toLowerCase()} cùng thời điểm (chỉ thuốc kỳ trước có từ 5 đơn).`,
    slow: "30 ngày gần nhất, thuốc còn tồn có bán nhưng doanh thu thấp nhất.",
    not_sold: `30 ngày gần nhất không bán được: ${data.stock.not_sold_total} thuốc còn tồn.`,
  };

  return (
    <>
      <Segmented
        value={ranking}
        options={RANKING_OPTIONS}
        onChange={(value) => setRanking(value as ProductRanking)}
        style={{ marginBottom: 10 }}
      />
      <p className="muted" style={{ margin: "0 0 10px" }}>
        {hint[ranking]}
        {stockRanking && data.stock.basis === "sales_history"
          ? " Chưa có tệp tồn kho: xét các thuốc từng bán."
          : ""}
      </p>
      <Table
        size="small"
        rowKey="medicine_code"
        dataSource={rows}
        columns={columns}
        pagination={false}
        locale={{
          emptyText: (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có thuốc nào" />
          ),
        }}
      />
    </>
  );
}

export function InventoryTab({ store, version }: { store: string; version: number }) {
  const [status, setStatus] = useState<StockStatus | "attention">("attention");
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["bi", "inventory", store, version],
    queryFn: () => biApi.inventory(store),
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  if (query.isError) return <Alert type="warning" showIcon title={getErrorMessage(query.error)} />;
  if (!data) return <Skeleton active />;
  if (!data.available) return <Empty description="Chưa có tệp tồn kho" />;

  const statuses: StockStatus[] = ["out_of_stock", "low", "dead", "high", "normal"];
  const items = data.items.filter(
    (item) =>
      (status === "attention" ? item.status !== "normal" : item.status === status) &&
      matchesText(search, item.medicine_name, item.medicine_code, item.store_code),
  );
  const showStore = store === "ALL";

  return (
    <>
      <div className="bi-grid">
        <div>
          <h4 className="bi-subtitle">Giá trị tồn theo trạng thái</h4>
          <RankBars
            bars={statuses.map((key) => ({
              label: `${STATUS_LABELS[key]} (${data.summary[key].count})`,
              value: data.summary[key].stock_value ?? 0,
              color: STATUS_BAR_COLORS[key],
              share: null,
            }))}
            valueFormat="currency"
          />
        </div>
        <div>
          <h4 className="bi-subtitle">Cách đọc</h4>
          <p className="muted" style={{ margin: 0 }}>
            Số ngày tồn = tồn hiện tại / số bán trung bình mỗi ngày (30 ngày qua). Sắp hết: dưới 7
            ngày hoặc dưới mức tối thiểu. Tồn cao: trên 90 ngày hoặc trên mức tối đa. Tồn chết: còn
            hàng mà 30 ngày không bán. Lô đã hết hạn không tính vào tồn. Tồn theo tệp lưu lúc{" "}
            {clockText(data.stock_as_of)}.
          </p>
        </div>
      </div>
      <div className="bi-toolbar">
        <Segmented
          value={status}
          onChange={(value) => setStatus(value as StockStatus | "attention")}
          options={[
            { value: "attention", label: "Cần chú ý" },
            ...statuses.map((key) => ({
              value: key,
              label: `${STATUS_LABELS[key]} (${data.summary[key].count})`,
            })),
          ]}
        />
        <Input.Search
          allowClear
          placeholder="Tìm thuốc, mã, cửa hàng"
          style={{ maxWidth: 260 }}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <Table<StockItem>
        size="small"
        rowKey={(item) => `${item.store_code}-${item.medicine_code}`}
        dataSource={items}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        columns={[
          ...(showStore ? [{ title: "Cửa hàng", dataIndex: "store_code", width: 90 }] : []),
          nameColumn,
          {
            title: "Trạng thái",
            dataIndex: "status",
            width: 120,
            render: (value: StockStatus) => (
              <Tag color={STATUS_COLORS[value]}>{STATUS_LABELS[value]}</Tag>
            ),
          },
          {
            title: "Tồn",
            key: "stock",
            align: "right" as const,
            render: (_: unknown, item: StockItem) =>
              `${formatNumber(item.stock_quantity)} ${item.unit ?? ""}`,
          },
          {
            title: "Bán TB/ngày",
            dataIndex: "ads",
            align: "right" as const,
            render: (value: number) => value.toLocaleString("vi-VN", { maximumFractionDigits: 1 }),
          },
          {
            title: "Đủ bán",
            key: "cover",
            align: "right" as const,
            render: (_: unknown, item: StockItem) =>
              item.days_of_cover === null
                ? item.status === "dead"
                  ? item.last_sale
                    ? `bán lần cuối ${item.days_since_sale} ngày trước`
                    : "chưa bán bao giờ"
                  : "—"
                : `${item.days_of_cover.toLocaleString("vi-VN")} ngày`,
          },
          { title: "Giá trị", dataIndex: "stock_value", align: "right" as const, render: money },
        ]}
      />
    </>
  );
}

export function ExpiryTab({ store, version }: { store: string; version: number }) {
  const [level, setLevel] = useState<ExpiryLevel | "risk">("risk");
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["bi", "expiry", store, version],
    queryFn: () => biApi.expiry(store),
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  if (query.isError) return <Alert type="warning" showIcon title={getErrorMessage(query.error)} />;
  if (!data) return <Skeleton active />;
  if (!data.available) return <Empty description="Chưa có tệp tồn kho" />;
  if (!data.levels.expired)
    return <Empty description="Cửa hàng này không có lô nào trong tệp tồn kho" />;

  const levels: ExpiryLevel[] = ["expired", "critical", "warning", "monitor"];
  const source = level === "risk" ? data.risk_lots : data.lots.filter((lot) => lot.level === level);
  const lots = source.filter((lot) =>
    matchesText(search, lot.medicine_name, lot.medicine_code, lot.batch_code, lot.store_code),
  );
  const showStore = store === "ALL";

  return (
    <>
      <div className="bi-grid">
        <div>
          <h4 className="bi-subtitle">Giá trị theo mức hạn dùng</h4>
          <RankBars
            bars={[...levels, "normal" as const].map((key) => ({
              label: `${LEVEL_LABELS[key]} (${data.levels[key].lots} lô)`,
              value: data.levels[key].value ?? 0,
              color: LEVEL_BAR_COLORS[key],
              share: null,
            }))}
            valueFormat="currency"
          />
        </div>
        <div>
          <h4 className="bi-subtitle">Nguy cơ hết hạn trước khi bán kịp</h4>
          <p style={{ margin: "0 0 6px" }}>
            <strong>{data.at_risk?.lots ?? 0} lô</strong>,{" "}
            {formatNumber(data.at_risk?.quantity ?? 0)} đơn vị,{" "}
            <strong>{money(data.at_risk?.value ?? null)}</strong>
          </p>
          <p className="muted" style={{ margin: 0 }}>
            Bán theo FEFO (hạn gần bán trước) với tốc độ bán 30 ngày qua; lô nào hết hạn khi chưa
            bán xong thì phần còn lại là nguy cơ. Chỉ xét lô còn ≤ 90 ngày. Nên giảm giá, đẩy bán
            hoặc chuyển sang cửa hàng bán chạy hơn.
          </p>
        </div>
      </div>
      <div className="bi-toolbar">
        <Segmented
          value={level}
          onChange={(value) => setLevel(value as ExpiryLevel | "risk")}
          options={[
            { value: "risk", label: `Có nguy cơ (${data.risk_lots.length})` },
            ...levels.map((key) => ({
              value: key,
              label: `${LEVEL_LABELS[key].split(" (")[0]} (${data.levels[key].lots})`,
            })),
          ]}
        />
        <Input.Search
          allowClear
          placeholder="Tìm thuốc, số lô, cửa hàng"
          style={{ maxWidth: 260 }}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <Table<Lot>
        size="small"
        rowKey={(lot) => `${lot.store_code}-${lot.medicine_code}-${lot.batch_code}`}
        dataSource={lots}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        locale={{
          emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có lô nào" />,
        }}
        columns={[
          ...(showStore ? [{ title: "Cửa hàng", dataIndex: "store_code", width: 90 }] : []),
          nameColumn,
          { title: "Số lô", dataIndex: "batch_code" },
          {
            title: "Hạn dùng",
            key: "expiry",
            render: (_: unknown, lot: Lot) => (
              <span>
                {lot.expiry_date.split("-").reverse().join("/")}{" "}
                <Tag color={LEVEL_COLORS[lot.level]}>
                  {lot.days_left < 0 ? `quá ${-lot.days_left} ngày` : `còn ${lot.days_left} ngày`}
                </Tag>
              </span>
            ),
          },
          {
            title: "FEFO",
            dataIndex: "fefo_rank",
            align: "center" as const,
            render: (value: number | null) =>
              value === null ? "—" : value === 1 ? <Tag color="blue">Bán trước</Tag> : `#${value}`,
          },
          { title: "Tồn", dataIndex: "quantity", align: "right" as const, render: formatNumber },
          {
            title: "Bán kịp",
            dataIndex: "sellable_before_expiry",
            align: "right" as const,
            render: (value: number | null) =>
              value === null ? "—" : formatNumber(Math.round(value)),
          },
          {
            title: "Nguy cơ",
            key: "risk",
            align: "right" as const,
            render: (_: unknown, lot: Lot) =>
              lot.level === "expired" ? (
                <span className="trend trend-down">{money(lot.value)}</span>
              ) : lot.at_risk_quantity ? (
                <span className="trend trend-down">
                  {formatNumber(lot.at_risk_quantity)} · {money(lot.at_risk_value)}
                </span>
              ) : (
                <span className="muted">bán kịp</span>
              ),
          },
        ]}
      />
    </>
  );
}

const KIND_LABELS: Record<string, string> = {
  revenue_drop_day: "Doanh thu tụt",
  revenue_drop_today: "Doanh thu hôm nay tụt",
  revenue_spike: "Doanh thu tăng vọt",
  medicine_drop: "Thuốc bán tụt",
  medicine_spike: "Thuốc bán tăng vọt",
  stock_jump: "Tồn tăng bất thường",
};

const METHOD_LABELS: Record<string, string> = { rule: "Luật", robust_z: "Z-score" };

function dayText(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${day}/${month}`;
}

/** Tab Bất thường: các đợt đã gộp (bước 3.3), phương pháp phát hiện, mức lệch. */
export function AnomaliesTab({ store, version }: { store: string; version: number }) {
  const [direction, setDirection] = useState<"all" | "down" | "up">("all");
  const query = useQuery({
    queryKey: ["bi", "anomalies", store, version],
    queryFn: () => biApi.anomalies(store, 30),
    placeholderData: (previous) => previous,
  });
  if (query.isError) return <Alert type="warning" showIcon title={getErrorMessage(query.error)} />;
  if (!query.data) return <Skeleton active />;
  const events = query.data.events.filter(
    (event) => direction === "all" || event.direction === direction,
  );
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        So mỗi ngày với các cùng thứ trước đó (thứ Hai với thứ Hai), chỉ tính bán lẻ. Một ngày được
        coi là bất thường khi lệch đủ lớn VÀ đủ hiếm (số đơn cũng lệch tới mức ngẫu nhiên khó gây
        ra). Các ngày liền nhau gộp thành một đợt. Chấm đỏ trên biểu đồ doanh thu là các ngày này.
      </p>
      <Segmented
        value={direction}
        onChange={(value) => setDirection(value as "all" | "down" | "up")}
        options={[
          { value: "all", label: `Tất cả (${query.data.events.length})` },
          { value: "down", label: "Tụt" },
          { value: "up", label: "Tăng vọt" },
        ]}
        style={{ marginBottom: 10 }}
      />
      <Table<AnomalyEvent>
        size="small"
        rowKey={(event) =>
          `${event.kind}-${event.store_code}-${event.medicine_code}-${event.start}`
        }
        dataSource={events}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="Không có bất thường trong 30 ngày qua"
            />
          ),
        }}
        columns={[
          {
            title: "Ngày",
            key: "when",
            width: 110,
            render: (_: unknown, event: AnomalyEvent) =>
              event.start === event.end
                ? dayText(event.start)
                : `${dayText(event.start)}–${dayText(event.end)}`,
          },
          {
            title: "Loại",
            dataIndex: "kind",
            width: 170,
            render: (kind: string, event: AnomalyEvent) => (
              <Tag color={event.direction === "down" ? "red" : "blue"}>
                {KIND_LABELS[kind] ?? kind}
              </Tag>
            ),
          },
          { title: "Chi tiết", dataIndex: "message" },
          {
            title: "Phát hiện bằng",
            dataIndex: "methods",
            width: 140,
            render: (methods: string[]) =>
              methods.map((method) => <Tag key={method}>{METHOD_LABELS[method] ?? method}</Tag>),
          },
        ]}
      />
    </>
  );
}

/** Tab Dự báo: nhu cầu 7 ngày từng thuốc kèm khoảng, sai số; ngày dự kiến hết hàng (cần report.inventory). */
export function ForecastTab({
  store,
  version,
  inventoryAllowed,
}: {
  store: string;
  version: number;
  inventoryAllowed: boolean;
}) {
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["bi", "forecast", "demand", store, version],
    queryFn: () => biApi.demandForecast(store),
    placeholderData: (previous) => previous,
  });
  if (query.isError) return <Alert type="warning" showIcon title={getErrorMessage(query.error)} />;
  if (!query.data) return <Skeleton active />;
  const { demand, stockout, data_through: through } = query.data;
  const showStore = store === "ALL";
  const soon = stockout.filter((item) => item.days_until_stockout !== null);
  const rows = [...demand]
    .filter((row) => matchesText(search, row.medicine_name, row.medicine_code, row.store_code))
    .sort((left, right) => right.next_7_days - left.next_7_days);
  const errors = demand
    .map((row) => row.wape_total)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const medianError = errors.length ? errors[Math.floor(errors.length / 2)]! : null;

  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Dữ liệu đến hết {dayText(through)}. Mỗi thuốc ở mỗi cửa hàng chọn mô hình có sai số thấp
        nhất khi thử dự báo lại 4 tuần qua (lặp lại tuần trước, trung bình 4 tuần theo thứ,
        Holt-Winters). Sai số đo trên tổng 7 ngày bán lẻ; trung vị {errorText(medianError)}. Bán
        buôn cộng theo trung bình 28 ngày.
      </p>
      {inventoryAllowed ? (
        <Card
          size="small"
          title={`Dự kiến hết hàng trong 30 ngày tới (${soon.length})`}
          style={{ marginBottom: 14 }}
        >
          {soon.length ? (
            <Table<Stockout>
              size="small"
              rowKey={(item) => `${item.store_code}-${item.medicine_code}`}
              dataSource={soon}
              pagination={{ pageSize: 8, hideOnSinglePage: true }}
              columns={[
                ...(showStore ? [{ title: "Cửa hàng", dataIndex: "store_code", width: 90 }] : []),
                nameColumn,
                {
                  title: "Tồn bán được",
                  dataIndex: "stock_quantity",
                  align: "right" as const,
                  render: formatNumber,
                },
                {
                  title: "Dự kiến hết",
                  key: "date",
                  align: "right" as const,
                  render: (_: unknown, item: Stockout) => (
                    <Tag
                      color={
                        item.days_until_stockout! <= 7
                          ? "red"
                          : item.days_until_stockout! <= 14
                            ? "orange"
                            : "default"
                      }
                    >
                      {dayText(item.stockout_date!)} · sau {item.days_until_stockout} ngày
                    </Tag>
                  ),
                },
              ]}
            />
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="Không thuốc nào dự kiến hết trong 30 ngày"
            />
          )}
        </Card>
      ) : null}
      <div className="bi-toolbar" style={{ marginTop: 0 }}>
        <strong>Nhu cầu 7 ngày tới</strong>
        <Input.Search
          allowClear
          placeholder="Tìm thuốc, mã, cửa hàng"
          style={{ maxWidth: 260 }}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <Table<DemandRow>
        size="small"
        rowKey={(row) => `${row.store_code}-${row.medicine_code}`}
        dataSource={rows}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        columns={[
          ...(showStore ? [{ title: "Cửa hàng", dataIndex: "store_code", width: 90 }] : []),
          nameColumn,
          {
            title: "7 ngày tới",
            key: "next",
            align: "right" as const,
            render: (_: unknown, row: DemandRow) => (
              <span>
                <strong>{formatNumber(Math.round(row.next_7_days))}</strong>
                {row.next_7_low !== null ? (
                  <span className="muted">
                    {" "}
                    ({formatNumber(Math.round(row.next_7_low))}–
                    {formatNumber(Math.round(row.next_7_high!))})
                  </span>
                ) : null}
              </span>
            ),
          },
          {
            title: "So với 7 ngày qua",
            dataIndex: "change_vs_last_7_pct",
            align: "right" as const,
            render: (value: number | null) =>
              value === null ? (
                "—"
              ) : (
                <span className={value < 0 ? "trend trend-down" : "trend trend-up"}>
                  {value > 0 ? "+" : ""}
                  {percent(value)}
                </span>
              ),
          },
          { title: "Sai số", dataIndex: "wape_total", align: "right" as const, render: errorText },
          {
            title: "30 ngày tới",
            dataIndex: "next_30_days",
            align: "right" as const,
            render: (value: number) => formatNumber(Math.round(value)),
          },
        ]}
      />
    </>
  );
}
