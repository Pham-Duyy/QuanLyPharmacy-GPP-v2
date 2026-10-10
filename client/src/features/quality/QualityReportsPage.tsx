import {
  AlertOutlined,
  CheckCircleOutlined,
  LockOutlined,
  PlusOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Radio,
  Segmented,
  Select,
  Skeleton,
  Table,
  Tag,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import type { Envelope, Paged, ProductListItem } from "../../api/types.js";
import { formatDate, formatDateTime } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";

type Kind = "COMPLAINT" | "ADR";
type Status = "OPEN" | "CLOSED";

type Report = {
  id: string;
  code: string;
  kind: Kind;
  occurredOn: string;
  product: { id: string; code: string; name: string } | null;
  batch: {
    id: string;
    batchNumber: string;
    expiryDate: string;
    status: string;
    version: number;
  } | null;
  reporterName: string | null;
  reporterPhone: string | null;
  description: string;
  actionTaken: string | null;
  status: Status;
  adrReportedOn: string | null;
  createdAt: string;
  createdByName: string;
  closedAt: string | null;
  closedByName: string | null;
  version: number;
};

type FormValues = {
  kind: Kind;
  occurredOn: Dayjs;
  productId?: string;
  batchId?: string;
  reporterName?: string;
  reporterPhone?: string;
  description: string;
  actionTaken?: string;
};

const KIND: Record<Kind, { label: string; color: string }> = {
  COMPLAINT: { label: "Khiếu nại", color: "orange" },
  ADR: { label: "Phản ứng có hại", color: "red" },
};

function ProductSelect({
  value,
  onChange,
}: {
  value?: string;
  onChange?: (value: string | undefined) => void;
}) {
  const [search, setSearch] = useState("");
  const term = useDebounced(search.trim(), 300);
  const products = useQuery({
    queryKey: ["quality-product-search", term],
    enabled: term.length >= 2,
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<ProductListItem>>>("/products", {
          params: { search: term, page: 1, limit: 20 },
        })
      ).data.data.items,
  });
  return (
    <Select
      showSearch
      allowClear
      filterOption={false}
      value={value}
      onChange={onChange}
      onSearch={setSearch}
      loading={products.isFetching}
      placeholder="Gõ tên hoặc mã thuốc (không bắt buộc)"
      notFoundContent={term.length < 2 ? "Nhập ít nhất 2 ký tự" : "Không tìm thấy"}
      options={products.data?.map((product) => ({
        value: product.id,
        label: `${product.code} · ${product.name}`,
      }))}
    />
  );
}

function BatchSelect({
  productId,
  value,
  onChange,
}: {
  productId?: string;
  value?: string;
  onChange?: (value: string | undefined) => void;
}) {
  const batches = useQuery({
    queryKey: ["quality-batches", productId],
    enabled: Boolean(productId),
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<{ id: string; batchNumber: string; expiryDate: string }>>>(
          "/inventory/batches",
          {
            params: { productId, page: 1, limit: 50 },
          },
        )
      ).data.data.items,
  });
  return (
    <Select
      allowClear
      disabled={!productId}
      value={value}
      onChange={onChange}
      loading={batches.isFetching}
      placeholder={productId ? "Chọn lô (nếu biết)" : "Chọn thuốc trước"}
      options={batches.data?.map((batch) => ({
        value: batch.id,
        label: `Lô ${batch.batchNumber} · HSD ${formatDate(batch.expiryDate)}`,
      }))}
    />
  );
}

