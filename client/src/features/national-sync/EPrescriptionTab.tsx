import { ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Segmented,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";
import { formatDateTime } from "../../ui/format.js";
import { useAuth } from "../auth/AuthProvider.js";

type Config = {
  enabled: boolean;
  baseUrl: string;
  appName: string | null;
  hasAppKey: boolean;
  facilityCode: string | null;
  updatedAt: string | null;
};

type Job = {
  id: string;
  status: "PENDING" | "SENDING" | "SENT" | "FAILED" | "REJECTED" | "CANCELLED" | "NEEDS_REVIEW";
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  invoice: { code: string; soldAt: string };
  prescription: { code: string; externalCode: string | null; patientName: string | null };
};

const STATUS: Record<Job["status"], { label: string; color?: string }> = {
  PENDING: { label: "Chờ gửi", color: "gold" },
  SENDING: { label: "Đang gửi", color: "blue" },
  SENT: { label: "Đã báo bán", color: "green" },
  FAILED: { label: "Lỗi, sẽ thử lại", color: "orange" },
  REJECTED: { label: "Bị từ chối", color: "red" },
  CANCELLED: { label: "Không cần gửi" },
  NEEDS_REVIEW: { label: "Cần xử lý tay", color: "red" },
};

/**
 * Liên thông → Đơn thuốc điện tử: kết nối Hệ thống đơn thuốc quốc gia (QĐ
 * 808/QĐ-BYT) để lấy đơn bằng mã và báo số lượng đã bán (contract §12.1).
 */
export function EPrescriptionTab({ canManage }: { canManage: boolean }) {
  const { storeId } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<"PROBLEM" | "ALL">("PROBLEM");
  const [chainForm] = Form.useForm<{ enabled: boolean; appName: string; appKey: string }>();
  const [facility, setFacility] = useState<string | null>(null);

  const config = useQuery({
    queryKey: ["erx", storeId, "config"],
    queryFn: async () => (await http.get<Envelope<Config>>("/eprescriptions/config")).data.data,
  });
  const jobs = useQuery({
    queryKey: ["erx", storeId, "jobs"],
    enabled: storeId !== null,
    queryFn: async () => (await http.get<Envelope<Job[]>>("/eprescriptions/jobs")).data.data,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["erx"] });

  const saveChain = useMutation({
    mutationFn: async (values: { enabled: boolean; appName: string; appKey: string }) =>
      http.put("/eprescriptions/config", {
        enabled: values.enabled,
        appName: values.appName || null,
        // Để trống thì giữ app-key đã lưu.
        ...(values.appKey ? { appKey: values.appKey } : {}),
      }),
    onSuccess: async () => {
      void message.success("Đã lưu kết nối");
      chainForm.setFieldValue("appKey", "");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được")),
  });
  const saveFacility = useMutation({
    mutationFn: async (code: string) =>
      http.put("/eprescriptions/store-config", { facilityCode: code }),
    onSuccess: async () => {
      void message.success("Đã lưu mã định danh cơ sở");
      setFacility(null);
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được")),
  });
  const retry = useMutation({
    mutationFn: async (id: string) => http.post(`/eprescriptions/jobs/${id}/retry`, {}),
    onSuccess: async () => {
      void message.success("Đã đưa vào hàng chờ gửi lại");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không thử lại được")),
  });

  if (!config.data) return null;
  const data = config.data;
  const rows = (jobs.data ?? []).filter(
    (job) => filter === "ALL" || !["SENT", "CANCELLED"].includes(job.status),
  );

  return (
    <div className="detail-stack">
      {!data.enabled ? (
        <Alert
          type="info"
          showIcon
          title="Chưa kết nối Hệ thống đơn thuốc quốc gia"
          description="app-name và app-key do đơn vị vận hành hệ thống cấp cho đơn vị làm phần mềm. Khi chưa có, vẫn nhập tay mã đơn ở màn Đơn thuốc để lưu vết."
        />
      ) : null}

      <Card size="small" title="Kết nối (chung cả chuỗi)">
        <Form
          form={chainForm}
          layout="vertical"
          disabled={!canManage}
          initialValues={{ enabled: data.enabled, appName: data.appName ?? "", appKey: "" }}
          onFinish={(values) => saveChain.mutate(values)}
        >
          <Form.Item name="enabled" label="Bật lấy đơn và báo đã bán" valuePropName="checked">
            <Switch />
          </Form.Item>
          <div className="count-toolbar">
            <Form.Item name="appName" label="app-name" style={{ flex: 1 }}>
              <Input maxLength={200} />
            </Form.Item>
            <Form.Item name="appKey" label="app-key" style={{ flex: 1 }}>
              <Input.Password
                maxLength={500}
                placeholder={data.hasAppKey ? "Đã lưu — để trống nếu không đổi" : "Nhập app-key"}
                autoComplete="new-password"
              />
            </Form.Item>
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Địa chỉ: <span className="mono">{data.baseUrl}</span>
          </Typography.Text>
          <div style={{ marginTop: 12 }}>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SaveOutlined />}
              loading={saveChain.isPending}
            >
              Lưu kết nối
            </Button>
          </div>
        </Form>
      </Card>

      <Card size="small" title="Mã định danh cơ sở cung ứng thuốc (cửa hàng đang chọn)">
        <div className="count-toolbar">
          <Input
            style={{ maxWidth: 320 }}
            disabled={!canManage}
            maxLength={200}
            placeholder="Mã do Sở Y tế cấp cho nhà thuốc"
            value={facility ?? data.facilityCode ?? ""}
            onChange={(event) => setFacility(event.target.value)}
          />
          <Button
            icon={<SaveOutlined />}
            disabled={!canManage || !(facility ?? "").trim()}
            loading={saveFacility.isPending}
            onClick={() => saveFacility.mutate((facility ?? "").trim())}
          >
            Lưu
          </Button>
        </div>
      </Card>

      <Card
        size="small"
        title="Báo đã bán"
        extra={
          <Segmented
            size="small"
            value={filter}
            onChange={(value) => setFilter(value as "PROBLEM" | "ALL")}
            options={[
              { value: "PROBLEM", label: "Cần chú ý" },
              { value: "ALL", label: "Tất cả" },
            ]}
          />
        }
      >
        <Table
          rowKey="id"
          size="small"
          loading={jobs.isFetching}
          dataSource={rows}
          scroll={{ x: 720 }}
          pagination={rows.length > 20 ? { pageSize: 20, size: "small" } : false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  filter === "PROBLEM" ? "Không có việc nào cần chú ý" : "Chưa bán đơn điện tử nào"
                }
              />
            ),
          }}
          columns={[
            {
              title: "Hóa đơn / đơn thuốc",
              key: "doc",
              render: (_: unknown, job: Job) => (
                <div className="cell-main">
                  <span className="cell-title">{job.invoice.code}</span>
                  <span className="cell-sub">
                    <span className="mono">{job.prescription.externalCode}</span> ·{" "}
                    {job.prescription.patientName ?? "—"} · {formatDateTime(job.invoice.soldAt)}
                  </span>
                </div>
              ),
            },
            {
              title: "Trạng thái",
              dataIndex: "status",
              width: 260,
              render: (status: Job["status"], job: Job) => (
                <div className="cell-main">
                  <span>
                    <Tag color={STATUS[status].color}>{STATUS[status].label}</Tag>
                  </span>
                  {job.lastError ? <span className="cell-sub">{job.lastError}</span> : null}
                </div>
              ),
            },
            {
              title: "",
              key: "retry",
              width: 100,
              render: (_: unknown, job: Job) =>
                canManage && (job.status === "FAILED" || job.status === "REJECTED") ? (
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    loading={retry.isPending}
                    onClick={() => retry.mutate(job.id)}
                  >
                    Gửi lại
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
    </div>
  );
}
