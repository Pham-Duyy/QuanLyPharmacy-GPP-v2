import { CheckOutlined, ClockCircleOutlined, FieldTimeOutlined, HistoryOutlined, WarningFilled } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Card, DatePicker, Empty, Form, Input, Modal, Segmented, Select, Skeleton, Switch, Table, Tag, Timeline, Tooltip } from "antd";
import dayjs from "dayjs";
import { useState } from "react";
import { useNavigate } from "react-router";
import { getErrorMessage, http } from "../../api/http.js";
import { formatVnd, type Envelope } from "../../api/types.js";
import { formatDate, formatDateTime, formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useAuth } from "../auth/AuthProvider.js";

type BucketKey = "EXPIRED" | "D30" | "D60" | "D90";
type ExpiryAction = "RETURN_SUPPLIER" | "PRIORITIZE_SALE" | "DISCOUNT" | "DISPOSE";

type Plan = {
  id: string;
  action: ExpiryAction;
  status: string;
  dueDate: string | null;
  note: string | null;
  outcome: string | null;
  createdByName: string;
  createdAt: string;
  resolvedByName: string | null;
  resolvedAt: string | null;
  overdue: boolean;
  version: number;
};

type ExpiryRow = {
  batchId: string;
  productId: string;
  productCode: string;
  productName: string;
  batchNumber: string;
  expiryDate: string;
  daysLeft: number;
  bucket: BucketKey;
  quantityOnHand: number;
  baseUnitName: string;
  shelfLocation: string | null;
  batchStatus: string;
  stockValue: number | null;
  lastSupplier: { id: string; name: string } | null;
  plan: Plan | null;
};

type BucketSummary = { label: string; batches: number; quantity: number; value: number | null; withoutPlan: number };

type ExpiryResponse = {
  items: ExpiryRow[];
  summary: {
    byBucket: Record<BucketKey, BucketSummary>;
    totalBatches: number;
    withoutPlan: number;
    overduePlans: number;
    totalValue: number | null;
  };
};

const ACTIONS: Array<{ value: ExpiryAction; label: string; hint: string }> = [
  { value: "RETURN_SUPPLIER", label: "Trả nhà cung cấp", hint: "Gọi nhà cung cấp đổi hoặc trả hàng khi còn trong thỏa thuận." },
  { value: "PRIORITIZE_SALE", label: "Ưu tiên bán trước", hint: "Đưa lên kệ dễ thấy, nhắc nhân viên bán lô này trước." },
  { value: "DISCOUNT", label: "Giảm giá để đẩy hàng", hint: "Chấp nhận lãi thấp còn hơn để hết hạn phải hủy." },
  { value: "DISPOSE", label: "Lên lịch xuất hủy", hint: "Hàng không còn bán được; lập phiếu điều chỉnh xuất hủy khi tới hạn." },
];

const actionLabel = (action: ExpiryAction) => ACTIONS.find((item) => item.value === action)?.label ?? action;

const BUCKET_TABS: Array<{ value: BucketKey | "ALL"; label: string }> = [
  { value: "ALL", label: "Tất cả" },
  { value: "EXPIRED", label: "Đã hết hạn" },
  { value: "D30", label: "Dưới 30 ngày" },
  { value: "D60", label: "31 – 60 ngày" },
  { value: "D90", label: "61 – 90 ngày" },
];

