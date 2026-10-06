import {
  CloudUploadOutlined,
  FileDoneOutlined,
  ReloadOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Popconfirm,
  Segmented,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import { getErrorMessage } from "../../api/http.js";
import { formatVnd } from "../../api/types.js";
import { formatDateTime } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useAuth } from "../auth/AuthProvider.js";
import {
  fetchConfig,
  fetchEInvoices,
  retry,
  runNow,
  saveConfig,
  testConnection,
  type EInvoiceConfig,
  type EInvoiceItem,
  type EInvoiceStatus,
} from "./einvoice-api.js";

const STATUS: Record<EInvoiceStatus, { label: string; color: string }> = {
  PENDING: { label: "Chờ phát hành", color: "default" },
  SENDING: { label: "Đang gửi", color: "processing" },
  PUBLISHED: { label: "Đã phát hành, chờ mã CQT", color: "blue" },
  COMPLETED: { label: "Đã có mã CQT", color: "green" },
  FAILED: { label: "Lỗi, sẽ thử lại", color: "orange" },
  REJECTED: { label: "Bị từ chối", color: "red" },
  CANCELLED: { label: "Đã bỏ (hóa đơn hủy)", color: "default" },
};

/**
 * Hóa đơn điện tử khởi tạo từ máy tính tiền (Nghị định 70/2025), phát hành
 * qua MISA meInvoice. Bán xong hóa đơn tự vào hàng đợi; mất mạng vẫn bán bình
 * thường, có mạng lại thì tự phát hành.
 */
export function EInvoicesPage() {
  const { can, me, storeId } = useAuth();
  const store = me?.stores.find((item) => item.id === storeId);
  const config = useQuery({
    queryKey: ["einvoice", storeId, "config"],
    queryFn: fetchConfig,
    enabled: storeId !== null,
  });

  return (
    <div>
      <PageHeader icon={<FileDoneOutlined />} title="Hóa đơn điện tử" />
      {store ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title={`Cơ sở ${store.code} · ${store.name}`}
        />
      ) : null}
      {config.isLoading ? <Skeleton active /> : null}
      {config.isError ? (
        <Alert
          type="error"
          showIcon
          title="Không đọc được cấu hình hóa đơn điện tử"
          description={getErrorMessage(config.error, "Hãy thử lại")}
        />
      ) : null}
      {config.data ? (
        <div key={storeId ?? "none"} className="einvoice-layout">
          <ConfigCard config={config.data} canManage={can("einvoice.manage")} />
          <ListCard enabled={config.data.enabled} canManage={can("einvoice.manage")} />
        </div>
      ) : null}
    </div>
  );
}

