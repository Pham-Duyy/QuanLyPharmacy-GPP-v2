import {
  DollarCircleOutlined,
  FileTextOutlined,
  FundProjectionScreenOutlined,
  PercentageOutlined,
  ReloadOutlined,
  RiseOutlined,
  RobotOutlined,
  ShoppingOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Result, Segmented, Select, Skeleton, Table, Tabs, Tag } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { getErrorMessage } from "../../api/http.js";
import { formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { StatCard, StatGrid, Trend } from "../../ui/StatCard.js";
import { LineChart, RankBars } from "../analytics/AnalysisCharts.js";
import { AgentPanel } from "./AgentPanel.js";
import { AbcTab, ReorderTab } from "./PlanningTabs.js";
import {
  AlertsPanel,
  AnomaliesTab,
  EmptyState,
  ExpiryTab,
  ForecastTab,
  InventoryCards,
  InventoryTab,
  Panel,
  ProductsTab,
} from "./BiSections.js";
import { TABLE_SCROLL, queryState } from "./bi-ui.js";
import {
  ISSUE_LABELS,
  VERSION_POLL_MS,
  ageText,
  biApi,
  canSeeCost,
  canSeeInventory,
  canSeeProducts,
  clockText,
  money,
  errorText,
  trendWithForecast,
  type Alert as BiAlert,
  type BreakdownBy,
  type Period,
  type Summary,
} from "./bi-api.js";

const PERIOD_OPTIONS: Array<{ value: Period; label: string }> = [
  { value: "day", label: "Hôm nay" },
  { value: "week", label: "Tuần này" },
  { value: "month", label: "Tháng này" },
];

/** Biểu đồ: hôm nay xem theo ngày, tuần này theo tuần, tháng này theo tháng. */
const GRAIN_TITLE: Record<Period, string> = {
  day: "30 ngày",
  week: "12 tuần",
  month: "12 tháng",
};

/**
 * Bảng điều hành, hiển thị ngay trên trang Tổng quan cho người có quyền báo cáo (admin theo dõi
 * toàn chuỗi): số liệu kinh doanh do analytics-service tính từ tệp Excel/CSV hoặc PostgreSQL.
 * `storeWork`: phần việc hôm nay của cửa hàng đang chọn (số liệu trực tiếp), đặt trên các tab;
 * vẫn hiện khi analytics-service chưa chạy. Cứ 30 giây hỏi version (rất nhẹ); version tăng thì các khối số
 * liệu tự tải lại vì version nằm trong khóa truy vấn. Không tải lại trang.
 */
export function ExecutiveDashboardPage({
  title = "Bảng điều hành",
  storeWork,
}: {
  title?: string;
  storeWork?: ReactNode;
}) {
  const { message } = App.useApp();
  const [period, setPeriod] = useState<Period>("day");
  const [chosenStore, setChosenStore] = useState<string | null>(null);
  const [tab, setTab] = useState("overview");

  const access = useQuery({ queryKey: ["bi", "access"], queryFn: biApi.access });
  const version = useQuery({
    queryKey: ["bi", "version"],
    queryFn: biApi.version,
    refetchInterval: VERSION_POLL_MS,
    retry: false,
  });
  const v = version.data?.version ?? null;
  const ready = v !== null && access.data !== undefined;
  const allStores = access.data?.allStores ?? false;
  const store = chosenStore ?? (allStores ? "ALL" : (access.data?.stores[0]?.code ?? "ALL"));

  const summary = useQuery({
    queryKey: ["bi", "summary", store, v],
    queryFn: () => biApi.summary(store),
    enabled: ready,
    placeholderData: (previous) => previous,
  });
  const trend = useQuery({
    queryKey: ["bi", "trend", store, period, v],
    queryFn: () => biApi.trend(store, period),
    enabled: ready,
    placeholderData: (previous) => previous,
  });
  const health = useQuery({
    queryKey: ["bi", "health", v],
    queryFn: biApi.health,
    enabled: v !== null,
    refetchInterval: VERSION_POLL_MS,
  });

  // Báo nhẹ khi số liệu đổi trong lúc đang xem, để người xem biết vì sao con số nhảy.
  const seenVersion = useRef<number | null>(null);
  useEffect(() => {
    if (v === null) return;
    if (seenVersion.current !== null && v > seenVersion.current) {
      void message.info(`Số liệu vừa cập nhật từ tệp dữ liệu (bản ${v})`);
    }
    seenVersion.current = v;
  }, [v, message]);

  const storeOptions = buildStoreOptions(access.data, summary.data);
  const inventoryAllowed = canSeeInventory(access.data, store);
  const costAllowed = canSeeCost(access.data, store);
  const productsAllowed = canSeeProducts(access.data, store);
  const canAsk = access.data?.canAsk ?? false;
  const openTab = (key: string) => {
    setTab(key);
    document.querySelector(".bi-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // Bấm một cảnh báo: mở đúng tab chứa chi tiết.
  const openSection = (section: BiAlert["section"]) => {
    const tabs: Record<BiAlert["section"], string> = {
      inventory: "inventory",
      expiry: "expiry",
      anomalies: "anomalies",
      kpi: "overview",
      data_quality: "overview",
    };
    openTab(tabs[section]);
  };
  const kpi = summary.data?.periods[period];
  // Dự báo và bất thường chỉ đổi khi version đổi; vẽ chung lên biểu đồ ngày (bước 3.6).
  const revenueForecast = useQuery({
    queryKey: ["bi", "forecast", "revenue", store, v],
    queryFn: () => biApi.revenueForecast(store),
    enabled: ready && period === "day",
    placeholderData: (previous) => previous,
  });
  const anomalies = useQuery({
    queryKey: ["bi", "anomalies", store, v],
    queryFn: () => biApi.anomalies(store, 30),
    enabled: ready,
    placeholderData: (previous) => previous,
  });
  const forecast = period === "day" ? revenueForecast.data?.revenue : null;
  const chart = trend.data
    ? trendWithForecast(trend.data, forecast, anomalies.data?.events, store)
    : null;

  return (
    <div>
      <PageHeader
        icon={<FundProjectionScreenOutlined />}
        title={title}
        description={
          ready ? (
            <FreshnessBar asOf={summary.data?.as_of} version={v} health={health.data} />
          ) : null
        }
        extra={
          <>
            <Select
              className="bi-store-select"
              value={store}
              options={storeOptions}
              onChange={setChosenStore}
              disabled={storeOptions.length <= 1}
              aria-label="Cửa hàng"
            />
            <Segmented
              className="bi-period"
              value={period}
              options={PERIOD_OPTIONS}
              onChange={(value) => setPeriod(value as Period)}
            />
            {ready && canAsk ? (
              <Button className="bi-ask" icon={<RobotOutlined />} onClick={() => openTab("agent")}>
                Hỏi AI
              </Button>
            ) : null}
          </>
        }
      />

      {version.isError ? (
        <Alert
          type="error"
          showIcon
          className="bi-block"
          title="Không lấy được số liệu phân tích"
          description={getErrorMessage(version.error)}
          action={
            <Button icon={<ReloadOutlined />} onClick={() => void version.refetch()}>
              Thử lại
            </Button>
          }
        />
      ) : null}

      {version.data && v === null ? (
        <Result
          status="info"
          title="Chưa có số liệu"
          subTitle="Thêm medicines.xlsx và sales.xlsx vào thư mục data/inbox của analytics-service."
        />
      ) : null}

      {ready ? (
        <>
          <AlertsPanel store={store} version={v} onOpen={openSection} />

          {summary.isError ? (
            <Alert
              type="warning"
              showIcon
              className="bi-block"
              title={getErrorMessage(summary.error)}
            />
          ) : null}

          {kpi ? (
            <div className="bi-kpis">
              <StatGrid>
                <StatCard
                  tone="green"
                  icon={<DollarCircleOutlined />}
                  label={`Doanh thu ${kpi.label.toLowerCase()}`}
                  value={money(kpi.current.revenue)}
                  hint={
                    <Trend
                      value={kpi.growth.revenue}
                      suffix={`· ${kpi.previous_label.toLowerCase()}`}
                    />
                  }
                />
                {/* Lợi nhuận, biên chỉ khi được xem giá vốn (D23). */}
                {costAllowed ? (
                  <>
                    <StatCard
                      tone="blue"
                      icon={<RiseOutlined />}
                      label="Lợi nhuận gộp"
                      value={money(kpi.current.profit)}
                      hint={
                        <Trend
                          value={kpi.growth.profit}
                          suffix={`· ${kpi.previous_label.toLowerCase()}`}
                        />
                      }
                    />
                    <StatCard
                      tone="cyan"
                      icon={<PercentageOutlined />}
                      label="Biên lợi nhuận"
                      value={
                        kpi.current.margin_pct === null
                          ? "—"
                          : `${kpi.current.margin_pct.toLocaleString("vi-VN")}%`
                      }
                      hint={
                        kpi.current.cost_coverage_pct !== null &&
                        kpi.current.cost_coverage_pct < 100 ? (
                          <span className="muted">
                            {kpi.current.cost_coverage_pct}% doanh thu có giá vốn
                          </span>
                        ) : (
                          <span className="muted">Lợi nhuận / doanh thu</span>
                        )
                      }
                    />
                  </>
                ) : null}
                <StatCard
                  tone="purple"
                  icon={<FileTextOutlined />}
                  label="Số đơn"
                  value={formatNumber(kpi.current.orders)}
                  hint={
                    <Trend
                      value={kpi.growth.orders}
                      suffix={`· ${kpi.previous_label.toLowerCase()}`}
                    />
                  }
                />
                <StatCard
                  tone="orange"
                  icon={<ShoppingOutlined />}
                  label="Trung bình / đơn"
                  value={money(kpi.current.avg_order_value)}
                  hint={
                    <Trend
                      value={kpi.growth.avg_order_value}
                      suffix={`· ${kpi.previous_label.toLowerCase()}`}
                    />
                  }
                />
              </StatGrid>
            </div>
          ) : // Lỗi đã báo ở khối cảnh báo phía trên: không để khung chờ tải quay mãi.
          summary.isError ? null : (
            <Skeleton active paragraph={{ rows: 2 }} />
          )}

          {summary.data?.overview ? <InventoryCards overview={summary.data.overview} /> : null}

          <Panel
            title={
              <>
                Doanh thu <span className="bi-panel-sub">{GRAIN_TITLE[period]}</span>
                {forecast?.status === "ok" ? (
                  <span className="bi-panel-sub">+ dự báo 14 ngày</span>
                ) : null}
              </>
            }
            info={
              <>
                {chart?.hasPartial ? (
                  <p>* Kỳ đang diễn ra, số liệu tính đến {clockText(summary.data?.as_of)}.</p>
                ) : null}
                {forecast?.status === "ok" ? (
                  <p>
                    Nét đứt: dự báo bằng {forecast.model_label}, sai số khi thử lại 4 tuần qua{" "}
                    {errorText(forecast.wape)} (bán lẻ); dải mờ là khoảng tin cậy ~80%. Không dùng
                    AI.
                  </p>
                ) : forecast?.status === "insufficient_data" ? (
                  <p>{forecast.message}</p>
                ) : null}
                <p>Chấm đỏ: ngày bất thường (xem tab Bất thường).</p>
              </>
            }
          >
            {chart ? (
              chart.labels.length ? (
                <LineChart
                  labels={chart.labels}
                  series={chart.series}
                  band={chart.band}
                  markers={chart.markers}
                  valueFormat="currency"
                />
              ) : (
                <EmptyState text="Chưa có dữ liệu bán hàng" />
              )
            ) : trend.isError ? (
              <EmptyState text={getErrorMessage(trend.error)} />
            ) : (
              <Skeleton active />
            )}
          </Panel>

          {storeWork}

          <Tabs
            className="bi-tabs"
            activeKey={tab}
            onChange={setTab}
            items={[
              {
                key: "overview",
                label: "Cơ cấu",
                children: allStores ? (
                  <>
                    <div className="bi-grid">
                      <BreakdownCard title="Nhóm thuốc" by="category" version={v} />
                      <BreakdownCard title="Cửa hàng" by="store" version={v} />
                    </div>
                    <BreakdownCard title="Top 10 thuốc" by="top_medicines" version={v} />
                    <DataQualityCard version={v} />
                  </>
                ) : (
                  <Panel title="Cơ cấu">
                    <EmptyState text="Chỉ dành cho người xem toàn chuỗi" />
                  </Panel>
                ),
              },
              ...(productsAllowed
                ? [
                    {
                      key: "products",
                      label: "Sản phẩm",
                      children: (
                        <ProductsTab
                          store={store}
                          period={period}
                          version={v}
                          costAllowed={costAllowed}
                        />
                      ),
                    },
                  ]
                : []),
              {
                key: "anomalies",
                label: "Bất thường",
                children: <AnomaliesTab store={store} version={v} />,
              },
              {
                key: "forecast",
                label: "Dự báo",
                children: (
                  <ForecastTab store={store} version={v} inventoryAllowed={inventoryAllowed} />
                ),
              },
              ...(inventoryAllowed
                ? [
                    {
                      key: "inventory",
                      label: "Tồn kho",
                      children: <InventoryTab store={store} version={v} />,
                    },
                    {
                      key: "expiry",
                      label: "Hạn dùng",
                      children: <ExpiryTab store={store} version={v} />,
                    },
                    {
                      key: "reorder",
                      label: "Đặt hàng",
                      children: <ReorderTab store={store} version={v} />,
                    },
                  ]
                : []),
              {
                key: "abc",
                label: "ABC",
                children: <AbcTab store={store} version={v} />,
              },
              ...(canAsk
                ? [
                    {
                      key: "agent",
                      label: (
                        <span>
                          <RobotOutlined /> Hỏi AI
                        </span>
                      ),
                      children: <AgentPanel store={store} inventoryAllowed={inventoryAllowed} />,
                    },
                  ]
                : []),
            ]}
          />
        </>
      ) : null}
      {ready ? null : storeWork}
    </div>
  );
}

function buildStoreOptions(
  access: { allStores: boolean; stores: Array<{ code: string; name: string }> } | undefined,
  summary: Summary | undefined,
) {
  if (!access) return [];
  const names = new Map(access.stores.map((store) => [store.code, store.name]));
  if (!access.allStores) {
    return access.stores.map((store) => ({
      value: store.code,
      label: `${store.code} · ${store.name}`,
    }));
  }
  // Toàn chuỗi: các cửa hàng có trong tệp dữ liệu, kèm tên nếu phần mềm có cửa hàng cùng mã.
  const codes = summary?.stores ?? access.stores.map((store) => store.code);
  return [
    { value: "ALL", label: "Toàn chuỗi" },
    ...codes.map((code) => ({
      value: code,
      label: names.has(code) ? `${code} · ${names.get(code)}` : code,
    })),
  ];
}

function FreshnessBar({
  asOf,
  version,
  health,
}: {
  asOf: string | undefined;
  version: number;
  health: Awaited<ReturnType<typeof biApi.health>> | undefined;
}) {
  const failed = health?.last_run?.status === "failed";
  const watching = Boolean(health?.monitor);
  return (
    <span
      className="bi-freshness"
      title={`Bản ${version} · ${watching ? "đang theo dõi tệp" : "không theo dõi tệp"}`}
    >
      <span className={`bi-dot ${failed ? "warn" : watching ? "live" : ""}`} aria-hidden />
      Cập nhật {clockText(asOf)} · {ageText(health?.snapshot?.age_seconds)}
      {failed ? (
        <Tag color="orange" title={health?.last_run?.error_message ?? undefined}>
          Lần đọc tệp gần nhất lỗi
        </Tag>
      ) : null}
    </span>
  );
}

function BreakdownCard({
  title,
  by,
  version,
}: {
  title: string;
  by: BreakdownBy;
  version: number;
}) {
  const query = useQuery({
    queryKey: ["bi", "breakdown", by, version],
    queryFn: () => biApi.breakdown(by),
    placeholderData: (previous) => previous,
  });
  const rows = query.data?.rows ?? [];
  return (
    <Panel
      title={
        <>
          {title} <span className="bi-panel-sub">tháng này</span>
        </>
      }
    >
      {query.isLoading ? (
        <Skeleton active />
      ) : rows.length ? (
        <RankBars
          bars={rows
            .slice(0, 10)
            .map((row) => ({ label: row.label, value: row.revenue, share: row.share_pct }))}
          valueFormat="currency"
        />
      ) : (
        <EmptyState text="Tháng này chưa có doanh thu" />
      )}
    </Panel>
  );
}

const DATASET_LABELS: Record<string, string> = {
  sales: "Bán hàng",
  medicines: "Danh mục thuốc",
  inventory: "Tồn kho",
};

function DataQualityCard({ version }: { version: number }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["bi", "data-quality", version],
    queryFn: biApi.dataQuality,
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  return (
    <Panel
      title="Chất lượng dữ liệu"
      info="Lần đọc tệp gần nhất. Dòng lỗi bị loại khỏi số liệu; dòng cảnh báo vẫn được tính."
      extra={
        data?.total ? (
          <Button size="small" type="link" onClick={() => setOpen(!open)}>
            {open ? "Ẩn chi tiết" : `${formatNumber(data.total)} dòng có vấn đề`}
          </Button>
        ) : null
      }
    >
      {!data ? (
        queryState(query)
      ) : (
        <>
          <div className="bi-quality">
            {Object.entries(data.summary).map(([name, item]) => (
              <div key={name} className="bi-quality-item">
                <span className="muted">{DATASET_LABELS[name] ?? name}</span>
                <strong>
                  {formatNumber(item.rows_valid)}
                  <span className="muted">/{formatNumber(item.rows_read)}</span>
                </strong>
                <span>
                  {item.rows_rejected ? (
                    <Tag color="red">−{formatNumber(item.rows_rejected)}</Tag>
                  ) : (
                    <Tag color="green">Sạch</Tag>
                  )}
                  {item.warnings ? (
                    <Tag color="orange">{formatNumber(item.warnings)} cảnh báo</Tag>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
          {open && data.total ? (
            <Table
              size="small"
              className="bi-quality-table"
              rowKey={(issue) => `${issue.dataset}-${issue.row}-${issue.column}-${issue.code}`}
              dataSource={data.issues}
              pagination={{ pageSize: 8, hideOnSinglePage: true }}
              scroll={TABLE_SCROLL}
              columns={[
                {
                  title: "Tệp",
                  dataIndex: "dataset",
                  width: 110,
                  render: (value: string) => DATASET_LABELS[value] ?? value,
                },
                { title: "Dòng", dataIndex: "row", width: 64 },
                { title: "Cột", dataIndex: "column", width: 130 },
                {
                  title: "Loại",
                  dataIndex: "code",
                  width: 190,
                  render: (code: string, issue) => (
                    <Tag color={issue.severity === "error" ? "red" : "orange"}>
                      {ISSUE_LABELS[code] ?? code}
                    </Tag>
                  ),
                },
                { title: "Chi tiết", dataIndex: "message" },
              ]}
            />
          ) : null}
        </>
      )}
    </Panel>
  );
}
