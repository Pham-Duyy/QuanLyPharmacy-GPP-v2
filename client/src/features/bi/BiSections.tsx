import {
  AlertOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  ExclamationCircleOutlined,
  RightOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Empty, Input, Segmented, Skeleton, Table, Tag } from "antd";
import { useState, type ReactNode } from "react";
import { formatNumber } from "../../ui/format.js";
import { InfoTip } from "../../ui/InfoTip.js";
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
import { TABLE_SCROLL, queryState } from "./bi-ui.js";

/**
 * Các khối Phase 2–3 của Bảng điều hành: cảnh báo, thẻ tồn kho, tab Sản phẩm /
 * Tồn kho / Hạn dùng / Bất thường / Dự báo. Chỉ hiển thị số analytics-service đã
 * tính, không tính lại. Giao diện ít chữ: giải thích cách tính nằm trong biểu tượng "?".
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

// --- Khung dùng chung -------------------------------------------------------------------------

/** Khung chung của mỗi khối: tiêu đề ngắn, "?" giải thích, thao tác bên phải. */
export function Panel({
  title,
  info,
  extra,
  children,
}: {
  title: ReactNode;
  info?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card
      className="bi-panel"
      title={
        <span className="bi-panel-title">
          {title}
          {info ? <InfoTip>{info}</InfoTip> : null}
        </span>
      }
      extra={extra}
    >
      {children}
    </Card>
  );
}

export function EmptyState({ text }: { text: string }) {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text} />;
}

/** Bộ lọc dạng nút: cuộn ngang được trên điện thoại. */
function Filters({ children }: { children: ReactNode }) {
  return <div className="bi-filters">{children}</div>;
}