/** Hồ sơ GPP → Khiếu nại – ADR (GPP, TT 02/2018 Phụ lục I mục III.4). */
export function QualityReportsPage() {
  const { can, storeId } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const canWrite = can("quality_report.manage");
  const [status, setStatus] = useState<Status | "ALL">("OPEN");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form] = Form.useForm<FormValues>();
  const productId = Form.useWatch("productId", form);
  const [edit, setEdit] = useState<{ actionTaken: string; adrReportedOn: Dayjs | null } | null>(
    null,
  );

  const list = useQuery({
    queryKey: ["quality-reports", storeId, status],
    queryFn: async () =>
      (
        await http.get<Envelope<Report[]>>("/quality-reports", {
          params: { status: status === "ALL" ? undefined : status },
        })
      ).data.data,
  });
  const detail = useQuery({
    queryKey: ["quality-report", openId],
    enabled: Boolean(openId),
    queryFn: async () => (await http.get<Envelope<Report>>(`/quality-reports/${openId}`)).data.data,
  });
  const report = detail.data;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["quality-reports"] });
    await queryClient.invalidateQueries({ queryKey: ["quality-report"] });
  };

  const create = useMutation({
    mutationFn: async (values: FormValues) =>
      (
        await http.post<Envelope<Report>>("/quality-reports", {
          ...values,
          occurredOn: values.occurredOn.format("YYYY-MM-DD"),
        })
      ).data.data,
    onSuccess: async (created) => {
      void message.success(`Đã ghi phiếu ${created.code}`);
      setCreating(false);
      form.resetFields();
      setOpenId(created.id);
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không ghi được phiếu"), 8),
  });

  const update = useMutation({
    mutationFn: async () =>
      http.patch(`/quality-reports/${report!.id}`, {
        version: report!.version,
        actionTaken: edit?.actionTaken ?? null,
        ...(report!.kind === "ADR"
          ? { adrReportedOn: edit?.adrReportedOn ? edit.adrReportedOn.format("YYYY-MM-DD") : null }
          : {}),
      }),
    onSuccess: async () => {
      void message.success("Đã lưu");
      setEdit(null);
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được")),
  });

  const close = useMutation({
    mutationFn: async () =>
      http.post(`/quality-reports/${report!.id}/close`, { actionTaken: edit?.actionTaken || null }),
    onSuccess: async () => {
      void message.success("Đã đóng phiếu");
      setEdit(null);
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không đóng được phiếu")),
  });

  const quarantine = useMutation({
    mutationFn: async () =>
      http.post(
        `/inventory/batches/${report!.batch!.id}/quarantine`,
        {
          reason: `${report!.code}: ${report!.description}`.slice(0, 500),
          version: report!.batch!.version,
        },
        { headers: { "Idempotency-Key": crypto.randomUUID() } },
      ),
    onSuccess: async () => {
      void message.success("Đã biệt trữ lô, lô bị chặn bán");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không biệt trữ được lô")),
  });

  const editing =
    edit ??
    (report
      ? {
          actionTaken: report.actionTaken ?? "",
          adrReportedOn: report.adrReportedOn ? dayjs(report.adrReportedOn) : null,
        }
      : null);

  return (
    <div>
      <PageHeader
        icon={<AlertOutlined />}
        title="Khiếu nại – phản ứng có hại"
        extra={
          canWrite ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              Ghi phiếu
            </Button>
          ) : null
        }
      />
      {list.isError ? (
        <Alert
          type="error"
          showIcon
          title="Không đọc được sổ"
          description={getErrorMessage(list.error)}
        />
      ) : null}

      <Card>
        <div className="count-toolbar">
          <Segmented
            value={status}
            onChange={(value) => setStatus(value as Status | "ALL")}
            options={[
              { value: "OPEN", label: "Đang xử lý" },
              { value: "CLOSED", label: "Đã xong" },
              { value: "ALL", label: "Tất cả" },
            ]}
          />
        </div>
        {list.isLoading ? (
          <Skeleton active />
        ) : (
          <Table
            rowKey="id"
            size="small"
            dataSource={list.data ?? []}
            scroll={{ x: 760 }}
            pagination={(list.data?.length ?? 0) > 20 ? { pageSize: 20, size: "small" } : false}
            onRow={(row) => ({
              onClick: () => {
                setEdit(null);
                setOpenId(row.id);
              },
              style: { cursor: "pointer" },
            })}
            columns={[
              {
                title: "Phiếu",
                dataIndex: "code",
                render: (code: string, row: Report) => (
                  <div className="cell-main">
                    <span className="cell-title">
                      <Tag color={KIND[row.kind].color}>{KIND[row.kind].label}</Tag> {code}
                    </span>
                    <span className="cell-sub">
                      {formatDate(row.occurredOn)} · {row.createdByName}
                    </span>
                  </div>
                ),
              },
              {
                title: "Thuốc / lô",
                key: "product",
                render: (_: unknown, row: Report) =>
                  row.product ? (
                    <div className="cell-main">
                      <span>{row.product.name}</span>
                      {row.batch ? (
                        <span className="cell-sub">Lô {row.batch.batchNumber}</span>
                      ) : null}
                    </div>
                  ) : (
                    <span className="cell-sub">—</span>
                  ),
              },
              { title: "Nội dung", dataIndex: "description", ellipsis: true },
              {
                title: "Trạng thái",
                dataIndex: "status",
                width: 130,
                render: (value: Status, row: Report) =>
                  value === "CLOSED" ? (
                    <Tag color="green">Đã xong</Tag>
                  ) : row.kind === "ADR" && !row.adrReportedOn ? (
                    <Tag color="red">Chưa báo ADR</Tag>
                  ) : (
                    <Tag color="gold">Đang xử lý</Tag>
                  ),
              },
            ]}
            locale={{ emptyText: <Empty description="Chưa có phiếu nào" /> }}
          />
        )}
      </Card>

      <Modal
        title="Ghi phiếu khiếu nại / phản ứng có hại"
        open={creating}
        onCancel={() => setCreating(false)}
        okText="Ghi phiếu"
        cancelText="Hủy"
        confirmLoading={create.isPending}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ kind: "COMPLAINT", occurredOn: dayjs() }}
          onFinish={(values) => create.mutate(values)}
        >
          <Form.Item name="kind" label="Loại">
            <Radio.Group
              optionType="button"
              options={[
                { value: "COMPLAINT", label: "Khiếu nại về thuốc" },
                { value: "ADR", label: "Phản ứng có hại (ADR)" },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="occurredOn"
            label="Ngày xảy ra"
            rules={[{ required: true, message: "Chọn ngày" }]}
          >
            <DatePicker
              format="DD/MM/YYYY"
              style={{ width: "100%" }}
              disabledDate={(date) => date.isAfter(dayjs(), "day")}
            />
          </Form.Item>
          <Form.Item name="productId" label="Thuốc">
            <ProductSelect onChange={() => form.setFieldValue("batchId", undefined)} />
          </Form.Item>
          <Form.Item name="batchId" label="Lô">
            <BatchSelect productId={productId} />
          </Form.Item>
          <Form.Item label="Người phản ánh / người dùng thuốc" style={{ marginBottom: 0 }}>
            <div className="count-toolbar">
              <Form.Item name="reporterName" noStyle>
                <Input placeholder="Họ tên (không bắt buộc)" maxLength={150} />
              </Form.Item>
              <Form.Item name="reporterPhone" noStyle>
                <Input placeholder="Số điện thoại" maxLength={20} inputMode="tel" />
              </Form.Item>
            </div>
          </Form.Item>
          <Form.Item
            name="description"
            label="Mô tả sự việc"
            rules={[{ required: true, min: 5, message: "Mô tả rõ sự việc" }]}
          >
            <Input.TextArea
              rows={3}
              maxLength={2000}
              placeholder="Ví dụ: nổi mẩn đỏ sau 2 liều; vỉ thuốc bị phồng, viên đổi màu"
            />
          </Form.Item>
          <Form.Item name="actionTaken" label="Đã xử lý thế nào">
            <Input.TextArea rows={2} maxLength={2000} placeholder="Có thể ghi sau" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={report ? `${KIND[report.kind].label} ${report.code}` : "Phiếu"}
        open={Boolean(openId)}
        onCancel={() => {
          setOpenId(null);
          setEdit(null);
        }}
        width={720}
        destroyOnHidden
        footer={
          report && canWrite && report.status === "OPEN" ? (
            <div
              className="expiry-actions"
              style={{ justifyContent: "flex-end", flexWrap: "wrap" }}
            >
              {report.batch?.status === "AVAILABLE" && can("batch.quarantine") ? (
                <Button
                  icon={<LockOutlined />}
                  loading={quarantine.isPending}
                  onClick={() => quarantine.mutate()}
                >
                  Biệt trữ lô
                </Button>
              ) : null}
              <Button
                icon={<SaveOutlined />}
                loading={update.isPending}
                disabled={!edit}
                onClick={() => update.mutate()}
              >
                Lưu
              </Button>
              <Button
                type="primary"
                icon={<CheckCircleOutlined />}
                loading={close.isPending}
                disabled={!editing?.actionTaken.trim()}
                onClick={() => close.mutate()}
              >
                Đóng phiếu
              </Button>
            </div>
          ) : (
            <Button onClick={() => setOpenId(null)}>Đóng</Button>
          )
        }
      >
        {detail.isLoading ? <Skeleton active /> : null}
        {report && editing ? (
          <>
            <Descriptions size="small" column={{ xs: 1, sm: 2 }} bordered>
              <Descriptions.Item label="Ngày xảy ra">
                {formatDate(report.occurredOn)}
              </Descriptions.Item>
              <Descriptions.Item label="Người ghi">
                {report.createdByName} · {formatDateTime(report.createdAt)}
              </Descriptions.Item>
              <Descriptions.Item label="Thuốc" span="filled">
                {report.product ? `${report.product.code} · ${report.product.name}` : "—"}
                {report.batch ? ` · Lô ${report.batch.batchNumber}` : ""}
                {report.batch && report.batch.status !== "AVAILABLE" ? (
                  <Tag style={{ marginLeft: 8 }}>
                    {report.batch.status === "QUARANTINED" ? "Đã biệt trữ" : "Đang thu hồi"}
                  </Tag>
                ) : null}
              </Descriptions.Item>
              <Descriptions.Item label="Người phản ánh" span="filled">
                {[report.reporterName, report.reporterPhone].filter(Boolean).join(" · ") || "—"}
              </Descriptions.Item>
              <Descriptions.Item label="Mô tả" span="filled">
                {report.description}
              </Descriptions.Item>
              {report.status === "CLOSED" ? (
                <Descriptions.Item label="Đã xong" span="filled">
                  {report.closedByName} · {report.closedAt ? formatDateTime(report.closedAt) : ""}
                </Descriptions.Item>
              ) : null}
            </Descriptions>

            <Form
              layout="vertical"
              style={{ marginTop: 12 }}
              disabled={!canWrite || report.status === "CLOSED"}
            >
              <Form.Item label="Đã xử lý thế nào">
                <Input.TextArea
                  rows={2}
                  maxLength={2000}
                  value={editing.actionTaken}
                  onChange={(event) => setEdit({ ...editing, actionTaken: event.target.value })}
                />
              </Form.Item>
              {report.kind === "ADR" ? (
                <Form.Item
                  label="Ngày đã gửi báo cáo về Trung tâm DI&ADR quốc gia"
                  extra="Báo cáo gửi theo mẫu của Trung tâm; ở đây chỉ ghi ngày để tra lại."
                >
                  <DatePicker
                    format="DD/MM/YYYY"
                    value={editing.adrReportedOn}
                    disabledDate={(date) => date.isAfter(dayjs(), "day")}
                    onChange={(value) => setEdit({ ...editing, adrReportedOn: value })}
                  />
                </Form.Item>
              ) : null}
            </Form>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
