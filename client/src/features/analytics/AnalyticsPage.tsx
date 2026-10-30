import {
  BulbOutlined,
  CloudUploadOutlined,
  DownloadOutlined,
  FallOutlined,
  FundOutlined,
  RiseOutlined,
  RobotOutlined,
  ShopOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Empty,
  Input,
  Row,
  Segmented,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  Upload,
} from "antd";
import { useEffect, useState } from "react";
import { getErrorMessage } from "../../api/http.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { StatCard, StatGrid, Trend } from "../../ui/StatCard.js";
import { ChangeBars, LineChart, RankBars } from "./AnalysisCharts.js";
import {
  analyzeChain,
  analyzeCsv,
  fetchAnalyticsConfig,
  formatCompact,
  formatFull,
  formatSignedPercent,
  type AnalysisPlan,
  type AnalysisResponse,
  type ChainWindow,
  type ChartSpec,
  type GroupStat,
} from "./analytics-api.js";

type Source = "chain" | "csv";

const WINDOW_OPTIONS: Array<{ value: ChainWindow; label: string; refreshMs: number }> = [
  { value: "day", label: "13 tháng (theo ngày)", refreshMs: 5 * 60_000 },
  { value: "hour", label: "7 ngày (theo giờ)", refreshMs: 60_000 },
  { value: "minute", label: "3 giờ (theo phút)", refreshMs: 15_000 },
];

const SAMPLE_QUESTIONS: Record<Source, string[]> = {
  chain: [
    "Phân tích xu hướng doanh thu 12 tháng gần nhất và cho biết cửa hàng nào giảm mạnh nhất.",
    "So sánh doanh thu các cửa hàng theo tuần.",
    "Số hóa đơn theo giờ của từng cửa hàng trong 7 ngày qua.",
    "Doanh thu theo phút trong 3 giờ gần nhất.",
  ],
  csv: [
    "Phân tích xu hướng doanh thu 12 tháng gần nhất và cho biết chi nhánh nào giảm mạnh nhất.",
    "So sánh tổng doanh thu giữa các chi nhánh.",
    "Doanh thu theo quý của từng chi nhánh.",
  ],
};

const SOURCE_LABEL: Record<AnalysisResponse["planSource"], string> = {
  ai: "AI hiểu câu hỏi",
  rules: "Luật hiểu câu hỏi",
  provided: "Theo kế hoạch trước",
};

const AGGREGATE_LABEL: Record<AnalysisPlan["measure"]["aggregate"], string> = {
  sum: "Tổng",
  mean: "Trung bình",
  count: "Đếm",
  max: "Lớn nhất",
  min: "Nhỏ nhất",
};

const GRAIN_LABEL: Record<string, string> = {
  minute: "phút",
  hour: "giờ",
  day: "ngày",
  week: "tuần",
  month: "tháng",
  quarter: "quý",
  year: "năm",
};

const KIND_LABEL: Record<string, string> = {
  temporal: "Thời gian",
  numeric: "Số",
  categorical: "Phân loại",
  text: "Văn bản",
};

/** Kết quả đang hiện, kèm lúc viết nhận xét và nguồn dữ liệu đã dùng để biết khi nào kết quả cũ. */
type View = {
  response: AnalysisResponse;
  narrativeAt: string;
  inputs: { source: Source; window: ChainWindow; file: File | null };
};

const timeText = (iso: string) =>
  new Date(iso).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/**
 * Trợ lý phân tích (contract §20): người dùng hỏi bằng lời, hệ thống trả về
 * biểu đồ, so sánh nhóm, mức tăng/giảm và nhận xét. Dữ liệu là bán hàng của
 * các cửa hàng được xem, hoặc một tệp CSV bất kỳ.
 */
