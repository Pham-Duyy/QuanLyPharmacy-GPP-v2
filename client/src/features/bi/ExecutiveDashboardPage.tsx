import {
  DollarCircleOutlined,
  FileTextOutlined,
  FundProjectionScreenOutlined,
  PercentageOutlined,
  ReloadOutlined,
  RiseOutlined,
  ShoppingOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Empty,
  Result,
  Segmented,
  Select,
  Skeleton,
  Table,
  Tabs,
  Tag,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { getErrorMessage } from "../../api/http.js";
import { formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { StatCard, StatGrid, Trend } from "../../ui/StatCard.js";
import { LineChart, RankBars } from "../analytics/AnalysisCharts.js";
import { AlertsPanel, ExpiryTab, InventoryCards, InventoryTab, ProductsTab } from "./BiSections.js";
import {
  ISSUE_LABELS,
  VERSION_POLL_MS,
  ageText,
  biApi,
  canSeeInventory,
  clockText,
  money,
  trendChart,
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
  day: "Doanh thu và lợi nhuận 30 ngày gần nhất",
  week: "Doanh thu và lợi nhuận 12 tuần gần nhất",
  month: "Doanh thu và lợi nhuận 12 tháng gần nhất",
};

/**
 * Bảng điều hành: số liệu kinh doanh từ tệp Excel/CSV mà analytics-service
 * theo dõi. Cứ 30 giây hỏi version (rất nhẹ); version tăng thì các khối số
 * liệu tự tải lại vì version nằm trong khóa truy vấn. Không tải lại trang.
 */
export function ExecutiveDashboardPage() {
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
  // Bấm "Xem" ở một cảnh báo: mở đúng tab chứa chi tiết.
  const openSection = (section: BiAlert["section"]) => {
    const target = {
      inventory: "inventory",
      expiry: "expiry",
      kpi: "overview",
      data_quality: "overview",
    }[section];
    setTab(target);
    document.querySelector(".bi-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const kpi = summary.data?.periods[period];
  const chart = trend.data ? trendChart(trend.data) : null;

  return (
    <div>
      <PageHeader
        icon={<FundProjectionScreenOutlined />}
        title="Bảng điều hành"
        description="Số liệu tự cập nhật khi tệp bán hàng được lưu. Mọi con số do hệ thống tính, không qua AI."
        extra={
          <>
            <Select
              style={{ minWidth: 200 }}
              value={store}
              options={storeOptions}
              onChange={setChosenStore}
              disabled={storeOptions.length <= 1}
              aria-label="Cửa hàng"
            />
            <Segmented
              value={period}
              options={PERIOD_OPTIONS}
              onChange={(value) => setPeriod(value as Period)}
            />
          </>
        }
      />

      {version.isError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 14 }}
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
          subTitle="Dịch vụ phân tích đang chạy nhưng chưa đọc được tệp dữ liệu nào. Đặt medicines.xlsx và sales.xlsx vào thư mục data/inbox của analytics-service."
        />
      ) : null}

      {ready ? (
        <>
          <FreshnessBar asOf={summary.data?.as_of} version={v} health={health.data} />

          <AlertsPanel store={store} version={v} onOpen={openSection} />

          {summary.isError ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 14 }}
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
                      suffix={`so với ${kpi.previous_label.toLowerCase()}`}
                    />
                  }
                />
                <StatCard
                  tone="blue"
                  icon={<RiseOutlined />}
                  label="Lợi nhuận gộp"
                  value={money(kpi.current.profit)}
                  hint={
                    <Trend
                      value={kpi.growth.profit}
                      suffix={`so với ${kpi.previous_label.toLowerCase()}`}
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
                        Chỉ {kpi.current.cost_coverage_pct}% doanh thu có giá vốn
                      </span>
                    ) : (
                      <span className="muted">Lợi nhuận / doanh thu</span>
                    )
                  }
                />
                <StatCard
                  tone="purple"
                  icon={<FileTextOutlined />}
                  label="Số đơn"
                  value={formatNumber(kpi.current.orders)}
                  hint={
                    <Trend
                      value={kpi.growth.orders}
                      suffix={`so với ${kpi.previous_label.toLowerCase()}`}
                    />
                  }
                />
                <StatCard
                  tone="orange"
                  icon={<ShoppingOutlined />}
                  label="Giá trị đơn trung bình"
                  value={money(kpi.current.avg_order_value)}
                  hint={
                    <Trend
                      value={kpi.growth.avg_order_value}
                      suffix={`so với ${kpi.previous_label.toLowerCase()}`}
                    />
                  }
                />
              </StatGrid>
            </div>
          ) : (
            <Skeleton active paragraph={{ rows: 2 }} />
          )}

          {summary.data?.overview ? <InventoryCards overview={summary.data.overview} /> : null}

          <Card title={GRAIN_TITLE[period]} style={{ marginBottom: 14 }}>
            {chart ? (
              chart.labels.length ? (
                <>
                  <LineChart labels={chart.labels} series={chart.series} valueFormat="currency" />
                  {chart.hasPartial ? (
                    <p className="muted" style={{ margin: "6px 0 0" }}>
                      * Kỳ đang diễn ra, số liệu mới tính đến {clockText(summary.data?.as_of)}.
                    </p>
                  ) : null}
                </>
              ) : (
                <Empty description="Chưa có dữ liệu bán hàng trong khoảng này" />
              )
            ) : (
              <Skeleton active />
            )}
          </Card>

          <Tabs
            className="bi-tabs"
            activeKey={tab}
            onChange={setTab}
            items={[
              {
                key: "overview",
                label: "Cơ cấu và dữ liệu",
                children: allStores ? (
                  <>
                    <div className="bi-grid">
                      <BreakdownCard
                        title="Cơ cấu tháng này theo nhóm thuốc"
                        by="category"
                        version={v}
                      />
                      <BreakdownCard
                        title="Doanh thu tháng này theo cửa hàng"
                        by="store"
                        version={v}
                      />
                    </div>
                    <BreakdownCard
                      title="10 thuốc doanh thu cao nhất tháng này"
                      by="top_medicines"
                      version={v}
                    />
                    <DataQualityCard version={v} />
                  </>
                ) : (
                  <Empty description="Cơ cấu toàn chuỗi và chất lượng dữ liệu chỉ dành cho người xem được mọi cửa hàng" />
                ),
              },
              {
                key: "products",
                label: "Sản phẩm",
                children: <ProductsTab store={store} period={period} version={v} />,
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
                  ]
                : []),
            ]}
          />
        </>
      ) : null}
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
  return (
    <div className="bi-freshness">
      <Badge status={failed ? "warning" : "processing"} />
      <span>
        Số liệu tính đến <strong>{clockText(asOf)}</strong> · cập nhật{" "}
        {ageText(health?.snapshot?.age_seconds)} · bản {version}
      </span>
      {health?.monitor ? <Tag color="green">Đang theo dõi tệp</Tag> : <Tag>Không theo dõi tệp</Tag>}
      {failed ? (
        <Tag color="orange" title={health?.last_run?.error_message ?? undefined}>
          Lần đọc tệp gần nhất bị lỗi, đang hiển thị số liệu trước đó
        </Tag>
      ) : null}
    </div>
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
    <Card title={title} style={{ marginBottom: 14 }}>
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
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Tháng này chưa có doanh thu" />
      )}
    </Card>
  );
}

