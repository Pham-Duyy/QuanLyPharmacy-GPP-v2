import { CheckCircleFilled, CloudDownloadOutlined, DatabaseOutlined, ExclamationCircleFilled, HistoryOutlined, PlayCircleOutlined, SaveOutlined, WarningFilled } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Card, Form, InputNumber, Skeleton, Switch, Table, Tag, TimePicker, Tooltip, Typography } from "antd";
import dayjs from "dayjs";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";
import { downloadFile } from "../excel/excel-api.js";
import { formatDateTime, formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";

type BackupSettings = {
  enabled: boolean;
  hour: number;
  minute: number;
  keepCount: number;
  includeStorage: boolean;
  staleAfterHours: number;
};

type BackupItem = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "RUNNING" | "SUCCESS" | "FAILED";
  trigger: "MANUAL" | "SCHEDULED";
  folderName: string;
  databaseBytes: string | null;
  storageBytes: string | null;
  storageFiles: number | null;
  errorText: string | null;
  deletedAt: string | null;
  actor: { fullName: string } | null;
};

type BackupStatus = {
  settings: BackupSettings;
  running: boolean;
  lastSuccessAt: string | null;
  hoursSinceLastSuccess: number | null;
  lastAttempt: BackupItem | null;
  isStale: boolean;
  nextRunAt: string | null;
  keptCount: number;
  totalBytes: number;
  backupDir: string;
  toolMode: "docker" | "local";
  restoreCommands: string[];
};

