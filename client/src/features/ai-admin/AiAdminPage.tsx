import {
  ApiOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  DatabaseOutlined,
  ReloadOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Drawer,
  Empty,
  Form,
  InputNumber,
  Progress,
  Row,
  Select,
  Skeleton,
  Switch,
  Table,
  Tag,
} from "antd";
import { isAxiosError } from "axios";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getErrorMessage } from "../../api/http.js";
import { formatDateTime } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { ageText, biApi, clockText, resetDateText } from "../bi/bi-api.js";
import {
  aiAdminApi,
  LOG_STATUS,
  usd,
  type AiLogItem,
  type AiLogStatus,
  type AiSettings,
} from "./ai-admin-api.js";

const forbidden = (error: unknown) => isAxiosError(error) && error.response?.status === 403;

const TOOL_NAMES: Record<string, string> = {
  get_business_summary: "Tổng quan",
  get_revenue: "Doanh thu",
  get_profit: "Lợi nhuận",
  get_sales_trend: "Xu hướng",
  get_breakdown: "Cơ cấu",
  get_top_products: "Xếp hạng thuốc",
  get_slow_products: "Bán chậm",
  get_inventory: "Tồn kho",
  get_low_stock: "Sắp hết hàng",
  get_expiring_products: "Sắp hết hạn",
  get_expired_products: "Đã hết hạn",
  get_anomalies: "Bất thường",
  get_forecast: "Dự báo",
  get_data_quality: "Chất lượng dữ liệu",
  get_reorder_suggestions: "Đặt hàng",
  get_abc_analysis: "ABC",
};

/**
 * Quản trị Phân tích & AI (Phase 6, bước 6.5, D27): một chỗ cho chủ nhà thuốc theo dõi nguồn
 * số liệu, bật/tắt và đặt hạn mức trợ lý AI, xem ai đã hỏi gì và tốn bao nhiêu.
 */
export function AiAdminPage() {
  return (
    <div>
      <PageHeader icon={<RobotOutlined />} title="Phân tích & AI" />
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={10}>
          <SourceCard />
        </Col>
        <Col xs={24} xl={14}>
          <SettingsCard />
        </Col>
        <Col span={24}>
          <LogsCard />
        </Col>
      </Row>
    </div>
  );
}

// --- Nguồn số liệu ----------------------------------------------------------------------------