const DATASET_LABELS: Record<string, string> = {
  sales: "Bán hàng",
  medicines: "Danh mục thuốc",
  inventory: "Tồn kho",
};

function DataQualityCard({ version }: { version: number }) {
  const query = useQuery({
    queryKey: ["bi", "data-quality", version],
    queryFn: biApi.dataQuality,
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  return (
    <Card title="Chất lượng dữ liệu của lần đọc tệp gần nhất" style={{ marginBottom: 14 }}>
      {!data ? (
        <Skeleton active />
      ) : (
        <>
          <div className="bi-quality">
            {Object.entries(data.summary).map(([name, item]) => (
              <div key={name}>
                <strong>{DATASET_LABELS[name] ?? name}</strong> ({item.file}):{" "}
                {formatNumber(item.rows_valid)}/{formatNumber(item.rows_read)} dòng hợp lệ
                {item.rows_rejected ? (
                  <Tag color="red" style={{ marginLeft: 8 }}>
                    Loại {formatNumber(item.rows_rejected)} dòng
                  </Tag>
                ) : (
                  <Tag color="green" style={{ marginLeft: 8 }}>
                    Sạch
                  </Tag>
                )}
                {item.warnings ? (
                  <Tag color="orange">{formatNumber(item.warnings)} cảnh báo</Tag>
                ) : null}
              </div>
            ))}
          </div>
          {data.total ? (
            <Table
              size="small"
              rowKey={(issue) => `${issue.dataset}-${issue.row}-${issue.column}-${issue.code}`}
              dataSource={data.issues}
              pagination={{ pageSize: 8, hideOnSinglePage: true }}
              columns={[
                {
                  title: "Tệp",
                  dataIndex: "dataset",
                  width: 120,
                  render: (value: string) => DATASET_LABELS[value] ?? value,
                },
                { title: "Dòng", dataIndex: "row", width: 70 },
                { title: "Cột", dataIndex: "column", width: 140 },
                {
                  title: "Loại",
                  dataIndex: "code",
                  width: 200,
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
    </Card>
  );
}
