import {
  ApiOutlined,
  CheckCircleOutlined,
  CloudSyncOutlined,
  DeleteOutlined,
  LinkOutlined,
  ReloadOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Popconfirm,
  Segmented,
  Select,
  Skeleton,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
} from "antd";
import { useState } from "react";
import { getErrorMessage } from "../../api/http.js";
import { formatDateTime } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useAuth } from "../auth/AuthProvider.js";
import { DrugPickerModal } from "./DrugPickerModal.js";
import { EPrescriptionTab } from "./EPrescriptionTab.js";
import {
  autoMatch,
  confirmMapping,
  confirmMappings,
  drainNow,
  fetchConfig,
  fetchJobs,
  fetchMapping,
  JOB_KIND,
  JOB_STATUS,
  removeMapping,
  retryJob,
  saveConfig,
  scanDocuments,
  SOURCE_LABEL,
  submitOpeningStock,
  syncMaster,
  testConnection,
  type MappingRow,
  type NdsConfig,
  type SyncJob,
} from "./nds-api.js";

const MATCHED_BY: Record<string, { label: string; color: string }> = {
  REGISTRATION_NUMBER: { label: "Khớp số đăng ký", color: "green" },
  NAME: { label: "Khớp theo tên", color: "orange" },
  MANUAL: { label: "Tự chọn", color: "blue" },
};

/**
 * Liên thông Hệ thống Cơ sở dữ liệu về Dược quốc gia.
 *
 * Thứ tự việc phải làm đúng như các thẻ trên màn: kết nối tài khoản → đồng bộ
 * danh mục thuốc quốc gia → ghép mã từng mặt hàng → gửi tồn đầu kỳ → từ đó
 * chứng từ hằng ngày tự gửi.
 */
export function NationalSyncPage() {
  const { can, me, storeId } = useAuth();
  const queryClient = useQueryClient();
  const canManage = can("national_sync.manage");
  const store = me?.stores.find((item) => item.id === storeId);

  // Cấu hình và chứng từ theo cửa hàng đang chọn: khóa truy vấn gồm storeId để đổi cửa hàng là tải lại.
  const config = useQuery({ queryKey: ["nds", storeId, "config"], queryFn: fetchConfig, enabled: storeId !== null });
  const refreshAll = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["nds"] });
  };

  return (
    <div>
      <PageHeader
        icon={<ApiOutlined />}
        title="Liên thông CSDL Dược quốc gia"
      />

      {store ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title={`Đang xem cơ sở ${store.code} · ${store.name}`}
        />
      ) : null}

      {config.isLoading ? <Skeleton active /> : null}
      {config.isError ? (
        <Alert
          type="error"
          showIcon
          title="Không đọc được cấu hình liên thông"
          description={getErrorMessage(config.error, "Hãy thử lại")}
        />
      ) : null}

      {config.data ? (
        <Tabs
          key={storeId ?? "none"}
          defaultActiveKey="connection"
          items={[
            {
              key: "connection",
              label: "Kết nối",
              children: <ConnectionTab config={config.data} canManage={canManage} onChanged={refreshAll} />,
            },
            {
              key: "mapping",
              label: "Ghép mã thuốc",
              children: <MappingTab canManage={canManage} onChanged={refreshAll} />,
            },
            {
              key: "jobs",
              label: "Chứng từ đã gửi",
              children: <JobsTab canManage={canManage} config={config.data} onChanged={refreshAll} />,
            },
            {
              key: "eprescription",
              label: "Đơn thuốc điện tử",
              children: <EPrescriptionTab canManage={canManage} />,
            },
          ]}
        />
      ) : null}

      {config.data && !config.data.enabled ? (
        <Alert
          type="warning"
          showIcon
          title="Liên thông đang tắt"
          description="Bật ở thẻ Kết nối sau khi đã ghép mã thuốc và gửi tồn đầu kỳ."
          style={{ marginTop: 16 }}
        />
      ) : null}

      <Alert
        type="info"
        showIcon
        title="Tài khoản liên thông do chính nhà thuốc đăng ký"
        description={
          <>
            Theo quy định của Trung tâm Thông tin Y tế Quốc gia, đơn vị làm phần mềm không được đăng ký tài khoản hộ.
            Nhà thuốc tự đăng ký tại <b>csdlduoc.com.vn</b> bằng số giấy chứng nhận đủ điều kiện kinh doanh dược, chờ
            duyệt qua email rồi lấy tài khoản nhập vào đây. Hỗ trợ: 19008255 — ttyqg@moh.gov.vn.
          </>
        }
        style={{ marginTop: 16 }}
      />
    </div>
  );
}