function SourceCard() {
  const health = useQuery({
    queryKey: ["bi", "health"],
    queryFn: biApi.health,
    refetchInterval: 30_000,
    retry: false,
  });
  const data = health.data;
  const ok = data?.status === "ok";
  return (
    <Card
      className="card-fill"
      title={
        <span>
          <DatabaseOutlined /> Nguồn số liệu
        </span>
      }
      extra={
        <Button
          type="text"
          size="small"
          icon={<ReloadOutlined />}
          loading={health.isFetching}
          onClick={() => void health.refetch()}
          aria-label="Tải lại"
        />
      }
    >
      {health.isLoading ? <Skeleton active paragraph={{ rows: 4 }} /> : null}
      {health.isError ? (
        <Alert
          type="error"
          showIcon
          title="Không kết nối được dịch vụ phân tích"
          description={getErrorMessage(health.error)}
        />
      ) : null}
      {data ? (
        <dl className="kv-list">
          <div>
            <dt>Trạng thái</dt>
            <dd>
              {ok ? (
                <Tag color="green" icon={<CheckCircleFilled />}>
                  Hoạt động
                </Tag>
              ) : (
                <Tag color="red" icon={<CloseCircleFilled />}>
                  Có lỗi
                </Tag>
              )}
            </dd>
          </div>
          <div>
            <dt>Nguồn</dt>
            <dd>
              {data.monitor
                ? data.monitor.source === "postgres"
                  ? "PostgreSQL của phần mềm"
                  : "Tệp Excel/CSV"
                : "Không theo dõi (chỉ đọc bản đã tính)"}
            </dd>
          </div>
          <div>
            <dt>Số liệu tính lúc</dt>
            <dd>
              {data.snapshot
                ? `${ageText(data.snapshot.age_seconds)} · bản ${data.snapshot.version}`
                : "Chưa có"}
            </dd>
          </div>
          {data.last_run ? (
            <div>
              <dt>Lần xử lý gần nhất</dt>
              <dd>
                {data.last_run.status === "success" ? "Thành công" : "Lỗi"} ·{" "}
                {clockText(data.last_run.finished_at)}
                {data.last_run.duration_ms !== undefined
                  ? ` · ${(data.last_run.duration_ms / 1000).toFixed(1).replace(".", ",")} giây`
                  : null}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {data?.last_run?.error_message ? (
        <Alert
          type="error"
          showIcon
          title={data.last_run.error_message}
          style={{ marginTop: 12 }}
        />
      ) : null}
      <p className="muted" style={{ margin: "12px 0 0", fontSize: 12.5 }}>
        Số liệu tự cập nhật khoảng 30 giây sau khi dữ liệu nguồn thay đổi.
      </p>
    </Card>
  );
}

// --- Cấu hình trợ lý AI -----------------------------------------------------------------------

function SettingsCard() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<AiSettings>();
  const settings = useQuery({
    queryKey: ["ai-admin", "settings"],
    queryFn: aiAdminApi.settings,
    retry: false,
  });
  const status = useQuery({ queryKey: ["bi", "agent-status"], queryFn: biApi.agentStatus });
  const save = useMutation({
    mutationFn: aiAdminApi.saveSettings,
    onSuccess: (saved) => {
      queryClient.setQueryData(["ai-admin", "settings"], saved);
      void queryClient.invalidateQueries({ queryKey: ["bi", "agent-status"] });
      void message.success("Đã lưu cấu hình trợ lý AI");
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được")),
  });

  useEffect(() => {
    if (settings.data) form.setFieldsValue(settings.data.settings);
  }, [settings.data, form]);

  const budget = settings.data?.budget;
  const percent = budget && budget.monthlyUsd > 0 ? (budget.spentUsd / budget.monthlyUsd) * 100 : 0;

  return (
    <Card
      className="card-fill"
      title={
        <span>
          <RobotOutlined /> Trợ lý AI
        </span>
      }
      extra={
        status.data ? (
          <Tag icon={<ApiOutlined />} color={status.data.enabled ? "green" : "orange"}>
            {status.data.enabled ? "Đã có API key" : "Chưa có API key"}
          </Tag>
        ) : null
      }
    >
      {settings.isLoading ? <Skeleton active paragraph={{ rows: 4 }} /> : null}
      {settings.isError ? (
        forbidden(settings.error) ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Cấu hình AI chung của chuỗi cần quyền Cài đặt ở vai trò toàn chuỗi"
          />
        ) : (
          <Alert type="error" showIcon title={getErrorMessage(settings.error)} />
        )
      ) : null}
      {settings.data && budget ? (
        <>
          <div className="ai-budget">
            <div className="ai-budget-head">
              <span>Chi tiêu tháng này</span>
              <strong>
                {usd(budget.spentUsd)} / {usd(budget.monthlyUsd)}
              </strong>
            </div>
            <Progress
              percent={Math.min(Math.round(percent), 100)}
              showInfo={false}
              status={budget.exceeded ? "exception" : percent >= 80 ? "active" : "normal"}
              strokeColor={
                budget.exceeded ? undefined : percent >= 80 ? "var(--tone-orange)" : undefined
              }
            />
            <span className="muted">
              {budget.questions} câu hỏi · tính lại từ {resetDateText(budget.resetsAt)}
              {budget.exceeded ? " · đã hết ngân sách, trợ lý đang dừng" : null}
            </span>
          </div>
          <Form
            form={form}
            layout="vertical"
            requiredMark={false}
            onFinish={(values) => save.mutate(values)}
            className="ai-settings-form"
          >
            <Form.Item name="enabled" label="Bật trợ lý AI" valuePropName="checked">
              <Switch checkedChildren="Bật" unCheckedChildren="Tắt" />
            </Form.Item>
            <Form.Item
              name="monthlyBudgetUsd"
              label="Ngân sách mỗi tháng (USD)"
              rules={[{ required: true, message: "Nhập ngân sách" }]}
              tooltip="Hết ngân sách thì trợ lý dừng, không gọi Claude, đến ngày 1 tháng sau mở lại."
            >
              <InputNumber
                min={0}
                max={1000}
                step={1}
                precision={2}
                prefix="$"
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              name="questionsPerHour"
              label="Số câu mỗi người mỗi giờ"
              rules={[{ required: true, message: "Nhập số câu" }]}
            >
              <InputNumber min={1} max={200} precision={0} style={{ width: "100%" }} />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={save.isPending}>
              Lưu
            </Button>
          </Form>
        </>
      ) : null}
    </Card>
  );
}

// --- Nhật ký AI -------------------------------------------------------------------------------

function LogsCard() {
  const [month, setMonth] = useState<Dayjs>(() => dayjs());
  const [userId, setUserId] = useState<string>();
  const [status, setStatus] = useState<AiLogStatus>();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<AiLogItem | null>(null);
  const logs = useQuery({
    queryKey: ["ai-admin", "logs", month.format("YYYY-MM"), userId, status, page],
    queryFn: () =>
      aiAdminApi.logs({
        month: month.format("YYYY-MM"),
        ...(userId ? { userId } : {}),
        ...(status ? { status } : {}),
        page,
        limit: 20,
      }),
    placeholderData: (previous) => previous,
    retry: false,
  });
  const data = logs.data;
  const summary = data?.summary;

  if (logs.isError && forbidden(logs.error)) {
    return (
      <Card title="Nhật ký trợ lý AI">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Xem nhật ký AI cần quyền Nhật ký hệ thống ở vai trò toàn chuỗi"
        />
      </Card>
    );
  }

  return (
    <Card title="Nhật ký trợ lý AI">
      <div className="toolbar audit-toolbar">
        <DatePicker
          picker="month"
          format="MM/YYYY"
          allowClear={false}
          value={month}
          disabledDate={(day) => day.isAfter(dayjs(), "month")}
          onChange={(value) => {
            if (value) setMonth(value);
            setPage(1);
          }}
        />
        <Select
          allowClear
          placeholder="Mọi người"
          value={userId}
          onChange={(value) => {
            setUserId(value);
            setPage(1);
          }}
          options={(summary?.byUser ?? []).map((user) => ({
            value: user.userId,
            label: `${user.fullName} · ${user.questions} câu · ${usd(user.costUsd)}`,
          }))}
        />
        <Select
          allowClear
          placeholder="Mọi kết quả"
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
          options={Object.entries(LOG_STATUS).map(([value, item]) => ({
            value,
            label: item.label,
          }))}
        />
      </div>
      {summary ? (
        <div className="admin-summary" aria-label="Tóm tắt tháng">
          <span>
            <b>{summary.questions}</b> câu hỏi
          </span>
          <span>
            <b>{usd(summary.costUsd)}</b> chi phí
          </span>
          <span>
            <b>{summary.byStatus.answered ?? 0}</b> đã trả lời
          </span>
          {summary.byStatus.blocked ? (
            <span className="is-warning">
              <b>{summary.byStatus.blocked}</b> bị chặn số
            </span>
          ) : null}
          {(summary.byStatus.unavailable ?? 0) + (summary.byStatus.error ?? 0) > 0 ? (
            <span className="is-danger">
              <b>{(summary.byStatus.unavailable ?? 0) + (summary.byStatus.error ?? 0)}</b> lỗi
            </span>
          ) : null}
        </div>
      ) : null}
      {logs.isError ? <Alert type="error" showIcon title={getErrorMessage(logs.error)} /> : null}
      <Table<AiLogItem>
        rowKey="id"
        size="middle"
        loading={logs.isFetching}
        dataSource={data?.items ?? []}
        scroll={{ x: 820 }}
        onRow={(row) => ({ onClick: () => setOpen(row), style: { cursor: "pointer" } })}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="Chưa có câu hỏi nào trong tháng"
            />
          ),
        }}
        pagination={{
          current: page,
          pageSize: 20,
          total: data?.pagination.total ?? 0,
          showSizeChanger: false,
          hideOnSinglePage: true,
          onChange: setPage,
        }}
        columns={[
          {
            title: "Thời gian",
            key: "time",
            width: 150,
            render: (_, row) => <span className="mono">{formatDateTime(row.occurredAt)}</span>,
          },
          {
            title: "Người hỏi",
            key: "user",
            width: 160,
            ellipsis: true,
            render: (_, row) => row.user.fullName,
          },
          { title: "Câu hỏi", dataIndex: "question", ellipsis: true },
          {
            title: "Kết quả",
            key: "status",
            width: 150,
            render: (_, row) => (
              <Tag color={LOG_STATUS[row.status].color}>{LOG_STATUS[row.status].label}</Tag>
            ),
          },
          {
            title: "Chi phí",
            key: "cost",
            width: 90,
            align: "right",
            render: (_, row) => usd(row.costUsd, 3),
          },
        ]}
      />
      <Drawer
        open={open !== null}
        onClose={() => setOpen(null)}
        title="Chi tiết câu hỏi"
        size="large"
      >
        {open ? <LogDetail item={open} /> : null}
      </Drawer>
    </Card>
  );
}

