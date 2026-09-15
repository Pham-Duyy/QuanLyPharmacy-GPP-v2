import { CheckCircleOutlined, ExperimentOutlined, WarningOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Card, Col, DatePicker, Empty, Form, Input, InputNumber, Row, Segmented, Select, Skeleton, Table, Tabs, Tag, Tooltip } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useMemo, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { type Envelope, type StorageLogItem, type StorageLogSummaryLocation } from "../../api/types.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useAuth } from "../auth/AuthProvider.js";

type LocationOption = { id: string; code: string; name: string };

/** Sổ nhiệt độ – độ ẩm (contract §17): ghi theo số lần quy định mỗi ngày, cảnh báo vượt ngưỡng, không sửa/xóa bản cũ. */
export function StorageLogsPage() {
  const { can } = useAuth();
  const [month, setMonth] = useState(dayjs().format("YYYY-MM"));

  const summary = useQuery({
    queryKey: ["storage-log-summary", month],
    queryFn: async () => (await http.get<Envelope<StorageLogSummaryLocation[]>>("/storage-logs/summary", { params: { month } })).data.data,
  });

  const locations = useMemo(() => (summary.data ?? []).map((row) => ({ id: row.locationId, code: row.locationCode, name: row.locationName })), [summary.data]);

  return (
    <div>
      <PageHeader icon={<ExperimentOutlined />} title="Nhiệt độ – độ ẩm" description="Sổ theo dõi điều kiện bảo quản theo GPP. Bản ghi không sửa hay xóa được — ghi sai thì ghi bản sửa mới." />
      <Card>
        <Tabs
          items={[
            { key: "record", label: "Ghi nhận", children: <RecordTab locations={locations} canWrite={can("storage_log.write")} /> },
            { key: "summary", label: "Tổng hợp theo tháng", children: <SummaryTab month={month} onMonthChange={setMonth} summary={summary.data ?? []} loading={summary.isLoading} /> },
          ]}
        />
      </Card>
    </div>
  );
}

function RecordTab({ locations, canWrite }: { locations: LocationOption[]; canWrite: boolean }) {
  const [location, setLocation] = useState<string>();
  const [outOfRangeOnly, setOutOfRangeOnly] = useState(false);
  const queryClient = useQueryClient();

  const logs = useQuery({
    queryKey: ["storage-logs", location, outOfRangeOnly],
    queryFn: async () => (await http.get<Envelope<StorageLogItem[]>>("/storage-logs", { params: { location, outOfRange: outOfRangeOnly ? "true" : undefined } })).data.data,
    placeholderData: (previous) => previous,
  });

  async function refresh(): Promise<void> {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["storage-logs"] }), queryClient.invalidateQueries({ queryKey: ["storage-log-summary"] })]);
  }

  return (
    <Row gutter={[16, 16]}>
      {canWrite ? (
        <Col xs={24} xl={8}>
          <RecordForm locations={locations} onSaved={refresh} />
        </Col>
      ) : null}
      <Col xs={24} xl={canWrite ? 16 : 24}>
        <div className="toolbar">
          <Segmented
            value={outOfRangeOnly ? "out" : "all"}
            onChange={(value) => setOutOfRangeOnly(value === "out")}
            options={[
              { value: "all", label: "Mọi lần đo" },
              { value: "out", label: "Vượt ngưỡng" },
            ]}
          />
          <Select allowClear placeholder="Tất cả khu vực" style={{ minWidth: 200 }} value={location} onChange={setLocation} options={locations.map((item) => ({ value: item.code, label: item.name }))} />
        </div>
        <Table
          rowKey="id"
          loading={logs.isFetching}
          dataSource={logs.data ?? []}
          scroll={{ x: 640 }}
          pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={logs.isError ? getErrorMessage(logs.error, "Không tải được sổ") : "Chưa có bản ghi"} /> }}
          columns={[
            {
              title: "Khu vực · thời điểm",
              key: "location",
              render: (_: unknown, row: StorageLogItem) => (
                <div className="cell-main">
                  <strong>{row.storageLocation.name}</strong>
                  <span>
                    {dayjs(row.recordedAt).format("DD/MM/YYYY HH:mm")} · {row.recordedBy.fullName}
                  </span>
                </div>
              ),
            },
            {
              title: "Nhiệt độ",
              key: "temp",
              width: 100,
              align: "right",
              render: (_: unknown, row: StorageLogItem) => <strong className={row.outOfRange ? "text-danger" : undefined}>{row.temperatureC} °C</strong>,
            },
            { title: "Độ ẩm", key: "humidity", width: 90, align: "right", render: (_: unknown, row: StorageLogItem) => (row.humidityPercent === null ? "—" : `${row.humidityPercent} %`) },
            {
              title: "Trạng thái",
              key: "status",
              width: 130,
              render: (_: unknown, row: StorageLogItem) => (row.outOfRange ? <Tag color="red" icon={<WarningOutlined />}>Vượt ngưỡng</Tag> : <Tag color="green" icon={<CheckCircleOutlined />}>Đạt</Tag>),
            },
            {
              title: "Ghi chú",
              key: "note",
              ellipsis: true,
              render: (_: unknown, row: StorageLogItem) => (
                <div className="cell-main">
                  <span>{row.note ?? "—"}</span>
                  {row.correctsLogId ? <span>Sửa cho bản ghi #{row.correctsLogId.slice(0, 8)}</span> : null}
                </div>
              ),
            },
          ]}
        />
      </Col>
    </Row>
  );
}