function ConfigCard({ config, canManage }: { config: EInvoiceConfig; canManage: boolean }) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["einvoice"] });

  const save = useMutation({
    mutationFn: (values: Record<string, string>) =>
      saveConfig({
        environment: values["environment"] as EInvoiceConfig["environment"],
        appId: values["appId"] || null,
        taxCode: values["taxCode"] || null,
        username: values["username"] || null,
        invSeries: values["invSeries"] || null,
        // Bỏ trống ô mật khẩu là giữ nguyên mật khẩu đang lưu.
        ...(values["password"] ? { password: values["password"] } : {}),
      }),
    onSuccess: async () => {
      void message.success("Đã lưu cấu hình hóa đơn điện tử");
      form.setFieldValue("password", "");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được cấu hình")),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => saveConfig({ enabled }),
    onSuccess: async (next) => {
      void message.success(
        next.enabled ? "Đã bật phát hành hóa đơn điện tử" : "Đã tắt phát hành hóa đơn điện tử",
      );
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không đổi được trạng thái")),
  });

  const test = useMutation({
    mutationFn: testConnection,
    onSuccess: (result) => void message.success(`Lấy token thành công tại ${result.baseUrl}`),
    onError: (error) => void message.error(getErrorMessage(error, "Không kết nối được")),
  });

  return (
    <Card
      title="Kết nối MISA meInvoice"
      extra={
        <Space>
          <Typography.Text type="secondary">
            {config.enabled ? "Đang bật" : "Đang tắt"}
          </Typography.Text>
          <Switch
            checked={config.enabled}
            disabled={!canManage}
            loading={toggle.isPending}
            onChange={(checked) => toggle.mutate(checked)}
            aria-label="Bật phát hành hóa đơn điện tử"
          />
        </Space>
      }
    >
      {config.enabledFrom ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title={`Phát hành cho hóa đơn bán từ ${formatDateTime(config.enabledFrom)}. Hóa đơn trước mốc này không phát hành hồi tố.`}
        />
      ) : null}
      <Form
        form={form}
        layout="vertical"
        disabled={!canManage}
        initialValues={{
          environment: config.environment,
          appId: config.appId ?? "",
          taxCode: config.taxCode ?? "",
          username: config.username ?? "",
          password: "",
          invSeries: config.invSeries ?? "",
        }}
        onFinish={(values) => save.mutate(values)}
      >
        <Form.Item
          name="environment"
          label="Môi trường"
          extra="Chạy thử ở môi trường kiểm thử của MISA trước khi phát hành thật."
        >
          <Segmented
            options={[
              { value: "SANDBOX", label: "Kiểm thử (testapi)" },
              { value: "PRODUCTION", label: "Phát hành thật" },
            ]}
          />
        </Form.Item>
        <div className="einvoice-form-grid">
          <Form.Item
            name="taxCode"
            label="Mã số thuế cơ sở"
            rules={[{ pattern: /^\d{10}(-\d{3})?$/, message: "10 số, chi nhánh thêm -XXX" }]}
          >
            <Input placeholder="0101234567" maxLength={14} />
          </Form.Item>
          <Form.Item
            name="invSeries"
            label="Ký hiệu hóa đơn máy tính tiền"
            extra="Đã đăng ký với cơ quan thuế, ký tự thứ 4 là M."
            rules={[{ pattern: /^[1-9][CK]\d{2}M[A-Za-z]{2}$/, message: "Dạng 1C26MAB" }]}
          >
            <Input placeholder="1C26MAB" maxLength={7} style={{ textTransform: "uppercase" }} />
          </Form.Item>
          <Form.Item name="appId" label="AppID" extra="Chuỗi MISA cấp cho phần mềm tích hợp.">
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="username" label="Tài khoản MISA meInvoice">
            <Input maxLength={200} autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="password"
            label="Mật khẩu"
            extra={
              config.hasPassword
                ? "Đã lưu một mật khẩu. Để trống nếu không đổi."
                : "Chưa có mật khẩu nào được lưu."
            }
          >
            <Input.Password
              placeholder={config.hasPassword ? "••••••••" : "Nhập mật khẩu"}
              maxLength={200}
              autoComplete="new-password"
            />
          </Form.Item>
        </div>
        <Space wrap>
          <Button type="primary" htmlType="submit" loading={save.isPending}>
            Lưu cấu hình
          </Button>
          <Button
            onClick={() => test.mutate()}
            loading={test.isPending}
            disabled={!canManage || !config.hasPassword}
          >
            Kiểm tra kết nối
          </Button>
        </Space>
      </Form>
      <Alert
        type="warning"
        showIcon
        style={{ marginTop: 16 }}
        title="Tài khoản do nhà thuốc ký hợp đồng với MISA"
      />
    </Card>
  );
}