function formatBytes(value: number): string {
  if (value <= 0) return "0 MB";
  if (value < 1024 * 1024) return `${formatNumber(Math.max(1, Math.round(value / 1024)))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

const bytesOf = (value: string | null) => (value === null ? 0 : Number(value));

export function BackupPage() {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm();
  const [downloading, setDownloading] = useState<string | null>(null);

  const overview = useQuery({
    queryKey: ["backups"],
    queryFn: async () => (await http.get<Envelope<{ status: BackupStatus; items: BackupItem[] }>>("/backups")).data.data,
    refetchInterval: (query) => (query.state.data?.status.running ? 3000 : false),
  });
  const status = overview.data?.status;

  const runNow = useMutation({
    mutationFn: async () => (await http.post<Envelope<{ backup: BackupItem }>>("/backups")).data.data,
    onSuccess: async (data) => {
      void message.success(`Đã sao lưu xong: ${formatBytes(bytesOf(data.backup.databaseBytes) + bytesOf(data.backup.storageBytes))}`);
      await queryClient.invalidateQueries({ queryKey: ["backups"] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Sao lưu thất bại"), 8),
  });

  const saveSettings = useMutation({
    mutationFn: async (values: BackupSettings) => (await http.put<Envelope<BackupStatus>>("/backups/settings", values)).data.data,
    onSuccess: async () => {
      void message.success("Đã lưu lịch sao lưu");
      await queryClient.invalidateQueries({ queryKey: ["backups"] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được cài đặt")),
  });

  async function download(item: BackupItem) {
    setDownloading(item.id);
    try {
      await downloadFile(`/backups/${item.id}/download`, {}, `${item.folderName}.dump`);
      void message.success("Đã tải bản sao lưu. Hãy chép sang USB hoặc máy khác.");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "Không tải được bản sao lưu");
    } finally {
      setDownloading(null);
    }
  }

  function showRestore(): void {
    if (!status) return;
    modal.info({
      title: "Cách phục hồi dữ liệu từ bản sao lưu",
      width: 760,
      content: (
        <div className="backup-restore">
          <p>
            Phục hồi sẽ <b>ghi đè toàn bộ dữ liệu đang chạy</b>, nên phần mềm cố ý không làm nút phục hồi. Chỉ làm khi đã đóng cửa hàng và đã dừng máy chủ. Chạy lần lượt các lệnh sau trong cửa sổ dòng lệnh:
          </p>
          <ol>
            {status.restoreCommands.map((command) => (
              <li key={command}>
                <code>{command}</code>
              </li>
            ))}
          </ol>
          <p>Nếu dùng bản sao lưu khác, thay tên thư mục trong lệnh bằng tên bản đó.</p>
        </div>
      ),
    });
  }

  const columns = [
    {
      title: "Thời điểm",
      dataIndex: "startedAt",
      render: (value: string, row: BackupItem) => (
        <div className="cell-main">
          <span className="cell-title">{formatDateTime(value)}</span>
          <span className="cell-sub">{row.trigger === "SCHEDULED" ? "Tự động theo lịch" : `Thủ công · ${row.actor?.fullName ?? "—"}`}</span>
        </div>
      ),
    },
    {
      title: "Trạng thái",
      dataIndex: "status",
      width: 150,
      render: (value: BackupItem["status"], row: BackupItem) =>
        value === "SUCCESS" ? (
          <Tag variant="filled" color={row.deletedAt ? "default" : "green"}>
            {row.deletedAt ? "Đã dọn tệp" : "Thành công"}
          </Tag>
        ) : value === "RUNNING" ? (
          <Tag variant="filled" color="blue">
            Đang chạy
          </Tag>
        ) : (
          <Tooltip title={row.errorText}>
            <Tag variant="filled" color="red">
              Thất bại
            </Tag>
          </Tooltip>
        ),
    },
    {
      title: "Dung lượng",
      dataIndex: "databaseBytes",
      width: 220,
      render: (_: unknown, row: BackupItem) =>
        row.status === "SUCCESS" ? (
          <div className="cell-main">
            <span className="cell-title">{formatBytes(bytesOf(row.databaseBytes) + bytesOf(row.storageBytes))}</span>
            <span className="cell-sub">
              CSDL {formatBytes(bytesOf(row.databaseBytes))}
              {row.storageFiles ? ` · ${formatNumber(row.storageFiles)} ảnh` : " · không kèm ảnh"}
            </span>
          </div>
        ) : (
          <span className="cell-sub">{row.errorText ? row.errorText.slice(0, 80) : "—"}</span>
        ),
    },
    {
      title: "",
      dataIndex: "id",
      width: 130,
      render: (_: string, row: BackupItem) =>
        row.status === "SUCCESS" && !row.deletedAt ? (
          <Button size="small" icon={<CloudDownloadOutlined />} loading={downloading === row.id} onClick={() => void download(row)}>
            Tải về
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        icon={<DatabaseOutlined />}
        title="Sao lưu dữ liệu"
        description="Bảo vệ toàn bộ dữ liệu nhà thuốc: cơ sở dữ liệu và ảnh đơn thuốc, ảnh sản phẩm."
        extra={
          <>
            <Button icon={<HistoryOutlined />} onClick={showRestore} disabled={!status}>
              Cách phục hồi
            </Button>
            <Button type="primary" icon={<PlayCircleOutlined />} loading={runNow.isPending || status?.running} onClick={() => runNow.mutate()}>
              Sao lưu ngay
            </Button>
          </>
        }
      />

      {overview.isLoading ? <Skeleton active /> : null}
      {overview.isError ? <Alert type="error" showIcon title="Không đọc được tình trạng sao lưu" description={getErrorMessage(overview.error)} /> : null}

      {status ? (
        <>
          <Alert
            className="backup-banner"
            type={status.isStale ? "warning" : "success"}
            showIcon
            icon={status.isStale ? <WarningFilled /> : <CheckCircleFilled />}
            title={
              status.lastSuccessAt
                ? status.isStale
                  ? `Đã ${formatNumber(status.hoursSinceLastSuccess)} giờ chưa sao lưu được`
                  : `Dữ liệu đã được sao lưu lúc ${formatDateTime(status.lastSuccessAt)}`
                : "Chưa có bản sao lưu nào"
            }
            description={
              <span>
                {status.settings.enabled && status.nextRunAt
                  ? `Lượt tự động kế tiếp: ${formatDateTime(status.nextRunAt)}. `
                  : "Sao lưu tự động đang tắt. "}
                Đang giữ {formatNumber(status.keptCount)} bản ({formatBytes(status.totalBytes)}) tại <code>{status.backupDir}</code>.
              </span>
            }
          />

          <Alert
            className="backup-banner"
            type="info"
            showIcon
            title="Nên giữ thêm một bản ở nơi khác"
            description="Bản sao lưu nằm cùng máy với dữ liệu gốc. Hỏng ổ cứng hoặc mất máy là mất cả hai, nên mỗi tuần hãy bấm Tải về một bản rồi chép sang USB hoặc ổ cứng ngoài."
          />

          <div className="backup-layout">
            <Card title="Lịch sao lưu tự động" className="backup-settings">
              <Form
                form={form}
                layout="vertical"
                initialValues={{ ...status.settings, time: dayjs().hour(status.settings.hour).minute(status.settings.minute) }}
                onFinish={(values: BackupSettings & { time: dayjs.Dayjs }) =>
                  saveSettings.mutate({
                    enabled: values.enabled,
                    hour: values.time.hour(),
                    minute: values.time.minute(),
                    keepCount: values.keepCount,
                    includeStorage: values.includeStorage,
                    staleAfterHours: values.staleAfterHours,
                  })
                }
              >
                <Form.Item name="enabled" label="Tự động sao lưu hằng ngày" valuePropName="checked" extra="Máy tắt đúng giờ hẹn thì lần bật máy tiếp theo trong ngày sẽ chạy bù.">
                  <Switch />
                </Form.Item>
                <Form.Item name="time" label="Giờ chạy" extra="Nên đặt sau giờ đóng cửa để không làm chậm lúc bán hàng.">
                  <TimePicker format="HH:mm" minuteStep={5} allowClear={false} />
                </Form.Item>
                <Form.Item name="keepCount" label="Số bản giữ lại" rules={[{ required: true }]} extra="Bản cũ hơn sẽ được dọn để không đầy ổ đĩa.">
                  <InputNumber min={1} max={90} style={{ width: 120 }} />
                </Form.Item>
                <Form.Item name="includeStorage" label="Sao lưu kèm ảnh đơn thuốc và ảnh sản phẩm" valuePropName="checked" extra="Nên bật: thiếu ảnh đơn thuốc là thiếu hồ sơ khi thanh tra.">
                  <Switch />
                </Form.Item>
                <Form.Item name="staleAfterHours" label="Cảnh báo khi quá (giờ) chưa sao lưu được" rules={[{ required: true }]}>
                  <InputNumber min={1} max={720} style={{ width: 120 }} />
                </Form.Item>
                <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saveSettings.isPending}>
                  Lưu cài đặt
                </Button>
              </Form>
            </Card>

            <Card
              title="Lịch sử sao lưu"
              className="backup-history"
              extra={
                status.toolMode === "docker" ? (
                  <Typography.Text type="secondary">CSDL chạy bằng Docker</Typography.Text>
                ) : (
                  <Typography.Text type="secondary">PostgreSQL cài trên máy</Typography.Text>
                )
              }
            >
              <Table
                rowKey="id"
                size="small"
                dataSource={overview.data?.items ?? []}
                columns={columns}
                scroll={{ x: 620 }}
                pagination={(overview.data?.items.length ?? 0) > 10 ? { pageSize: 10, size: "small" } : false}
                locale={{ emptyText: "Chưa có lượt sao lưu nào. Bấm “Sao lưu ngay” để tạo bản đầu tiên." }}
              />
              {status.lastAttempt?.status === "FAILED" ? (
                <Alert
                  className="backup-banner"
                  type="error"
                  showIcon
                  icon={<ExclamationCircleFilled />}
                  title="Lượt gần nhất thất bại"
                  description={status.lastAttempt.errorText}
                />
              ) : null}
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