type RecordFormValues = { location: string; recordedAt: Dayjs; temperatureC: number; humidityPercent?: number; note?: string; correctsLogId?: string };

function RecordForm({ locations, onSaved }: { locations: LocationOption[]; onSaved: () => Promise<void> }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<RecordFormValues>();

  const save = useMutation({
    mutationFn: async (values: RecordFormValues) =>
      http.post("/storage-logs", {
        location: values.location,
        recordedAt: values.recordedAt.toISOString(),
        temperatureC: values.temperatureC,
        humidityPercent: values.humidityPercent ?? null,
        note: values.note?.trim() || null,
        correctsLogId: values.correctsLogId?.trim() || null,
      }),
    onSuccess: async () => {
      void message.success("Đã ghi sổ");
      form.resetFields();
      form.setFieldsValue({ recordedAt: dayjs() });
      await onSaved();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không ghi được sổ")),
  });

  return (
    <div className="record-form">
      <div className="record-form-head">Ghi lần đo mới</div>
      <Form form={form} layout="vertical" initialValues={{ recordedAt: dayjs() }} onFinish={(values) => save.mutate(values)} requiredMark={false}>
        <Form.Item name="location" label="Khu vực bảo quản" rules={[{ required: true, message: "Chọn khu vực" }]}>
          <Select placeholder="Chọn khu vực" options={locations.map((item) => ({ value: item.code, label: item.name }))} />
        </Form.Item>
        <Form.Item name="recordedAt" label="Thời điểm đo" rules={[{ required: true, message: "Chọn thời điểm" }]}>
          <DatePicker showTime format="DD/MM/YYYY HH:mm" style={{ width: "100%" }} />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="temperatureC" label="Nhiệt độ" rules={[{ required: true, message: "Nhập nhiệt độ" }]}>
              <InputNumber step={0.1} precision={1} suffix="°C" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="humidityPercent" label="Độ ẩm">
              <InputNumber min={0} max={100} step={0.1} precision={1} suffix="%" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="note" label="Ghi chú">
          <Input placeholder="Không bắt buộc" />
        </Form.Item>
        <Tooltip title="Chỉ điền khi bản ghi này dùng để sửa một lần đo trước bị ghi sai">
          <Form.Item name="correctsLogId" label="Sửa cho bản ghi (nếu có)">
            <Input placeholder="Mã bản ghi cần sửa" />
          </Form.Item>
        </Tooltip>
        <Button type="primary" htmlType="submit" block loading={save.isPending}>
          Ghi sổ
        </Button>
      </Form>
    </div>
  );
}

function SummaryTab({ month, onMonthChange, summary, loading }: { month: string; onMonthChange: (month: string) => void; summary: StorageLogSummaryLocation[]; loading: boolean }) {
  return (
    <div className="detail-stack">
      <div className="toolbar">
        <DatePicker picker="month" format="MM/YYYY" allowClear={false} value={dayjs(month, "YYYY-MM")} onChange={(value) => value && onMonthChange(value.format("YYYY-MM"))} />
        <div className="legend">
          <span>
            <i className="day-ok" /> Đủ số lần đo
          </span>
          <span>
            <i className="day-missing" /> Thiếu lần đo
          </span>
          <span>
            <i className="day-bad" /> Có lần vượt ngưỡng
          </span>
        </div>
      </div>
      {loading ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : summary.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có khu vực bảo quản nào" />
      ) : (
        summary.map((location) => (
          <div key={location.locationId} className="day-grid-block">
            <strong>{location.locationName}</strong>
            <div className="day-grid">
              {location.days.map((day) => {
                const state = day.hasOutOfRange ? "day-bad" : day.count < day.expectedCount ? "day-missing" : "day-ok";
                return (
                  <Tooltip key={day.businessDate} title={`${dayjs(day.businessDate).format("DD/MM")}: ${day.count}/${day.expectedCount} lần đo${day.hasOutOfRange ? ", có lần vượt ngưỡng" : ""}`}>
                    <div className={`day-cell ${state}`}>{Number(day.businessDate.slice(8, 10))}</div>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