function ListCard({ enabled, canManage }: { enabled: boolean; canManage: boolean }) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const { storeId } = useAuth();
  const [filter, setFilter] = useState<string>("all");
  const query = useQuery({
    queryKey: ["einvoice", storeId, "list", filter],
    queryFn: () =>
      fetchEInvoices(
        filter === "review" ? { needsReview: true } : filter === "all" ? {} : { status: filter },
      ),
    refetchInterval: 30_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["einvoice"] });

  const run = useMutation({
    mutationFn: runNow,
    onSuccess: async () => {
      void message.success("Đã chạy một lượt phát hành");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không chạy được")),
  });
  const retryOne = useMutation({
    mutationFn: retry,
    onSuccess: async () => {
      void message.success("Đã đưa hóa đơn về hàng chờ phát hành");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không gửi lại được")),
  });

  const summary = query.data?.summary;
  return (
    <Card
      title="Hóa đơn điện tử đã tạo"
      extra={
        canManage ? (
          <Button
            icon={<CloudUploadOutlined />}
            onClick={() => run.mutate()}
            loading={run.isPending}
            disabled={!enabled}
          >
            Phát hành ngay
          </Button>
        ) : null
      }
    >
      {summary?.needsReview ? (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          style={{ marginBottom: 12 }}
          title={`${summary.needsReview} hóa đơn đã phát hành rồi bị hủy hoặc trả hàng`}
          description="Cần lập hóa đơn điều chỉnh hoặc thay thế trên MISA meInvoice. Phần mềm không tự lập chứng từ điều chỉnh."
        />
      ) : null}
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          aria-label="Lọc trạng thái"
          value={filter}
          onChange={setFilter}
          style={{ minWidth: 220 }}
          options={[
            { value: "all", label: `Tất cả (${summary?.total ?? 0})` },
            { value: "review", label: `Cần xử lý điều chỉnh (${summary?.needsReview ?? 0})` },
            ...Object.entries(STATUS).map(([value, item]) => ({
              value,
              label: `${item.label} (${summary?.byStatus[value as EInvoiceStatus] ?? 0})`,
            })),
          ]}
        />
        <Button
          icon={<ReloadOutlined />}
          onClick={() => void query.refetch()}
          loading={query.isFetching}
        >
          Tải lại
        </Button>
      </Space>
      <Table<EInvoiceItem>
        rowKey="id"
        size="middle"
        loading={query.isLoading}
        dataSource={query.data?.items ?? []}
        scroll={{ x: 960 }}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                enabled ? "Chưa có hóa đơn điện tử nào" : "Chưa bật phát hành hóa đơn điện tử"
              }
            />
          ),
        }}
        columns={[
          {
            title: "Hóa đơn bán",
            key: "code",
            width: 190,
            render: (_, row) => (
              <Typography.Text className="mono">{row.invoiceCode}</Typography.Text>
            ),
          },
          {
            title: "Thời điểm bán",
            key: "soldAt",
            width: 150,
            render: (_, row) => formatDateTime(row.soldAt),
          },
          {
            title: "Tổng tiền",
            key: "total",
            width: 120,
            align: "right",
            render: (_, row) => formatVnd(row.totalAmount),
          },
          {
            title: "Ký hiệu / Số",
            key: "no",
            width: 150,
            render: (_, row) => (row.invNo ? `${row.invSeries} · ${row.invNo}` : "—"),
          },
          {
            title: "Mã cơ quan thuế",
            key: "cqt",
            render: (_, row) =>
              row.taxAuthorityCode ? (
                <Typography.Text className="mono" copyable>
                  {row.taxAuthorityCode}
                </Typography.Text>
              ) : (
                "—"
              ),
          },
          {
            title: "Trạng thái",
            key: "status",
            width: 230,
            render: (_, row) => (
              <Space orientation="vertical" size={2}>
                <Tag color={STATUS[row.status].color}>{STATUS[row.status].label}</Tag>
                {row.reviewReason ? (
                  <Typography.Text type="warning">{row.reviewReason}</Typography.Text>
                ) : null}
                {row.lastError ? (
                  <Typography.Text type="danger">{row.lastError}</Typography.Text>
                ) : null}
              </Space>
            ),
          },
          {
            title: "",
            key: "action",
            width: 110,
            render: (_, row) =>
              canManage && (row.status === "FAILED" || row.status === "REJECTED") ? (
                <Popconfirm
                  title="Gửi lại hóa đơn này?"
                  description="Chỉ gửi lại sau khi đã sửa dữ liệu hoặc cấu hình gây lỗi."
                  okText="Gửi lại"
                  cancelText="Quay lại"
                  onConfirm={() => retryOne.mutate(row.id)}
                >
                  <Button size="small">Gửi lại</Button>
                </Popconfirm>
              ) : null,
          },
        ]}
      />
    </Card>
  );
}