function LogDetail({ item }: { item: AiLogItem }) {
  return (
    <div className="detail-stack">
      <div>
        <Tag color={LOG_STATUS[item.status].color}>{LOG_STATUS[item.status].label}</Tag>
        <div className="detail-sub" style={{ marginTop: 6 }}>
          {item.user.fullName} · {formatDateTime(item.occurredAt)}
        </div>
      </div>
      <div className="field">
        <span>Câu hỏi</span>
        <div className="ai-log-question">{item.question}</div>
      </div>
      {item.answer ? (
        <div className="field">
          <span>Câu trả lời</span>
          <div className="assistant-markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{item.answer}</Markdown>
          </div>
        </div>
      ) : null}
      {item.error ? <Alert type="error" showIcon title={item.error} /> : null}
      <dl className="kv-list">
        <div>
          <dt>Tra cứu</dt>
          <dd>
            {item.tools.length === 0
              ? "—"
              : item.tools.map((tool, index) => (
                  <Tag key={index} color={tool.ok ? "blue" : "red"}>
                    {TOOL_NAMES[tool.name] ?? tool.name}
                  </Tag>
                ))}
          </dd>
        </div>
        <div>
          <dt>Chi phí</dt>
          <dd>{usd(item.costUsd, 4)}</dd>
        </div>
        <div>
          <dt>Token</dt>
          <dd>
            vào {item.tokens.input.toLocaleString("vi-VN")} · ra{" "}
            {item.tokens.output.toLocaleString("vi-VN")} · đọc cache{" "}
            {item.tokens.cacheRead.toLocaleString("vi-VN")}
          </dd>
        </div>
        <div>
          <dt>Thời gian xử lý</dt>
          <dd>
            {(item.durationMs / 1000).toFixed(1).replace(".", ",")} giây · {item.rounds} vòng
          </dd>
        </div>
        <div>
          <dt>Mô hình</dt>
          <dd className="mono">{item.model ?? "—"}</dd>
        </div>
      </dl>
    </div>
  );
}
