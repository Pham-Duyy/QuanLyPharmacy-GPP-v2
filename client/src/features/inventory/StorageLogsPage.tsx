import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, DatePicker, Form, Input, InputNumber, Select, Space, Table, Tabs, Tag, Tooltip, Typography, message } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useMemo, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { type Envelope, type StorageLogItem, type StorageLogSummaryLocation } from "../../api/types.js";
import { useAuth } from "../auth/AuthProvider.js";

function currentMonth(): string {
  return dayjs().format("YYYY-MM");
}

/** Sổ nhiệt độ – độ ẩm (contract §17): ghi 2 lần/ngày, cảnh báo vượt ngưỡng, không sửa/xóa bản cũ. */
export function StorageLogsPage() {
  const { can } = useAuth();
  const [month, setMonth] = useState(currentMonth());

  const summary = useQuery({
    queryKey: ["storage-log-summary", month],
    queryFn: async () =>
      (await http.get<Envelope<StorageLogSummaryLocation[]>>("/storage-logs/summary", { params: { month } })).data
        .data,
  });

  const locations = useMemo(
    () => (summary.data ?? []).map((row) => ({ id: row.locationId, code: row.locationCode, name: row.locationName })),
    [summary.data],
  );

  return (
    <Card title="Sổ nhiệt độ – độ ẩm">
      <Tabs
        items={[
          {
            key: "record",
            label: "Ghi nhận",
            children: <RecordTab locations={locations} canWrite={can("storage_log.write")} />,
          },
          {
            key: "summary",
            label: "Tổng hợp theo tháng",
            children: <SummaryTab month={month} onMonthChange={setMonth} summary={summary.data ?? []} loading={summary.isLoading} />,
          },
        ]}
      />
    </Card>
  );
}

type LocationOption = { id: string; code: string; name: string };