export function AnalyticsPage() {
  const { message } = App.useApp();
  const config = useQuery({ queryKey: ["analytics", "config"], queryFn: fetchAnalyticsConfig });
  const [source, setSource] = useState<Source>("chain");
  const [chainWindow, setChainWindow] = useState<ChainWindow>("day");
  const [file, setFile] = useState<File | null>(null);
  const [question, setQuestion] = useState(SAMPLE_QUESTIONS.chain[0]!);
  const [view, setView] = useState<View | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const response = view?.response ?? null;

  const analyze = useMutation({
    mutationFn: async (input: { plan?: AnalysisPlan; refresh: boolean }) => {
      if (source === "csv") {
        if (!file) throw new Error("Chọn tệp CSV trước khi phân tích");
        return analyzeCsv({ file, question, plan: input.plan, narrate: !input.refresh });
      }
      return analyzeChain({
        question,
        window: chainWindow,
        plan: input.plan,
        narrate: !input.refresh,
      });
    },
    onSuccess: (data, input) => {
      setView((previous) => {
        if (!input.refresh || !previous)
          return {
            response: data,
            narrativeAt: data.generatedAt,
            inputs: { source, window: chainWindow, file },
          };
        // Tự làm mới không gọi AI: giữ nhận xét AI đã viết, chỉ cập nhật số liệu.
        if (previous.response.narrativeSource === "ai")
          return {
            ...previous,
            response: { ...data, narrative: previous.response.narrative, narrativeSource: "ai" },
          };
        return { ...previous, response: data, narrativeAt: data.generatedAt };
      });
    },
    onError: (error, input) => {
      if (input.refresh) setAutoRefresh(false);
      void message.error(getErrorMessage(error, "Không phân tích được"));
    },
  });

  const run = () => {
    setAutoRefresh(false);
    analyze.mutate({ refresh: false });
  };

  // Tự làm mới chạy lại đúng kế hoạch cũ trên dữ liệu mới: không lập kế hoạch, không gọi AI.
  const refreshMs = WINDOW_OPTIONS.find((option) => option.value === chainWindow)!.refreshMs;
  const plan = response?.plan;
  const { mutate, isPending } = analyze;
  useEffect(() => {
    if (!autoRefresh || source !== "chain" || !plan) return;
    const timer = setInterval(() => {
      if (!isPending) mutate({ plan, refresh: true });
    }, refreshMs);
    return () => clearInterval(timer);
  }, [autoRefresh, source, plan, refreshMs, mutate, isPending]);

  const changeSource = (next: Source) => {
    setSource(next);
    setAutoRefresh(false);
    setQuestion(SAMPLE_QUESTIONS[next][0]!);
  };

  const stale =
    view !== null &&
    (view.inputs.source !== source ||
      (source === "chain" && view.inputs.window !== chainWindow) ||
      (source === "csv" && view.inputs.file !== file));

  return (
    <div className="analysis-page">
      <PageHeader
        icon={<RobotOutlined />}
        title="Trợ lý phân tích"
        description="Đặt câu hỏi bằng tiếng Việt, nhận biểu đồ, so sánh, mức tăng/giảm và nhận xét"
        extra={
          config.data ? (
            config.data.aiEnabled ? (
              <Tag color="blue" icon={<RobotOutlined />}>
                AI: {config.data.model}
              </Tag>
            ) : (
              <Tag icon={<ThunderboltOutlined />}>Chế độ luật (chưa cấu hình AI)</Tag>
            )
          ) : null
        }
      />

      <Card>
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Segmented<Source>
            value={source}
            onChange={changeSource}
            options={[
              { value: "chain", label: "Bán hàng của chuỗi", icon: <ShopOutlined /> },
              { value: "csv", label: "Tệp CSV", icon: <CloudUploadOutlined /> },
            ]}
          />

          {source === "chain" ? (
            <Space wrap>
              <Typography.Text type="secondary">Khoảng dữ liệu:</Typography.Text>
              <Segmented<ChainWindow>
                value={chainWindow}
                onChange={(value) => {
                  setChainWindow(value);
                  setAutoRefresh(false);
                }}
                options={WINDOW_OPTIONS.map(({ value, label }) => ({ value, label }))}
              />
            </Space>
          ) : (
            <div>
              <Upload.Dragger
                accept=".csv,text/csv"
                maxCount={1}
                beforeUpload={(picked) => {
                  setFile(picked);
                  return false;
                }}
                onRemove={() => setFile(null)}
                fileList={file ? [{ uid: "csv", name: file.name, status: "done" }] : []}
              >
                <p className="ant-upload-drag-icon">
                  <CloudUploadOutlined />
                </p>
                <p className="ant-upload-text">Kéo thả hoặc bấm để chọn tệp CSV (tối đa 5 MB)</p>
                <p className="ant-upload-hint">
                  Dòng đầu là tên cột. Nhận dấu phẩy, chấm phẩy; số kiểu 1.234.567; ngày kiểu
                  2025-03-01, 01/03/2025, 03/2025.
                </p>
              </Upload.Dragger>
              <Button
                type="link"
                icon={<DownloadOutlined />}
                href="/samples/doanh_thu_mau.csv"
                download
                style={{ paddingLeft: 0 }}
              >
                Tải tệp mẫu doanh_thu_mau.csv
              </Button>
            </div>
          )}

          <Input.TextArea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            autoSize={{ minRows: 2, maxRows: 4 }}
            maxLength={500}
            placeholder="Ví dụ: Phân tích xu hướng doanh thu 12 tháng gần nhất và cho biết chi nhánh nào giảm mạnh nhất."
            onPressEnter={(event) => {
              if (!event.shiftKey) {
                event.preventDefault();
                run();
              }
            }}
          />
          <Space wrap size={[8, 8]}>
            {SAMPLE_QUESTIONS[source].map((sample) => (
              <Tag.CheckableTag
                key={sample}
                className="analysis-sample"
                checked={question === sample}
                onChange={() => setQuestion(sample)}
              >
                {sample}
              </Tag.CheckableTag>
            ))}
          </Space>
          <Space wrap>
            <Button
              type="primary"
              icon={<BulbOutlined />}
              loading={analyze.isPending && !autoRefresh}
              disabled={source === "csv" && !file}
              onClick={run}
            >
              Phân tích
            </Button>
            {source === "chain" && response ? (
              <Space>
                <Switch checked={autoRefresh} onChange={setAutoRefresh} disabled={stale} />
                <Typography.Text>
                  Tự cập nhật mỗi{" "}
                  {refreshMs >= 60_000 ? `${refreshMs / 60_000} phút` : `${refreshMs / 1000} giây`}
                </Typography.Text>
                <Typography.Text type="secondary">
                  · Số liệu lúc {timeText(response.generatedAt)}
                </Typography.Text>
              </Space>
            ) : null}
          </Space>
        </Space>
      </Card>

      {response ? (
        <AnalysisResult response={response} narrativeAt={view!.narrativeAt} stale={stale} />
      ) : (
        <Card>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Chọn nguồn dữ liệu, đặt câu hỏi rồi bấm Phân tích"
          />
        </Card>
      )}
    </div>
  );
}

