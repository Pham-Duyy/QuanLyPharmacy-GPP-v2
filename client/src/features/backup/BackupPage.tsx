import { CloudDownloadOutlined, DatabaseOutlined, SaveOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Card, Descriptions, Table, Tag, Typography } from "antd";
import { useState } from "react";
import { getErrorMessage } from "../../api/http.js";
import { formatDateTime } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { backupApi, isStale, KIND_LABEL, sizeText, type BackupItem } from "./backup-api.js";

const KIND_COLOR = { auto: "blue", manual: "green", "before-restore": "orange" } as const;

/**
 * Quản trị → Sao lưu (Phase 7, D30): xem các bản sao lưu, sao lưu ngay, tải về.
 * Không có nút phục hồi: phục hồi ghi đè toàn bộ dữ liệu nên chỉ làm bằng lệnh.
 */
export function BackupPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [downloading, setDownloading] = useState<string | null>(null);
  const status = useQuery({ queryKey: ["backups"], queryFn: backupApi.status });
  const create = useMutation({
    mutationFn: backupApi.create,
    onSuccess: (result) => {
      message.success(
        `Đã sao lưu: ${result.rows.toLocaleString("vi-VN")} dòng, ${result.files} tệp ảnh`,
      );
      void queryClient.invalidateQueries({ queryKey: ["backups"] });
    },
    onError: (error) => message.error(getErrorMessage(error, "Sao lưu thất bại")),
  });

  async function download(item: BackupItem) {
    setDownloading(item.name);
    try {
      await backupApi.download(item.name);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Không tải được tệp");
    } finally {
      setDownloading(null);
    }
  }

  const data = status.data;
  const failed = data?.lastRun?.ok === false ? data.lastRun : null;

  return (
    <div>
      <PageHeader
        icon={<DatabaseOutlined />}
        title="Sao lưu dữ liệu"
        extra={
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={create.isPending || data?.running}
            onClick={() => create.mutate()}
          >
            Sao lưu ngay
          </Button>
        }
      />
      {status.isError && (
        <Alert
          type="error"
          showIcon
          title={getErrorMessage(status.error)}
          style={{ marginBottom: 16 }}
        />
      )}
      {failed && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          title={`Lần sao lưu lúc ${formatDateTime(failed.startedAt)} thất bại`}
          description={failed.error}
        />
      )}
      {data && isStale(data.items) && !failed && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title="Hơn 2 ngày chưa có bản sao lưu"
          description="Máy chủ phải đang chạy lúc đến giờ sao lưu tự động. Bấm Sao lưu ngay để tạo một bản."
        />
      )}
      <Card style={{ marginBottom: 16 }} loading={status.isLoading}>
        {data && (
          <Descriptions column={{ xs: 1, md: 2 }} size="small">
            <Descriptions.Item label="Thư mục lưu">
              <Typography.Text code copyable>
                {data.dir}
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="Tự động">
              {data.auto ? `Mỗi ngày lúc ${data.time}, giữ ${data.keep} bản gần nhất` : "Đang tắt"}
            </Descriptions.Item>
          </Descriptions>
        )}
        <Typography.Paragraph type="secondary" style={{ margin: "12px 0 0" }}>
          Mỗi bản gồm toàn bộ dữ liệu và ảnh. Chép thêm bản sao lưu ra ổ cứng rời hoặc lưu trữ đám
          mây: máy hỏng ổ thì bản nằm cùng máy cũng mất. Phục hồi làm bằng lệnh{" "}
          <Typography.Text code>npm run db:restore -- &lt;tên tệp&gt;</Typography.Text> trong thư
          mục <Typography.Text code>server</Typography.Text> (xem Hướng dẫn sử dụng).
        </Typography.Paragraph>
      </Card>
      <Table<BackupItem>
        rowKey="name"
        loading={status.isLoading}
        dataSource={data?.items ?? []}
        pagination={false}
        scroll={{ x: 640 }}
        locale={{ emptyText: "Chưa có bản sao lưu nào" }}
        columns={[
          {
            title: "Thời điểm",
            dataIndex: "createdAt",
            render: (value: string) => formatDateTime(value),
          },
          {
            title: "Loại",
            dataIndex: "kind",
            render: (kind: BackupItem["kind"]) => (
              <Tag color={KIND_COLOR[kind]}>{KIND_LABEL[kind]}</Tag>
            ),
          },
          { title: "Dung lượng", dataIndex: "sizeBytes", align: "right", render: sizeText },
          {
            title: "Tệp",
            dataIndex: "name",
            render: (name: string) => <span className="mono">{name}</span>,
          },
          {
            title: "",
            key: "download",
            align: "right",
            render: (_, item) => (
              <Button
                icon={<CloudDownloadOutlined />}
                loading={downloading === item.name}
                onClick={() => void download(item)}
              >
                Tải về
              </Button>
            ),
          },
        ]}
      />
    </div>
  );
}