function RecordTab({ locations, canWrite }: { locations: LocationOption[]; canWrite: boolean }) {
  const [location, setLocation] = useState<string>();
  const [outOfRangeOnly, setOutOfRangeOnly] = useState(false);
  const queryClient = useQueryClient();

  const logs = useQuery({
    queryKey: ["storage-logs", location, outOfRangeOnly],
    queryFn: async () =>
      (
        await http.get<Envelope<StorageLogItem[]>>("/storage-logs", {
          params: { location, outOfRange: outOfRangeOnly ? "true" : undefined },
        })
      ).data.data,
  });

  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["storage-logs"] }),
      queryClient.invalidateQueries({ queryKey: ["storage-log-summary"] }),
    ]);
  }

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      {canWrite ? <RecordForm locations={locations} onSaved={refresh} /> : null}

      <Space>
        <Select
          allowClear
          placeholder="Tất cả khu vực"
          style={{ width: 200 }}
          value={location}
          onChange={setLocation}
          options={locations.map((item) => ({ value: item.code, label: item.name }))}
        />
        <Select
          style={{ width: 200 }}
          value={outOfRangeOnly}
          onChange={setOutOfRangeOnly}
          options={[
            { value: false, label: "Mọi lần đo" },
            { value: true, label: "Chỉ lần vượt ngưỡng" },
          ]}
        />
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={logs.isLoading}
        dataSource={logs.data ?? []}
        locale={{ emptyText: logs.isError ? getErrorMessage(logs.error, "Không tải được sổ") : "Chưa có bản ghi" }}
        columns={[
          { title: "Khu vực", render: (_, row: StorageLogItem) => row.storageLocation.name },
          { title: "Thời điểm đo", width: 160, render: (_, row: StorageLogItem) => dayjs(row.recordedAt).format("DD/MM/YYYY HH:mm") },
          { title: "Nhiệt độ", width: 100, align: "right", render: (_, row: StorageLogItem) => `${row.temperatureC} °C` },
          { title: "Độ ẩm", width: 90, align: "right", render: (_, row: StorageLogItem) => (row.humidityPercent === null ? "—" : `${row.humidityPercent} %`) },
          { title: "Trạng thái", width: 130, render: (_, row: StorageLogItem) => (row.outOfRange ? <Tag color="red">Vượt ngưỡng</Tag> : <Tag color="green">Bình thường</Tag>) },
          { title: "Người ghi", width: 150, render: (_, row: StorageLogItem) => row.recordedBy.fullName },
          {
            title: "Ghi chú",
            render: (_, row: StorageLogItem) => (
              <Space direction="vertical" size={0}>
                <span>{row.note ?? "—"}</span>
                {row.correctsLogId ? <Typography.Text type="secondary">Sửa cho bản ghi #{row.correctsLogId}</Typography.Text> : null}
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}

type RecordFormValues = {
  location: string;
  recordedAt: Dayjs;
  temperatureC: number;
  humidityPercent?: number;
  note?: string;
  correctsLogId?: string;
};

function RecordForm({ locations, onSaved }: { locations: LocationOption[]; onSaved: () => Promise<void> }) {
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
    <Card size="small" type="inner" title="Ghi lần đo mới">
      <Form form={form} layout="inline" initialValues={{ recordedAt: dayjs() }} onFinish={(values) => save.mutate(values)}>
        <Form.Item name="location" rules={[{ required: true, message: "Chọn khu vực" }]}>
          <Select placeholder="Khu vực" style={{ width: 180 }} options={locations.map((item) => ({ value: item.code, label: item.name }))} />
        </Form.Item>
        <Form.Item name="recordedAt" rules={[{ required: true }]}>
          <DatePicker showTime format="DD/MM/YYYY HH:mm" placeholder="Thời điểm đo" />
        </Form.Item>
        <Form.Item name="temperatureC" rules={[{ required: true, message: "Nhập nhiệt độ" }]}>
          <InputNumber step={0.1} precision={1} placeholder="Nhiệt độ (°C)" style={{ width: 150 }} />
        </Form.Item>
        <Form.Item name="humidityPercent">
          <InputNumber min={0} max={100} step={0.1} precision={1} placeholder="Độ ẩm (%)" style={{ width: 150 }} />
        </Form.Item>
        <Form.Item name="note">
          <Input placeholder="Ghi chú" style={{ width: 200 }} />
        </Form.Item>
        <Tooltip title="Điền nếu bản ghi này sửa cho một lần đo trước ghi sai">
          <Form.Item name="correctsLogId">
            <Input placeholder="Sửa cho bản ghi # (nếu có)" style={{ width: 190 }} />
          </Form.Item>
        </Tooltip>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={save.isPending}>
            Ghi sổ
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
}

function SummaryTab({
  month,
  onMonthChange,
  summary,
  loading,
}: {
  month: string;
  onMonthChange: (month: string) => void;
  summary: StorageLogSummaryLocation[];
  loading: boolean;
}) {
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <DatePicker picker="month" value={dayjs(month, "YYYY-MM")} onChange={(value) => value && onMonthChange(value.format("YYYY-MM"))} />
      <Alert
        type="info"
        showIcon
        message="Mỗi ô là một ngày trong tháng. Xanh: đủ số lần đo quy định. Vàng: thiếu lần đo. Đỏ: có lần đo vượt ngưỡng."
      />
      {loading ? null : (
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          {summary.map((location) => (
            <div key={location.locationId}>
              <Typography.Text strong>{location.locationName}</Typography.Text>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
                {location.days.map((day) => {
                  const day_ = Number(day.businessDate.slice(8, 10));
                  const color = day.hasOutOfRange ? "#ff4d4f" : day.count < day.expectedCount ? "#faad14" : "#52c41a";
                  return (
                    <Tooltip
                      key={day.businessDate}
                      title={`${day.businessDate}: ${day.count}/${day.expectedCount} lần đo${day.hasOutOfRange ? ", có lần vượt ngưỡng" : ""}`}
                    >
                      <div
                        style={{
                          width: 32,
                          height: 32,
                          display: "grid",
                          placeItems: "center",
                          borderRadius: 4,
                          background: color,
                          color: "#fff",
                          fontSize: 12,
                        }}
                      >
                        {day_}
                      </div>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          ))}
          {summary.length === 0 ? <Typography.Text type="secondary">Chưa có khu vực bảo quản nào.</Typography.Text> : null}
        </Space>
      )}
    </Space>
  );
}