function AnalysisResult({
  response,
  narrativeAt,
  stale,
}: {
  response: AnalysisResponse;
  narrativeAt: string | null;
  stale: boolean;
}) {
  const { plan, result, narrative, valueFormat } = response;
  const overall = result.overall;
  const hasTime = plan.time !== null && result.periods.length > 0;
  const groupUnit = plan.groupBy
    ? (response.columnLabels[plan.groupBy.column] ?? plan.groupBy.column)
    : "Nhóm";
  const negativeHeadline =
    (overall.changePercent ?? 0) < 0 ||
    response.facts.some((fact) => fact.kind === "decline" && fact.tone === "negative");

  return (
    <>
      {stale ? (
        <Alert type="info" showIcon title="Nguồn dữ liệu đã đổi. Bấm Phân tích để chạy lại." />
      ) : null}

      <Card
        title={
          <Space>
            <BulbOutlined />
            Kết luận
          </Space>
        }
        extra={
          <Space size={4} wrap>
            <Tag color={response.narrativeSource === "ai" ? "blue" : "default"}>
              {response.narrativeSource === "ai" ? "Nhận xét do AI viết" : "Nhận xét theo luật"}
            </Tag>
            {narrativeAt ? (
              <Typography.Text type="secondary">lúc {timeText(narrativeAt)}</Typography.Text>
            ) : null}
          </Space>
        }
      >
        <Alert
          type={negativeHeadline ? "warning" : "success"}
          showIcon
          title={<strong>{narrative.headline}</strong>}
        />
        {narrative.findings.length > 0 ? (
          <ul className="analysis-findings">
            {narrative.findings.map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
        ) : null}
        {narrative.recommendations.length > 0 ? (
          <>
            <Typography.Title level={5}>Gợi ý việc nên làm</Typography.Title>
            <ul className="analysis-findings">
              {narrative.recommendations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </>
        ) : null}
        {response.narrativeSource === "ai" ? (
          <Typography.Text type="secondary">
            Mọi con số trong nhận xét đã được đối chiếu với bảng tính của hệ thống.
          </Typography.Text>
        ) : null}
      </Card>

      <StatGrid>
        <StatCard
          icon={<FundOutlined />}
          tone="blue"
          label={`${AGGREGATE_LABEL[plan.measure.aggregate]} ${plan.measure.label.toLowerCase()}`}
          value={formatCompact(overall.total, valueFormat)}
          hint={`${result.rowsUsed.toLocaleString("vi-VN")} dòng dữ liệu`}
        />
        {hasTime ? (
          <StatCard
            icon={(overall.changePercent ?? 0) < 0 ? <FallOutlined /> : <RiseOutlined />}
            tone={(overall.changePercent ?? 0) < 0 ? "red" : "green"}
            label="Kỳ cuối so với kỳ đầu"
            value={formatSignedPercent(overall.changePercent)}
            hint={<Trend value={overall.trendPercent} suffix="theo đường xu hướng" />}
          />
        ) : null}
        {hasTime && overall.peak ? (
          <StatCard
            icon={<RiseOutlined />}
            tone="purple"
            label="Kỳ cao nhất"
            value={formatCompact(overall.peak.value, valueFormat)}
            hint={overall.peak.period}
          />
        ) : null}
        {result.groups.length > 1 ? (
          <StatCard
            icon={<ShopOutlined />}
            tone="orange"
            label={`Số ${groupUnit.toLowerCase()}`}
            value={result.groups.length}
            hint={
              result.otherGroupCount > 0
                ? `Gộp ${result.otherGroupCount} nhóm nhỏ vào "Khác"`
                : `Dẫn đầu: ${result.groups[0]!.group}`
            }
          />
        ) : null}
      </StatGrid>

      <Row gutter={[16, 16]}>
        {response.charts.map((chart) => (
          <Col key={chart.id} xs={24} xl={chart.kind === "line" ? 24 : 12}>
            <Card title={chart.title}>
              <ChartView chart={chart} />
            </Card>
          </Col>
        ))}
      </Row>

      {result.groups.length > 1 ? (
        <Card title={`Chi tiết từng ${groupUnit.toLowerCase()}`}>
          <GroupTable groups={result.groups} hasTime={hasTime} response={response} />
        </Card>
      ) : null}

      <Collapse
        items={[
          {
            key: "plan",
            label: `Cách trợ lý hiểu câu hỏi (${SOURCE_LABEL[response.planSource]})`,
            children: <PlanView response={response} />,
          },
        ]}
      />
    </>
  );
}

function ChartView({ chart }: { chart: ChartSpec }) {
  switch (chart.kind) {
    case "line":
      return (
        <LineChart labels={chart.labels} series={chart.series} valueFormat={chart.valueFormat} />
      );
    case "bar":
      return <RankBars bars={chart.bars} valueFormat={chart.valueFormat} />;
    case "change":
      return <ChangeBars bars={chart.bars} valueFormat={chart.valueFormat} />;
  }
}

function GroupTable({
  groups,
  hasTime,
  response,
}: {
  groups: GroupStat[];
  hasTime: boolean;
  response: AnalysisResponse;
}) {
  const format = response.valueFormat;
  const money = (value: number | null) => (value === null ? "—" : formatFull(value, format));
  const tone = (value: number | null) =>
    value === null ? undefined : value < 0 ? "trend-down" : value > 0 ? "trend-up" : undefined;
  return (
    <Table<GroupStat>
      rowKey="group"
      size="middle"
      pagination={false}
      scroll={{ x: true }}
      dataSource={groups}
      columns={[
        {
          title: response.plan.groupBy
            ? (response.columnLabels[response.plan.groupBy.column] ?? response.plan.groupBy.column)
            : "Nhóm",
          dataIndex: "group",
        },
        { title: "Tổng", dataIndex: "total", align: "right", render: money },
        {
          title: "Tỷ trọng",
          dataIndex: "share",
          align: "right",
          render: (value: number | null) =>
            value === null ? "—" : `${value.toLocaleString("vi-VN")}%`,
        },
        ...(hasTime
          ? [
              { title: "Kỳ đầu", dataIndex: "first", align: "right" as const, render: money },
              { title: "Kỳ cuối", dataIndex: "last", align: "right" as const, render: money },
              {
                title: "Tăng/giảm",
                dataIndex: "changePercent",
                align: "right" as const,
                sorter: (a: GroupStat, b: GroupStat) =>
                  (a.changePercent ?? 0) - (b.changePercent ?? 0),
                render: (value: number | null) => (
                  <span className={tone(value)}>{formatSignedPercent(value)}</span>
                ),
              },
              {
                title: "Xu hướng",
                dataIndex: "trendPercent",
                align: "right" as const,
                render: (value: number | null) => (
                  <span className={tone(value)}>{formatSignedPercent(value)}</span>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

function PlanView({ response }: { response: AnalysisResponse }) {
  const { plan, summary } = response;
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {response.warnings.map((warning) => (
        <Alert key={warning} type="warning" showIcon title={warning} />
      ))}
      <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered>
        <Descriptions.Item label="Hiểu câu hỏi là">{plan.intent}</Descriptions.Item>
        <Descriptions.Item label="Đại lượng">
          {AGGREGATE_LABEL[plan.measure.aggregate]} {plan.measure.column ?? "số dòng"}
        </Descriptions.Item>
        <Descriptions.Item label="Thời gian">
          {plan.time
            ? `Cột ${plan.time.column}, theo ${GRAIN_LABEL[plan.time.grain]}${
                plan.time.lastPeriods ? `, ${plan.time.lastPeriods} kỳ gần nhất` : ""
              }`
            : "Không phân tích theo thời gian"}
        </Descriptions.Item>
        <Descriptions.Item label="Nhóm theo">
          {plan.groupBy ? `${plan.groupBy.column} (tối đa ${plan.groupBy.topN} nhóm)` : "Không"}
        </Descriptions.Item>
        <Descriptions.Item label="Bộ lọc" span={2}>
          {plan.filters.length === 0
            ? "Không"
            : plan.filters
                .map((filter) => `${filter.column} ${filter.operator} ${filter.values.join(", ")}`)
                .join("; ")}
        </Descriptions.Item>
      </Descriptions>
      <Typography.Text strong>
        Dữ liệu: {summary.name} · {summary.rowCount.toLocaleString("vi-VN")} dòng
      </Typography.Text>
      <Table
        rowKey="name"
        size="small"
        pagination={false}
        scroll={{ x: true }}
        dataSource={summary.columns}
        columns={[
          { title: "Cột", dataIndex: "name" },
          { title: "Kiểu", dataIndex: "kind", render: (kind: string) => KIND_LABEL[kind] ?? kind },
          { title: "Số giá trị khác nhau", dataIndex: "distinct", align: "right" },
          { title: "Ô trống", dataIndex: "missing", align: "right" },
          {
            title: "Phạm vi / ví dụ",
            key: "range",
            render: (_: unknown, column: AnalysisResponse["summary"]["columns"][number]) =>
              column.kind === "temporal"
                ? `${column.start} → ${column.end}`
                : column.kind === "numeric"
                  ? `${column.min?.toLocaleString("vi-VN")} → ${column.max?.toLocaleString("vi-VN")}`
                  : column.samples.join(", "),
          },
        ]}
      />
      <Typography.Text type="secondary">
        Trợ lý chỉ gửi bản tóm tắt cột và bảng số đã tổng hợp cho AI, không gửi từng dòng dữ liệu.
        Mọi phép tính do máy chủ thực hiện.
      </Typography.Text>
    </Space>
  );
}