function Search({ placeholder, onChange }: { placeholder: string; onChange: (v: string) => void }) {
  return (
    <Input.Search
      allowClear
      size="middle"
      placeholder={placeholder}
      className="bi-search"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

// --- Cảnh báo, thẻ tồn kho ------------------------------------------------------------------

const ALERTS_SHOWN = 3;

/** Khối cảnh báo đầu trang: 3 việc nặng nhất, phần còn lại gấp lại. */
export function AlertsPanel({
  store,
  version,
  onOpen,
}: {
  store: string;
  version: number;
  onOpen: (section: BiAlert["section"]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const query = useQuery({
    queryKey: ["bi", "alerts", store, version],
    queryFn: () => biApi.alerts(store),
    placeholderData: (previous) => previous,
  });
  const alerts = query.data?.alerts ?? [];
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 2 }} />;
  if (alerts.length === 0) {
    return <Alert type="success" showIcon className="bi-block" title="Không có cảnh báo" />;
  }
  const shown = expanded ? alerts : alerts.slice(0, ALERTS_SHOWN);
  const hidden = alerts.length - ALERTS_SHOWN;
  return (
    <Card
      size="small"
      className="bi-block bi-alerts-card"
      title={
        <span className="bi-panel-title">
          <AlertOutlined /> Cảnh báo <span className="bi-count">{alerts.length}</span>
        </span>
      }
      extra={
        hidden > 0 ? (
          <Button size="small" type="link" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Thu gọn" : `+${hidden} cảnh báo`}
          </Button>
        ) : null
      }
    >
      <div className="bi-alerts">
        {shown.map((alert) => (
          <button
            key={alert.code}
            type="button"
            className="bi-alert"
            onClick={() => onOpen(alert.section)}
          >
            <Tag color={SEVERITY_COLORS[alert.severity]}>{SEVERITY_LABELS[alert.severity]}</Tag>
            <span className="bi-alert-body">
              <strong>{alert.title}</strong>
              {alert.items.length ? (
                <span className="bi-alert-items">
                  {alert.items.join(", ")}
                  {alert.count && alert.count > alert.items.length ? "…" : ""}
                </span>
              ) : null}
            </span>
            <RightOutlined className="bi-alert-go" />
          </button>
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
        className="bi-block"
        title="Chưa có tệp tồn kho"
        description="Thêm inventory.xlsx vào data/inbox."
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
          hint={<span className="muted">Giá nhập · {clockText(overview.stock_as_of)}</span>}
        />
        <StatCard
          tone="orange"
          icon={<WarningOutlined />}
          label="Sắp hết / hết hàng"
          value={`${formatNumber(overview.low_stock ?? 0)} / ${formatNumber(overview.out_of_stock ?? 0)}`}
          hint={<span className="muted">Cần nhập thêm</span>}
        />
        <StatCard
          tone="red"
          icon={<ClockCircleOutlined />}
          label="Hết hạn ≤ 30 ngày"
          value={`${formatNumber(overview.expiring_30d_lots ?? 0)} lô`}
          hint={
            overview.expired_lots ? (
              <span className="trend trend-down">{overview.expired_lots} lô đã hết hạn</span>
            ) : (
              <span className="muted">Không có lô quá hạn</span>
            )
          }
        />
        <StatCard
          tone="purple"
          icon={<ExclamationCircleOutlined />}
          label="Nguy cơ hết hạn"
          value={money(overview.at_risk_value ?? null)}
          hint={<span className="muted">Không bán kịp</span>}
        />
      </StatGrid>
    </div>
  );
}

// --- Sản phẩm -------------------------------------------------------------------------------

const RANKING_OPTIONS: Array<{ value: ProductRanking; label: string }> = [
  { value: "revenue", label: "Doanh thu" },
  { value: "profit", label: "Lợi nhuận" },
  { value: "low_profit", label: "Biên thấp" },
  { value: "declining", label: "Giảm mạnh" },
  { value: "slow", label: "Bán chậm" },
  { value: "not_sold", label: "Không bán" },
];

const nameColumn = {
  title: "Thuốc",
  key: "name",
  render: (_: unknown, row: { medicine_name: string | null; medicine_code: string }) => (
    <span className="bi-name">
      {row.medicine_name ?? row.medicine_code} <span className="muted">{row.medicine_code}</span>
    </span>
  ),
};

const storeColumn = { title: "CH", dataIndex: "store_code", width: 64 };

const percent = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${value.toLocaleString("vi-VN")}%`;

export function ProductsTab({
  store,
  period,
  version,
  costAllowed,
}: {
  store: string;
  period: Period;
  version: number;
  /** Được xem lợi nhuận (D23): không thì bỏ cách xếp theo lợi nhuận và cột lợi nhuận, biên. */
  costAllowed: boolean;
}) {
  const [ranking, setRanking] = useState<ProductRanking>("revenue");
  const query = useQuery({
    queryKey: ["bi", "products", store, period, version],
    queryFn: () => biApi.products(store, period),
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  if (!data) return <Panel title="Sản phẩm">{queryState(query)}</Panel>;

  const stockRanking = ranking === "slow" || ranking === "not_sold";
  const rows: ProductRow[] = stockRanking ? data.stock[ranking] : data[ranking];
  const showStock = stockRanking && rows.some((row) => row.stock_quantity !== undefined);
  const columns = [
    {
      title: "#",
      key: "rank",
      width: 44,
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
              title: "Bán lần cuối",
              key: "last",
              render: (_: unknown, row: ProductRow) =>
                row.last_sale ? `${row.days_since_sale} ngày trước` : "Chưa bán",
            },
          ]
        : [
            { title: "Doanh thu", dataIndex: "revenue", align: "right" as const, render: money },
            ...(stockRanking
              ? [
                  {
                    title: "Đơn",
                    dataIndex: "orders",
                    align: "right" as const,
                    render: formatNumber,
                  },
                ]
              : !costAllowed
                ? []
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
            title: "Vốn đọng",
            dataIndex: "stock_value",
            align: "right" as const,
            render: money,
          },
        ]
      : []),
  ];

  const scope: Record<ProductRanking, string> = {
    revenue: data.label,
    profit: data.label,
    low_profit: data.label,
    declining: `so với ${data.previous_label.toLowerCase()}`,
    slow: "30 ngày qua",
    not_sold: `30 ngày qua · ${data.stock.not_sold_total} thuốc`,
  };

  return (
    <Panel
      title={
        <>
          Sản phẩm <span className="bi-panel-sub">{scope[ranking]}</span>
        </>
      }
      info={
        <>
          Biên thấp: thuốc có từ 3 đơn. Giảm mạnh: so cùng thời điểm kỳ trước, thuốc kỳ trước có từ
          5 đơn. Bán chậm, không bán: 30 ngày gần nhất, thuốc còn tồn
          {data.stock.basis === "sales_history" ? " (chưa có tệp tồn: xét thuốc từng bán)" : ""}.
        </>
      }
    >
      <Filters>
        <Segmented
          value={ranking}
          options={
            costAllowed
              ? RANKING_OPTIONS
              : RANKING_OPTIONS.filter((item) => !["profit", "low_profit"].includes(item.value))
          }
          onChange={(value) => setRanking(value as ProductRanking)}
        />
      </Filters>
      <Table
        size="small"
        rowKey="medicine_code"
        dataSource={rows}
        columns={columns}
        pagination={false}
        scroll={TABLE_SCROLL}
        locale={{ emptyText: <EmptyState text="Không có thuốc nào" /> }}
      />
    </Panel>
  );
}

// --- Tồn kho --------------------------------------------------------------------------------

export function InventoryTab({ store, version }: { store: string; version: number }) {
  const [status, setStatus] = useState<StockStatus | "attention">("attention");
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["bi", "inventory", store, version],
    queryFn: () => biApi.inventory(store),
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  if (!data) return <Panel title="Tồn kho">{queryState(query)}</Panel>;
  if (!data.available) {
    return (
      <Panel title="Tồn kho">
        <EmptyState text="Chưa có tệp tồn kho" />
      </Panel>
    );
  }

  const statuses: StockStatus[] = ["out_of_stock", "low", "dead", "high", "normal"];
  const items = data.items.filter(
    (item) =>
      (status === "attention" ? item.status !== "normal" : item.status === status) &&
      matchesText(search, item.medicine_name, item.medicine_code, item.store_code),
  );

  return (
    <Panel
      title={
        <>
          Tồn kho <span className="bi-panel-sub">{clockText(data.stock_as_of)}</span>
        </>
      }
      info={
        <>
          Đủ bán = tồn / bán trung bình mỗi ngày (30 ngày). Sắp hết: dưới 7 ngày hoặc dưới mức tối
          thiểu. Tồn cao: trên 90 ngày hoặc trên mức tối đa. Tồn chết: 30 ngày không bán. Lô hết hạn
          không tính vào tồn.
        </>
      }
      extra={<Search placeholder="Tìm thuốc, mã, cửa hàng" onChange={setSearch} />}
    >
      <div className="bi-bars">
        <RankBars
          bars={statuses.map((key) => ({
            label: `${STATUS_LABELS[key]} · ${data.summary[key].count}`,
            value: data.summary[key].stock_value ?? 0,
            color: STATUS_BAR_COLORS[key],
            share: null,
          }))}
          valueFormat="currency"
        />
      </div>
      <Filters>
        <Segmented
          value={status}
          onChange={(value) => setStatus(value as StockStatus | "attention")}
          options={[
            { value: "attention", label: "Cần chú ý" },
            ...statuses.map((key) => ({
              value: key,
              label: `${STATUS_LABELS[key]} ${data.summary[key].count}`,
            })),
          ]}
        />
      </Filters>
      <Table<StockItem>
        size="small"
        rowKey={(item) => `${item.store_code}-${item.medicine_code}`}
        dataSource={items}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        scroll={TABLE_SCROLL}
        locale={{ emptyText: <EmptyState text="Không có thuốc nào" /> }}
        columns={[
          ...(store === "ALL" ? [storeColumn] : []),
          nameColumn,
          {
            title: "Trạng thái",
            dataIndex: "status",
            width: 110,
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
            title: "Bán/ngày",
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
                    ? `${item.days_since_sale} ngày chưa bán`
                    : "chưa bán"
                  : "—"
                : `${item.days_of_cover.toLocaleString("vi-VN")} ngày`,
          },
          { title: "Giá trị", dataIndex: "stock_value", align: "right" as const, render: money },
        ]}
      />
    </Panel>
  );
}

// --- Hạn dùng -------------------------------------------------------------------------------

export function ExpiryTab({ store, version }: { store: string; version: number }) {
  const [level, setLevel] = useState<ExpiryLevel | "risk">("risk");
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["bi", "expiry", store, version],
    queryFn: () => biApi.expiry(store),
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  if (!data) return <Panel title="Hạn dùng">{queryState(query)}</Panel>;
  if (!data.available || !data.levels.expired) {
    return (
      <Panel title="Hạn dùng">
        <EmptyState text={data.available ? "Không có lô nào" : "Chưa có tệp tồn kho"} />
      </Panel>
    );
  }

  const levels: ExpiryLevel[] = ["expired", "critical", "warning", "monitor"];
  const source = level === "risk" ? data.risk_lots : data.lots.filter((lot) => lot.level === level);
  const lots = source.filter((lot) =>
    matchesText(search, lot.medicine_name, lot.medicine_code, lot.batch_code, lot.store_code),
  );

  return (
    <Panel
      title="Hạn dùng"
      info={
        <>
          Nguy cơ: bán theo FEFO (hạn gần bán trước) với tốc độ bán 30 ngày qua, phần còn lại khi lô
          hết hạn. Chỉ xét lô còn ≤ 90 ngày. Nên giảm giá, đẩy bán hoặc chuyển sang cửa hàng bán
          chạy hơn.
        </>
      }
      extra={<Search placeholder="Tìm thuốc, số lô" onChange={setSearch} />}
    >
      <div className="bi-split">
        <div className="bi-bars">
          <RankBars
            bars={[...levels, "normal" as const].map((key) => ({
              label: `${LEVEL_LABELS[key].split(" (")[0]} · ${data.levels[key].lots}`,
              value: data.levels[key].value ?? 0,
              color: LEVEL_BAR_COLORS[key],
              share: null,
            }))}
            valueFormat="currency"
          />
        </div>
        <div className="bi-highlight">
          <span className="bi-highlight-label">Có nguy cơ không bán kịp</span>
          <strong className="bi-highlight-value">{money(data.at_risk?.value ?? null)}</strong>
          <span className="muted">
            {data.at_risk?.lots ?? 0} lô · {formatNumber(data.at_risk?.quantity ?? 0)} đơn vị
          </span>
        </div>
      </div>
      <Filters>
        <Segmented
          value={level}
          onChange={(value) => setLevel(value as ExpiryLevel | "risk")}
          options={[
            { value: "risk", label: `Có nguy cơ ${data.risk_lots.length}` },
            ...levels.map((key) => ({
              value: key,
              label: `${LEVEL_LABELS[key].split(" (")[0]} ${data.levels[key].lots}`,
            })),
          ]}
        />
      </Filters>
      <Table<Lot>
        size="small"
        rowKey={(lot) => `${lot.store_code}-${lot.medicine_code}-${lot.batch_code}`}
        dataSource={lots}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        scroll={TABLE_SCROLL}
        locale={{ emptyText: <EmptyState text="Không có lô nào" /> }}
        columns={[
          ...(store === "ALL" ? [storeColumn] : []),
          nameColumn,
          { title: "Số lô", dataIndex: "batch_code" },
          {
            title: "Hạn dùng",
            key: "expiry",
            render: (_: unknown, lot: Lot) => (
              <span className="bi-nowrap">
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
    </Panel>
  );
}

// --- Bất thường -----------------------------------------------------------------------------

const KIND_LABELS: Record<string, string> = {
  revenue_drop_day: "Doanh thu tụt",
  revenue_drop_today: "Hôm nay tụt",
  revenue_spike: "Doanh thu tăng vọt",
  medicine_drop: "Thuốc bán tụt",
  medicine_spike: "Thuốc tăng vọt",
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
  if (!query.data) return <Panel title="Bất thường">{queryState(query)}</Panel>;
  const all = query.data.events;
  const events = all.filter((event) => direction === "all" || event.direction === direction);
  return (
    <Panel
      title={
        <>
          Bất thường <span className="bi-panel-sub">30 ngày</span>
        </>
      }
      info={
        <>
          So mỗi ngày với các cùng thứ trước đó, chỉ tính bán lẻ. Bất thường khi lệch đủ lớn và đủ
          hiếm (số đơn cũng lệch). Ngày liền nhau gộp thành một đợt; chấm đỏ trên biểu đồ doanh thu
          là các ngày này.
        </>
      }
    >
      <Filters>
        <Segmented
          value={direction}
          onChange={(value) => setDirection(value as "all" | "down" | "up")}
          options={[
            { value: "all", label: `Tất cả ${all.length}` },
            { value: "down", label: `Tụt ${all.filter((e) => e.direction === "down").length}` },
            { value: "up", label: `Tăng ${all.filter((e) => e.direction === "up").length}` },
          ]}
        />
      </Filters>
      <Table<AnomalyEvent>
        size="small"
        rowKey={(event) =>
          `${event.kind}-${event.store_code}-${event.medicine_code}-${event.start}`
        }
        dataSource={events}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        scroll={{ x: 760 }}
        locale={{ emptyText: <EmptyState text="Không có bất thường" /> }}
        columns={[
          {
            title: "Ngày",
            key: "when",
            width: 100,
            render: (_: unknown, event: AnomalyEvent) =>
              event.start === event.end
                ? dayText(event.start)
                : `${dayText(event.start)}–${dayText(event.end)}`,
          },
          {
            title: "Loại",
            dataIndex: "kind",
            width: 150,
            render: (kind: string, event: AnomalyEvent) => (
              <Tag color={event.direction === "down" ? "red" : "blue"}>
                {KIND_LABELS[kind] ?? kind}
              </Tag>
            ),
          },
          { title: "Chi tiết", dataIndex: "message" },
          {
            title: "Cách phát hiện",
            dataIndex: "methods",
            width: 130,
            render: (methods: string[]) =>
              methods.map((method) => <Tag key={method}>{METHOD_LABELS[method] ?? method}</Tag>),
          },
        ]}
      />
    </Panel>
  );
}

// --- Dự báo ---------------------------------------------------------------------------------

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
  if (!query.data) return <Panel title="Dự báo">{queryState(query)}</Panel>;
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
      {inventoryAllowed ? (
        <Panel
          title={
            <>
              Sắp hết hàng <span className="bi-count">{soon.length}</span>
              <span className="bi-panel-sub">30 ngày tới</span>
            </>
          }
          info="Ngày tồn bán được (không tính lô hết hạn) cạn theo nhu cầu dự báo."
        >
          {soon.length ? (
            <Table<Stockout>
              size="small"
              rowKey={(item) => `${item.store_code}-${item.medicine_code}`}
              dataSource={soon}
              pagination={{ pageSize: 8, hideOnSinglePage: true }}
              scroll={{ x: 520 }}
              columns={[
                ...(showStore ? [storeColumn] : []),
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
                      {dayText(item.stockout_date!)} · {item.days_until_stockout} ngày
                    </Tag>
                  ),
                },
              ]}
            />
          ) : (
            <EmptyState text="Không thuốc nào sắp hết" />
          )}
        </Panel>
      ) : null}
      <Panel
        title={
          <>
            Nhu cầu 7 ngày tới{" "}
            <span className="bi-panel-sub">sai số ~{errorText(medianError)}</span>
          </>
        }
        info={
          <>
            Dữ liệu đến hết {dayText(through)}. Mỗi thuốc ở mỗi cửa hàng chọn mô hình sai số thấp
            nhất khi thử dự báo lại 4 tuần qua (lặp tuần trước, trung bình theo thứ, Holt-Winters).
            Sai số đo trên tổng 7 ngày bán lẻ; bán buôn cộng theo trung bình 28 ngày.
          </>
        }
        extra={<Search placeholder="Tìm thuốc, mã" onChange={setSearch} />}
      >
        <Table<DemandRow>
          size="small"
          rowKey={(row) => `${row.store_code}-${row.medicine_code}`}
          dataSource={rows}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          scroll={TABLE_SCROLL}
          locale={{ emptyText: <EmptyState text="Chưa đủ dữ liệu để dự báo" /> }}
          columns={[
            ...(showStore ? [storeColumn] : []),
            nameColumn,
            {
              title: "7 ngày",
              key: "next",
              align: "right" as const,
              render: (_: unknown, row: DemandRow) => (
                <span className="bi-nowrap">
                  <strong>{formatNumber(Math.round(row.next_7_days))}</strong>
                  {row.next_7_low !== null ? (
                    <span className="muted">
                      {" "}
                      {formatNumber(Math.round(row.next_7_low))}–
                      {formatNumber(Math.round(row.next_7_high!))}
                    </span>
                  ) : null}
                </span>
              ),
            },
            {
              title: "So 7 ngày qua",
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
            {
              title: "Sai số",
              dataIndex: "wape_total",
              align: "right" as const,
              render: errorText,
            },
            {
              title: "30 ngày",
              dataIndex: "next_30_days",
              align: "right" as const,
              render: (value: number) => formatNumber(Math.round(value)),
            },
          ]}
        />
      </Panel>
    </>
  );
}