// --- Thẻ Kết nối ------------------------------------------------------------

function ConnectionTab({
  config,
  canManage,
  onChanged,
}: {
  config: NdsConfig;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm();

  const save = useMutation({
    mutationFn: async (values: Record<string, unknown>) =>
      saveConfig({
        environment: values["environment"] as NdsConfig["environment"],
        username: (values["username"] as string) || null,
        // Bỏ trống ô mật khẩu nghĩa là giữ nguyên mật khẩu đang lưu.
        ...(values["password"] ? { password: values["password"] as string } : {}),
        practiceLicenseCode: (values["practiceLicenseCode"] as string) || null,
      }),
    onSuccess: async () => {
      void message.success("Đã lưu cấu hình kết nối");
      form.setFieldValue("password", "");
      await onChanged();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được cấu hình")),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => saveConfig({ enabled }),
    onSuccess: async (next) => {
      void message.success(next.enabled ? "Đã bật liên thông" : "Đã tắt liên thông");
      await onChanged();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không đổi được trạng thái")),
  });

  const test = useMutation({
    mutationFn: testConnection,
    onSuccess: (result) => void message.success(`Đăng nhập thành công tới ${result.baseUrl}`),
    onError: (error) => void message.error(getErrorMessage(error, "Không kết nối được")),
  });

  const master = useMutation({
    mutationFn: (full: boolean) => syncMaster(full),
    onSuccess: async (result) => {
      void message.success(`Đã tải về ${result.drugs} thuốc và ${result.units} đơn vị tính`);
      await onChanged();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không đồng bộ được danh mục")),
  });

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Card title="Tài khoản liên thông của cơ sở">
        <Form
          form={form}
          layout="vertical"
          disabled={!canManage}
          initialValues={{
            environment: config.environment,
            username: config.username ?? "",
            password: "",
            practiceLicenseCode: config.practiceLicenseCode ?? "",
          }}
          onFinish={(values) => save.mutate(values)}
        >
          <Form.Item
            name="environment"
            label="Môi trường"
            extra="Chạy thử ở sandbox cho tới khi dữ liệu đúng, rồi mới chuyển sang hệ thống thật."
          >
            <Segmented
              options={[
                { value: "SANDBOX", label: "Sandbox (chạy thử)" },
                { value: "PRODUCTION", label: "Hệ thống thật" },
              ]}
            />
          </Form.Item>

          <Form.Item name="username" label="Tên đăng nhập" extra="Mã số thuế + mã địa điểm kinh doanh, do cổng cấp.">
            <Input placeholder="Ví dụ: 0101234567-001" maxLength={200} />
          </Form.Item>

          <Form.Item
            name="password"
            label="Mật khẩu"
            extra={
              config.hasPassword
                ? "Đã lưu một mật khẩu. Để trống nếu không muốn đổi."
                : "Chưa có mật khẩu nào được lưu."
            }
          >
            <Input.Password placeholder={config.hasPassword ? "••••••••" : "Nhập mật khẩu"} maxLength={200} />
          </Form.Item>

          <Form.Item
            name="practiceLicenseCode"
            label="Mã giấy phép hành nghề"
            extra="Chỉ cần khi tài khoản mẹ của chuỗi gửi thay cho cơ sở thành viên."
          >
            <Input placeholder="Bỏ trống nếu nhà thuốc gửi bằng tài khoản của chính mình" maxLength={50} />
          </Form.Item>

          <Space wrap>
            <Button type="primary" htmlType="submit" loading={save.isPending}>
              Lưu cấu hình
            </Button>
            <Button
              icon={<ApiOutlined />}
              onClick={() => test.mutate()}
              loading={test.isPending}
              disabled={!config.username || !config.hasPassword}
            >
              Kiểm tra kết nối
            </Button>
          </Space>
        </Form>
      </Card>

      <Card title="Trạng thái">
        <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered>
          <Descriptions.Item label="Địa chỉ API">
            <Space orientation="vertical" size={2}>
              <span>{config.baseUrl}</span>
              {config.baseUrlOverridden ? (
                <Tag color="purple">Địa chỉ do cấu hình NDS_BASE_URL chỉ định, không phải địa chỉ chính thức</Tag>
              ) : null}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="Gửi dữ liệu tự động">
            <Space>
              <Switch
                checked={config.enabled}
                disabled={!canManage || toggle.isPending}
                onChange={(checked) => toggle.mutate(checked)}
              />
              <span>{config.enabled ? "Đang bật" : "Đang tắt"}</span>
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="Mốc bắt đầu liên thông">
            {config.startDate ?? <span className="muted">Chưa gửi tồn đầu kỳ</span>}
          </Descriptions.Item>
          <Descriptions.Item label="Đồng bộ danh mục lần cuối">
            {config.lastMasterSyncAt ? formatDateTime(config.lastMasterSyncAt) : <span className="muted">Chưa đồng bộ</span>}
          </Descriptions.Item>
        </Descriptions>

        <Space wrap style={{ marginTop: 16 }}>
          <Button
            icon={<CloudSyncOutlined />}
            onClick={() => master.mutate(false)}
            loading={master.isPending}
            disabled={!canManage || !config.hasPassword}
          >
            Đồng bộ danh mục thuốc
          </Button>
          <Tooltip title="Tải lại toàn bộ danh mục thay vì chỉ phần thay đổi">
            <Button onClick={() => master.mutate(true)} disabled={!canManage || !config.hasPassword}>
              Tải lại toàn bộ
            </Button>
          </Tooltip>
        </Space>
      </Card>
    </Space>
  );
}

// --- Thẻ Ghép mã ------------------------------------------------------------

function MappingTab({ canManage, onChanged }: { canManage: boolean; onChanged: () => Promise<void> }) {
  const { message } = App.useApp();
  const [state, setState] = useState("all");
  const [search, setSearch] = useState("");
  const [picking, setPicking] = useState<MappingRow | null>(null);

  const mapping = useQuery({
    queryKey: ["nds", "mapping", state, search],
    queryFn: () => fetchMapping({ state, search: search || undefined }),
  });

  const auto = useMutation({
    mutationFn: autoMatch,
    onSuccess: async (result) => {
      void message.success(
        `Ghép được ${result.matchedByRegistration} mặt hàng theo số đăng ký, ${result.matchedByName} theo tên; còn ${result.unmatched} chưa ghép.`,
      );
      await onChanged();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không ghép tự động được")),
  });

  const confirmMany = useMutation({
    mutationFn: (productIds: string[]) => confirmMappings(productIds),
    onSuccess: async (result) => {
      void message.success(`Đã xác nhận ${result.confirmed} mã ghép`);
      await onChanged();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không xác nhận được")),
  });

  const confirm = useMutation({
    mutationFn: confirmMapping,
    onSuccess: async () => {
      void message.success("Đã xác nhận mã ghép");
      await onChanged();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không xác nhận được")),
  });

  const remove = useMutation({
    mutationFn: removeMapping,
    onSuccess: async () => {
      void message.success("Đã gỡ mã ghép");
      await onChanged();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không gỡ được")),
  });

  const summary = mapping.data?.summary;
  /** Những dòng đang hiển thị mà còn chờ xác nhận — chỉ xác nhận đúng cái đang thấy. */
  const pendingIds = (mapping.data?.items ?? [])
    .filter((row) => row.link !== null && !row.link.usable)
    .map((row) => row.productId);

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        title="Vì sao phải ghép mã"
        description="Mặt hàng chưa ghép mã thì chứng từ có mặt hàng đó chưa được gửi."
      />

      {summary ? (
        <Card size="small">
          <Space size="large" wrap>
            <Statistic title="Tổng mặt hàng" value={summary.total} />
            <Statistic title="Gửi được" value={summary.usable} valueStyle={{ color: "#389e0d" }} />
            <Statistic title="Chờ xác nhận" value={summary.needsReview} valueStyle={{ color: "#d46b08" }} />
            <Statistic title="Chưa ghép" value={summary.unlinked} valueStyle={{ color: "#cf1322" }} />
          </Space>
        </Card>
      ) : null}

      <Space wrap>
        <Button
          type="primary"
          icon={<LinkOutlined />}
          onClick={() => auto.mutate()}
          loading={auto.isPending}
          disabled={!canManage}
        >
          Ghép tự động
        </Button>
        <Segmented
          value={state}
          onChange={(value) => setState(String(value))}
          options={[
            { value: "all", label: "Tất cả" },
            { value: "unlinked", label: "Chưa ghép" },
            { value: "needs_review", label: "Chờ xác nhận" },
            { value: "linked", label: "Đã ghép" },
          ]}
        />
        <Input.Search
          placeholder="Tìm theo mã hoặc tên mặt hàng"
          allowClear
          style={{ width: 280 }}
          onSearch={setSearch}
        />
        {pendingIds.length > 0 ? (
          <Popconfirm
            title={`Xác nhận ${pendingIds.length} mã ghép đang hiển thị?`}
            description="Hãy đối chiếu từng dòng trên bảng trước khi xác nhận. Sau bước này dữ liệu sẽ được gửi lên Bộ Y tế theo các mã đó."
            okText="Tôi đã đối chiếu, xác nhận"
            cancelText="Để xem lại"
            onConfirm={() => confirmMany.mutate(pendingIds)}
          >
            <Button icon={<CheckCircleOutlined />} loading={confirmMany.isPending} disabled={!canManage}>
              Xác nhận {pendingIds.length} dòng đang hiển thị
            </Button>
          </Popconfirm>
        ) : null}
      </Space>

      <Table<MappingRow>
        rowKey="productId"
        size="small"
        loading={mapping.isLoading}
        dataSource={mapping.data?.items ?? []}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          {
            title: "Mặt hàng",
            dataIndex: "code",
            render: (_value, row) => (
              <>
                <div>
                  <b>{row.code}</b> — {row.name}
                </div>
                <span className="muted">
                  Đơn vị cơ bản: {row.baseUnitName ?? "—"} · SĐK: {row.registrationNumber ?? "chưa nhập"}
                </span>
              </>
            ),
          },
          {
            title: "Mã thuốc quốc gia",
            dataIndex: "link",
            render: (_value, row) =>
              row.link ? (
                <>
                  <div>
                    <b>{row.link.drugId}</b> — {row.link.drugName ?? "—"}
                  </div>
                  <Space size={4} wrap>
                    <Tag color={MATCHED_BY[row.link.matchedBy]?.color}>
                      {MATCHED_BY[row.link.matchedBy]?.label ?? row.link.matchedBy}
                    </Tag>
                    <Tag color={row.link.usable ? "green" : "orange"}>
                      {row.link.usable ? "Gửi được" : "Chờ xác nhận"}
                    </Tag>
                    <span className="muted">đơn vị {row.link.unitId}</span>
                  </Space>
                </>
              ) : (
                <span className="image-nomatch">Chưa ghép mã</span>
              ),
          },
          {
            title: "",
            dataIndex: "productId",
            width: 230,
            render: (_value, row) => (
              <Space size={4} wrap>
                {row.link && !row.link.usable ? (
                  <Button
                    size="small"
                    icon={<CheckCircleOutlined />}
                    disabled={!canManage}
                    loading={confirm.isPending && confirm.variables === row.productId}
                    onClick={() => confirm.mutate(row.productId)}
                  >
                    Xác nhận đúng
                  </Button>
                ) : null}
                <Button size="small" disabled={!canManage} onClick={() => setPicking(row)}>
                  {row.link ? "Đổi mã" : "Chọn mã"}
                </Button>
                {row.link ? (
                  <Popconfirm
                    title="Gỡ mã ghép của mặt hàng này?"
                    okText="Gỡ"
                    cancelText="Không"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => remove.mutate(row.productId)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />} disabled={!canManage} />
                  </Popconfirm>
                ) : null}
              </Space>
            ),
          },
        ]}
      />

      <DrugPickerModal row={picking} onClose={() => setPicking(null)} onSaved={onChanged} />
    </Space>
  );
}

// --- Thẻ Chứng từ -----------------------------------------------------------

function JobsTab({
  canManage,
  config,
  onChanged,
}: {
  canManage: boolean;
  config: NdsConfig;
  onChanged: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const [status, setStatus] = useState<string | undefined>(undefined);

  const jobs = useQuery({
    queryKey: ["nds", config.storeId, "jobs", status],
    queryFn: () => fetchJobs(status),
    refetchInterval: 30_000,
  });

  const opening = useMutation({
    mutationFn: submitOpeningStock,
    onSuccess: async (result) => {
      void message.success(`Đã gửi tồn đầu kỳ ${result.referenceNumber} với ${result.items} dòng`);
      await onChanged();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không gửi được tồn đầu kỳ")),
  });

  const run = useMutation({
    mutationFn: async () => {
      const scanned = await scanDocuments();
      const drained = await drainNow();
      return { scanned, drained };
    },
    onSuccess: async ({ scanned, drained }) => {
      void message.success(
        `Tìm thêm ${scanned.created} chứng từ, gửi ${drained.sent.sent}, giữ lại ${drained.sent.blocked}, lỗi ${drained.sent.failed}.`,
      );
      await onChanged();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không gửi được")),
  });

  const retry = useMutation({
    mutationFn: retryJob,
    onSuccess: async () => {
      void message.success("Đã đưa chứng từ về hàng chờ gửi");
      await onChanged();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không gửi lại được")),
  });

  const summary = jobs.data?.summary;

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {!config.startDate ? (
        <Alert
          type="warning"
          showIcon
          title="Bước bắt buộc: gửi tồn đầu kỳ"
          description="Hệ thống quốc gia chỉ ghi nhận chứng từ phát sinh sau ngày của phiếu kiểm hàng đầu kỳ, và chỉ nhận phiếu này đúng một lần. Hãy ghép mã xong toàn bộ mặt hàng đang còn tồn rồi mới gửi."
          action={
            <Popconfirm
              title="Gửi tồn đầu kỳ ngay?"
              description="Chỉ gửi được một lần, không sửa lại được. Hãy chắc chắn tồn kho trên phần mềm đã khớp thực tế."
              okText="Gửi"
              cancelText="Để sau"
              onConfirm={() => opening.mutate()}
            >
              <Button type="primary" loading={opening.isPending} disabled={!canManage}>
                Gửi tồn đầu kỳ
              </Button>
            </Popconfirm>
          }
        />
      ) : null}

      {summary ? (
        <Card size="small">
          <Space size="large" wrap>
            <Statistic title="Tổng chứng từ" value={summary.total} />
            <Statistic title="Xong" value={summary.byStatus["COMPLETED"] ?? 0} valueStyle={{ color: "#389e0d" }} />
            <Statistic
              title="Chờ gửi"
              value={(summary.byStatus["PENDING"] ?? 0) + (summary.byStatus["ACCEPTED"] ?? 0) + (summary.byStatus["PROCESSING"] ?? 0)}
            />
            <Statistic
              title="Cần xử lý"
              value={(summary.byStatus["BLOCKED"] ?? 0) + (summary.byStatus["REJECTED"] ?? 0) + (summary.byStatus["FAILED"] ?? 0)}
              valueStyle={{ color: "#cf1322" }}
            />
          </Space>
        </Card>
      ) : null}

      <Space wrap>
        <Button
          type="primary"
          icon={<SendOutlined />}
          onClick={() => run.mutate()}
          loading={run.isPending}
          disabled={!canManage || !config.enabled}
        >
          Quét và gửi ngay
        </Button>
        <Select
          allowClear
          placeholder="Lọc theo trạng thái"
          style={{ width: 200 }}
          value={status}
          onChange={setStatus}
          options={Object.entries(JOB_STATUS).map(([value, meta]) => ({ value, label: meta.label }))}
        />
      </Space>

      <Table<SyncJob>
        rowKey="id"
        size="small"
        loading={jobs.isLoading}
        dataSource={jobs.data?.items ?? []}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          {
            title: "Chứng từ",
            dataIndex: "referenceNumber",
            render: (_value, row) => (
              <>
                <div>
                  <b>{row.referenceNumber}</b>
                </div>
                <span className="muted">
                  {SOURCE_LABEL[row.sourceType] ?? row.sourceType} · {JOB_KIND[row.kind] ?? row.kind} · {row.documentDate}
                </span>
              </>
            ),
          },
          {
            title: "Trạng thái",
            dataIndex: "status",
            width: 180,
            render: (_value, row) => (
              <>
                <Tag color={JOB_STATUS[row.status]?.color}>{JOB_STATUS[row.status]?.label ?? row.status}</Tag>
                {row.attempts > 1 ? <span className="muted">đã thử {row.attempts} lần</span> : null}
              </>
            ),
          },
          {
            title: "Ghi chú của hệ thống quốc gia",
            dataIndex: "lastError",
            render: (_value, row) =>
              row.lastError ? <span className="image-nomatch">{row.lastError}</span> : <span className="muted">—</span>,
          },
          {
            title: "Gửi lúc",
            dataIndex: "submittedAt",
            width: 150,
            render: (value: string | null) => (value ? formatDateTime(value) : <span className="muted">chưa gửi</span>),
          },
          {
            title: "",
            dataIndex: "id",
            width: 110,
            render: (_value, row) =>
              row.status === "COMPLETED" || row.status === "SENDING" ? null : (
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  disabled={!canManage}
                  loading={retry.isPending && retry.variables === row.id}
                  onClick={() => retry.mutate(row.id)}
                >
                  Gửi lại
                </Button>
              ),
          },
        ]}
      />
    </Space>
  );
}