export function ExpiryAlertsPage() {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [bucket, setBucket] = useState<BucketKey | "ALL">("ALL");
  const [onlyWithoutPlan, setOnlyWithoutPlan] = useState(false);
  const [editing, setEditing] = useState<ExpiryRow | null>(null);
  const [historyOf, setHistoryOf] = useState<ExpiryRow | null>(null);
  const [form] = Form.useForm();
  const canPlan = can("stock.adjust.create");

  const params = { horizonDays: 90, bucket: bucket === "ALL" ? undefined : bucket, onlyWithoutPlan };
  const data = useQuery({
    queryKey: ["expiry-alerts", params],
    queryFn: async () => (await http.get<Envelope<ExpiryResponse>>("/expiry-alerts", { params })).data.data,
  });

  const history = useQuery({
    queryKey: ["expiry-plan-history", historyOf?.batchId],
    enabled: Boolean(historyOf),
    queryFn: async () => (await http.get<Envelope<Plan[]>>(`/expiry-alerts/batches/${historyOf!.batchId}/plans`)).data.data,
  });

  const savePlan = useMutation({
    mutationFn: async (values: { batchId: string; action: ExpiryAction; dueDate?: dayjs.Dayjs | null; note?: string | null }) =>
      http.post("/expiry-alerts/plans", {
        batchId: values.batchId,
        action: values.action,
        dueDate: values.dueDate ? values.dueDate.format("YYYY-MM-DD") : null,
        note: values.note ?? null,
      }),
    onSuccess: async () => {
      setEditing(null);
      void message.success("Đã lưu kế hoạch xử lý");
      await queryClient.invalidateQueries({ queryKey: ["expiry-alerts"] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được kế hoạch")),
  });

  const closePlan = useMutation({
    mutationFn: async (input: { planId: string; status: "DONE" | "CANCELLED"; outcome: string }) =>
      http.post(`/expiry-alerts/plans/${input.planId}/close`, { status: input.status, outcome: input.outcome || null }),
    onSuccess: async (_result, input) => {
      void message.success(input.status === "DONE" ? "Đã đánh dấu xử lý xong" : "Đã bỏ kế hoạch");
      await queryClient.invalidateQueries({ queryKey: ["expiry-alerts"] });
      await queryClient.invalidateQueries({ queryKey: ["expiry-plan-history"] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không đóng được kế hoạch")),
  });

  function confirmClose(row: ExpiryRow, status: "DONE" | "CANCELLED"): void {
    let outcome = "";
    modal.confirm({
      title: status === "DONE" ? "Đã xử lý xong lô này?" : "Bỏ kế hoạch xử lý?",
      content: (
        <div>
          <p>
            {row.productName} · lô {row.batchNumber}: {actionLabel(row.plan!.action)}.
          </p>
          <Input.TextArea rows={2} placeholder={status === "DONE" ? "Kết quả, ví dụ: đã trả 40 viên cho NCC" : "Lý do bỏ kế hoạch"} onChange={(event) => (outcome = event.target.value)} />
        </div>
      ),
      okText: status === "DONE" ? "Xong" : "Bỏ kế hoạch",
      cancelText: "Quay lại",
      okButtonProps: status === "CANCELLED" ? { danger: true } : undefined,
      onOk: () => closePlan.mutateAsync({ planId: row.plan!.id, status, outcome }).then(() => undefined),
    });
  }

  const summary = data.data?.summary;

  const columns = [
    {
      title: "Sản phẩm / lô",
      dataIndex: "productName",
      render: (_: string, row: ExpiryRow) => (
        <div className="cell-main">
          <span className="cell-title">{row.productName}</span>
          <span className="cell-sub">
            {row.productCode} · Lô {row.batchNumber}
            {row.shelfLocation ? ` · ${row.shelfLocation}` : ""}
            {row.batchStatus !== "AVAILABLE" ? ` · ${row.batchStatus === "QUARANTINED" ? "đang biệt trữ" : row.batchStatus}` : ""}
          </span>
        </div>
      ),
    },
    {
      title: "Hạn dùng",
      dataIndex: "expiryDate",
      width: 165,
      render: (value: string, row: ExpiryRow) => (
        <div className="cell-main">
          <span className="cell-title">{formatDate(value)}</span>
          <span className={row.daysLeft < 0 ? "count-diff-minus" : "cell-sub"}>
            {row.daysLeft < 0 ? `Đã quá hạn ${formatNumber(Math.abs(row.daysLeft))} ngày` : `Còn ${formatNumber(row.daysLeft)} ngày`}
          </span>
        </div>
      ),
    },
    {
      title: "Tồn / giá trị",
      dataIndex: "quantityOnHand",
      width: 150,
      align: "right" as const,
      render: (value: number, row: ExpiryRow) => (
        <div className="cell-main" style={{ alignItems: "flex-end" }}>
          <span className="cell-title">
            {formatNumber(value)} {row.baseUnitName}
          </span>
          {row.stockValue !== null ? <span className="cell-sub">{formatVnd(row.stockValue)}</span> : null}
        </div>
      ),
    },
    {
      title: "Nhà cung cấp",
      dataIndex: "lastSupplier",
      width: 190,
      render: (_: unknown, row: ExpiryRow) => (row.lastSupplier ? row.lastSupplier.name : <span className="cell-sub">Không rõ nguồn nhập</span>),
    },
    {
      title: "Kế hoạch xử lý",
      dataIndex: "plan",
      width: 260,
      render: (plan: Plan | null, row: ExpiryRow) =>
        plan ? (
          <div className="cell-main">
            <span className="cell-title">
              <Tag variant="filled" color={plan.overdue ? "red" : "blue"}>
                {actionLabel(plan.action)}
              </Tag>
            </span>
            <span className="cell-sub">
              {plan.dueDate ? `Hẹn ${formatDate(plan.dueDate)}${plan.overdue ? " · đã quá hẹn" : ""}` : "Chưa đặt ngày hẹn"} · {plan.createdByName}
              {plan.note ? ` · ${plan.note}` : ""}
            </span>
          </div>
        ) : (
          <Tag variant="filled" color={row.daysLeft < 0 ? "red" : "orange"}>
            Chưa có kế hoạch
          </Tag>
        ),
    },
    {
      title: "",
      dataIndex: "batchId",
      width: 210,
      render: (_: string, row: ExpiryRow) => (
        <div className="expiry-actions">
          {canPlan ? (
            <Button
              size="small"
              type={row.plan ? "default" : "primary"}
              onClick={() => setEditing(row)}
            >
              {row.plan ? "Sửa" : "Lên kế hoạch"}
            </Button>
          ) : null}
          {canPlan && row.plan ? (
            <Tooltip title="Đánh dấu đã xử lý xong">
              <Button size="small" icon={<CheckOutlined />} onClick={() => confirmClose(row, "DONE")} />
            </Tooltip>
          ) : null}
          <Tooltip title="Lịch sử xử lý của lô">
            <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryOf(row)} />
          </Tooltip>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        icon={<FieldTimeOutlined />}
        title="Hàng cận hạn"
        description="Lô sắp hết hạn và đã hết hạn, kèm kế hoạch xử lý cho từng lô: trả nhà cung cấp, đẩy bán, giảm giá hay xuất hủy."
        extra={
          <Button icon={<ClockCircleOutlined />} onClick={() => void navigate("/dieu-chinh-ton")}>
            Lập phiếu xuất hủy
          </Button>
        }
      />

      {data.isError ? <Alert type="error" showIcon title="Không đọc được danh sách hàng cận hạn" description={getErrorMessage(data.error)} /> : null}

      {summary ? (
        <>
          {summary.overduePlans > 0 ? (
            <Alert
              className="count-banner"
              type="warning"
              showIcon
              icon={<WarningFilled />}
              title={`${formatNumber(summary.overduePlans)} kế hoạch đã quá ngày hẹn mà chưa xong`}
              description="Những lô này đã có người nhận xử lý nhưng quá hẹn. Kiểm tra lại với người phụ trách trước khi hàng hết hạn."
            />
          ) : null}
          {summary.byBucket.EXPIRED.batches > 0 ? (
            <Alert
              className="count-banner"
              type="error"
              showIcon
              title={`${formatNumber(summary.byBucket.EXPIRED.batches)} lô đã hết hạn còn nằm trong kho`}
              description="Hàng hết hạn không bán được nữa. Tách khỏi khu vực bán và lập phiếu điều chỉnh xuất hủy, lưu biên bản theo GPP."
            />
          ) : null}

          <div className="count-stats">
            {(["EXPIRED", "D30", "D60", "D90"] as BucketKey[]).map((key) => {
              const item = summary.byBucket[key];
              return (
                <div key={key} className={`count-stat ${key === "EXPIRED" && item.batches > 0 ? "bad" : ""}`}>
                  <span>{item.label}</span>
                  <b>{formatNumber(item.batches)} lô</b>
                  <span>
                    {formatNumber(item.quantity)} đơn vị{item.value !== null ? ` · ${formatVnd(item.value)}` : ""}
                    {item.withoutPlan > 0 ? ` · ${formatNumber(item.withoutPlan)} chưa có kế hoạch` : ""}
                  </span>
                </div>
              );
            })}
            {summary.totalValue !== null ? (
              <div className="count-stat">
                <span>Tiền đang treo ở hàng cận hạn</span>
                <b>{formatVnd(summary.totalValue)}</b>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      <Card>
        <div className="count-toolbar">
          <Segmented value={bucket} onChange={(value) => setBucket(value as BucketKey | "ALL")} options={BUCKET_TABS} />
          <label className="expiry-filter">
            <Switch checked={onlyWithoutPlan} onChange={setOnlyWithoutPlan} size="small" /> Chỉ lô chưa có kế hoạch
          </label>
        </div>

        {data.isLoading ? (
          <Skeleton active />
        ) : (
          <Table
            rowKey="batchId"
            size="small"
            dataSource={data.data?.items ?? []}
            columns={columns}
            scroll={{ x: 1100 }}
            pagination={(data.data?.items.length ?? 0) > 30 ? { pageSize: 30, size: "small" } : false}
            rowClassName={(row) => (row.daysLeft < 0 ? "count-row-diff" : "")}
            locale={{ emptyText: <Empty description="Không có lô nào trong nhóm này — kho đang sạch hạn dùng" /> }}
          />
        )}
      </Card>

      <Modal
        title={editing ? `Kế hoạch xử lý lô ${editing.batchNumber}` : "Kế hoạch xử lý"}
        open={Boolean(editing)}
        onCancel={() => setEditing(null)}
        okText="Lưu kế hoạch"
        cancelText="Hủy"
        confirmLoading={savePlan.isPending}
        onOk={() => form.submit()}
        destroyOnHidden
        footer={
          editing?.plan
            ? [
                <Button key="drop" danger onClick={() => editing && confirmClose(editing, "CANCELLED")}>
                  Bỏ kế hoạch
                </Button>,
                <Button key="cancel" onClick={() => setEditing(null)}>
                  Hủy
                </Button>,
                <Button key="ok" type="primary" loading={savePlan.isPending} onClick={() => form.submit()}>
                  Lưu kế hoạch
                </Button>,
              ]
            : undefined
        }
      >
        {editing ? (
          <Form
            form={form}
            key={editing.batchId}
            layout="vertical"
            initialValues={{
              action: editing.plan?.action ?? (editing.daysLeft < 0 ? "DISPOSE" : "RETURN_SUPPLIER"),
              dueDate: editing.plan?.dueDate ? dayjs(editing.plan.dueDate) : null,
              note: editing.plan?.note ?? "",
            }}
            onFinish={(values) => savePlan.mutate({ ...values, batchId: editing.batchId })}
          >
            <Alert
              type={editing.daysLeft < 0 ? "error" : "warning"}
              showIcon
              className="count-banner"
              title={`${editing.productName} · ${formatNumber(editing.quantityOnHand)} ${editing.baseUnitName}`}
              description={`HSD ${formatDate(editing.expiryDate)} · ${editing.daysLeft < 0 ? `đã quá hạn ${formatNumber(Math.abs(editing.daysLeft))} ngày` : `còn ${formatNumber(editing.daysLeft)} ngày`}${editing.lastSupplier ? ` · nhập từ ${editing.lastSupplier.name}` : ""}`}
            />
            <Form.Item name="action" label="Cách xử lý" rules={[{ required: true, message: "Chọn cách xử lý" }]}>
              <Select
                options={ACTIONS.map((item) => ({
                  value: item.value,
                  label: (
                    <div>
                      <div>{item.label}</div>
                      <div className="cell-sub">{item.hint}</div>
                    </div>
                  ),
                }))}
              />
            </Form.Item>
            <Form.Item name="dueDate" label="Hẹn xong trước ngày" extra="Quá ngày hẹn mà chưa xong, hệ thống sẽ báo lại.">
              <DatePicker format="DD/MM/YYYY" style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="note" label="Ghi chú">
              <Input.TextArea rows={2} maxLength={500} placeholder="Ví dụ: đã gọi NCC ngày 23/9, chờ xác nhận đổi hàng" />
            </Form.Item>
          </Form>
        ) : null}
      </Modal>

      <Modal title={historyOf ? `Lịch sử xử lý lô ${historyOf.batchNumber}` : ""} open={Boolean(historyOf)} onCancel={() => setHistoryOf(null)} footer={null} destroyOnHidden>
        {history.isLoading ? <Skeleton active /> : null}
        {history.data?.length === 0 ? <Empty description="Lô này chưa từng có kế hoạch xử lý" /> : null}
        {history.data && history.data.length > 0 ? (
          <Timeline
            items={history.data.map((plan) => ({
              color: plan.status === "DONE" ? "green" : plan.status === "CANCELLED" ? "gray" : "blue",
              content: (
                <div className="cell-main">
                  <span className="cell-title">
                    {actionLabel(plan.action)} · {plan.status === "PLANNED" ? "đang thực hiện" : plan.status === "DONE" ? "đã xong" : "đã bỏ"}
                  </span>
                  <span className="cell-sub">
                    {plan.createdByName} lập lúc {formatDateTime(plan.createdAt)}
                    {plan.dueDate ? ` · hẹn ${formatDate(plan.dueDate)}` : ""}
                  </span>
                  {plan.note ? <span className="cell-sub">Ghi chú: {plan.note}</span> : null}
                  {plan.outcome ? (
                    <span className="cell-sub">
                      Kết quả: {plan.outcome}
                      {plan.resolvedByName ? ` (${plan.resolvedByName}, ${formatDateTime(plan.resolvedAt!)})` : ""}
                    </span>
                  ) : null}
                </div>
              ),
            }))}
          />
        ) : null}
      </Modal>
    </div>
  );
}
