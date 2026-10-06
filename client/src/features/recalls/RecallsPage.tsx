import {
  AlertOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Grid,
  Input,
  Modal,
  Popconfirm,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import dayjs from "dayjs";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { getErrorMessage, http } from "../../api/http.js";
import type { Envelope, Paged, ProductListItem } from "../../api/types.js";
import { formatDate, formatDateTime, formatNumber } from "../../ui/format.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { PageHeader } from "../../ui/PageHeader.js";

type RecallStatus = "OPEN" | "CLOSED";

type RecallSummary = {
  id: string;
  documentNumber: string;
  issuedBy: string | null;
  issuedAt: string;
  reason: string | null;
  status: RecallStatus;
  createdAt: string;
  _count: { items: number };
};

type RecallDetail = {
  id: string;
  documentNumber: string;
  issuedBy: string | null;
  issuedAt: string;
  reason: string | null;
  status: RecallStatus;
  createdBy: { id: string; fullName: string };
  closedBy: { id: string; fullName: string } | null;
  closedAt: string | null;
  items: Array<{
    id: string;
    productId: string;
    productCode: string;
    productName: string;
    batchNumber: string;
    foundInStock: boolean;
  }>;
  affectedBatches: Array<{
    id: string;
    productCode: string;
    productName: string;
    batchNumber: string;
    storeCode: string;
    storeName: string;
    status: string;
    quantityOnHand: number;
  }>;
  remainingBaseQuantity: number;
};

type AffectedSale = {
  invoiceId: string;
  invoiceCode: string;
  storeCode: string;
  soldAt: string;
  customer: { id: string; fullName: string | null; phone: string | null } | null;
  productName: string;
  batchNumber: string;
  baseQuantity: number;
};

type RecallFormValues = {
  documentNumber: string;
  issuedBy?: string;
  issuedAt: dayjs.Dayjs;
  reason?: string;
  items: Array<{ productId: string; batchNumber: string }>;
};

const STATUS: Record<RecallStatus, { label: string; color: string }> = {
  OPEN: { label: "Đang xử lý", color: "red" },
  CLOSED: { label: "Đã đóng", color: "default" },
};

function ProductPicker({
  value,
  onChange,
}: {
  value?: string;
  onChange?: (value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const term = useDebounced(search.trim(), 300);
  const products = useQuery({
    queryKey: ["recall-product-search", term],
    enabled: term.length >= 2,
    queryFn: async () =>
      (
        await http.get<Envelope<Paged<ProductListItem>>>("/products", {
          params: {
            search: term,
            page: 1,
            limit: 20,
            isActive: true,
            sortBy: "name",
            order: "asc",
          },
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
      placeholder="Nhập ít nhất 2 ký tự để tìm thuốc"
      notFoundContent={term.length < 2 ? "Nhập tên hoặc mã sản phẩm" : "Không tìm thấy sản phẩm"}
      options={products.data?.map((product) => ({
        value: product.id,
        label: `${product.code} · ${product.name}`,
      }))}
    />
  );
}

export function RecallsPage() {
  const { message, modal } = App.useApp();
  const screens = Grid.useBreakpoint();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RecallStatus | "ALL">("OPEN");
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAffectedSales, setShowAffectedSales] = useState(false);
  const [form] = Form.useForm<RecallFormValues>();
  const createAttempt = useRef<{ signature: string; key: string } | null>(null);

  const recalls = useQuery({
    queryKey: ["recalls", status],
    queryFn: async () =>
      (
        await http.get<Envelope<RecallSummary[]>>("/recalls", {
          params: { status: status === "ALL" ? undefined : status },
        })
      ).data.data,
  });

  const detail = useQuery({
    queryKey: ["recall-detail", selectedId],
    enabled: selectedId !== null,
    queryFn: async () =>
      (await http.get<Envelope<RecallDetail>>(`/recalls/${selectedId}`)).data.data,
  });

  const affectedSales = useQuery({
    queryKey: ["recall-affected-sales", selectedId],
    enabled: selectedId !== null && showAffectedSales,
    queryFn: async () =>
      (await http.get<Envelope<AffectedSale[]>>(`/recalls/${selectedId}/affected-sales`)).data.data,
  });

  const create = useMutation({
    mutationFn: (values: RecallFormValues) => {
      const body = {
        documentNumber: values.documentNumber,
        issuedBy: values.issuedBy || null,
        // Cột issued_at kiểu ngày: gửi đúng ngày đã chọn, không đổi qua UTC (lùi một ngày ở múi giờ +7).
        issuedAt: values.issuedAt.format("YYYY-MM-DD"),
        reason: values.reason || null,
        items: values.items,
      };
      const signature = JSON.stringify(body);
      if (createAttempt.current?.signature !== signature) {
        createAttempt.current = { signature, key: crypto.randomUUID() };
      }
      return http.post<Envelope<RecallDetail>>("/recalls", body, {
        headers: { "Idempotency-Key": createAttempt.current.key },
      });
    },
    onSuccess: async (response) => {
      createAttempt.current = null;
      void message.success("Đã tạo thông báo thu hồi và khóa các lô khớp");
      setCreating(false);
      form.resetFields();
      // Mở luôn chi tiết: việc tiếp theo là xem lô nào đang bị khóa ở cửa hàng nào.
      queryClient.setQueryData(["recall-detail", response.data.data.id], response.data.data);
      openDetail(response.data.data.id);
      await queryClient.invalidateQueries({ queryKey: ["recalls"] });
    },
    onError: (error) =>
      void message.error(getErrorMessage(error, "Không tạo được thông báo thu hồi")),
  });

  const close = useMutation({
    mutationFn: (id: string) =>
      http.post(
        `/recalls/${id}/close`,
        {},
        { headers: { "Idempotency-Key": crypto.randomUUID() } },
      ),
    onSuccess: async () => {
      void message.success("Đã đóng thông báo thu hồi");
      await queryClient.invalidateQueries({ queryKey: ["recalls"] });
      await queryClient.invalidateQueries({ queryKey: ["recall-detail", selectedId] });
    },
    onError: (error) =>
      void message.error(getErrorMessage(error, "Chưa thể đóng thông báo thu hồi")),
  });

  const listColumns = [
    {
      title: "Thông báo / công văn",
      dataIndex: "documentNumber",
      render: (_: string, item: RecallSummary) => (
        <div className="cell-main">
          <span className="cell-title">{item.documentNumber}</span>
          <span className="cell-sub">Ban hành {formatDate(item.issuedAt)}</span>
        </div>
      ),
    },
    {
      title: "Đơn vị ban hành",
      dataIndex: "issuedBy",
      render: (value: string | null) => value || "—",
    },
    {
      title: "Mặt hàng / lô",
      dataIndex: "_count",
      width: 125,
      align: "right" as const,
      render: (value: RecallSummary["_count"]) => formatNumber(value.items),
    },
    {
      title: "Trạng thái",
      dataIndex: "status",
      width: 130,
      render: (value: RecallStatus) => <Tag color={STATUS[value].color}>{STATUS[value].label}</Tag>,
    },
    {
      title: "",
      key: "open",
      width: 90,
      align: "right" as const,
      render: (_: unknown, item: RecallSummary) => (
        <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(item.id)}>
          Chi tiết
        </Button>
      ),
    },
  ];

  function openDetail(id: string): void {
    setSelectedId(id);
    setShowAffectedSales(false);
  }

  function submit(values: RecallFormValues): void {
    modal.confirm({
      title: "Tạo thông báo thu hồi?",
      content:
        "Các lô khớp sản phẩm và số lô sẽ bị ngừng bán tại mọi cửa hàng. Số lô chưa có trong kho vẫn được lưu để đối chiếu.",
      okText: "Tạo và khóa lô",
      cancelText: "Kiểm tra lại",
      okButtonProps: { danger: true, loading: create.isPending },
      onOk: () => create.mutateAsync(values).then(() => undefined),
    });
  }

  const detailData = detail.data;

  return (
    <div>
      <PageHeader
        icon={<SafetyCertificateOutlined />}
        title="Thông báo thu hồi thuốc"
        description="Theo dõi công văn thu hồi, khóa lô trên toàn chuỗi và rà soát khách đã mua lô bị ảnh hưởng."
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            Tạo thông báo
          </Button>
        }
      />

      <Alert
        type="warning"
        showIcon
        icon={<AlertOutlined />}
        style={{ marginBottom: 16 }}
        title="Tạo thông báo sẽ ngừng bán mọi lô khớp trên tất cả cửa hàng"
        description="Đối chiếu chính xác sản phẩm và số lô trước khi xác nhận. Lô bị thu hồi chỉ đóng thông báo sau khi tồn đã được xử lý hết."
      />

      <Card>
        <Space wrap style={{ marginBottom: 14 }}>
          <Select
            aria-label="Lọc trạng thái thu hồi"
            value={status}
            onChange={setStatus}
            style={{ minWidth: 180 }}
            options={[
              { value: "OPEN", label: "Đang xử lý" },
              { value: "CLOSED", label: "Đã đóng" },
              { value: "ALL", label: "Tất cả" },
            ]}
          />
          <Button
            icon={<ReloadOutlined />}
            loading={recalls.isFetching}
            onClick={() => void recalls.refetch()}
          >
            Tải lại
          </Button>
        </Space>

        {recalls.isError ? (
          <Alert
            type="error"
            showIcon
            title="Không tải được thông báo thu hồi"
            description={getErrorMessage(recalls.error)}
          />
        ) : recalls.isLoading ? (
          <Skeleton active />
        ) : recalls.data?.length ? (
          <Table
            rowKey="id"
            size="middle"
            dataSource={recalls.data}
            columns={listColumns}
            scroll={{ x: 760 }}
            pagination={{ pageSize: 10, showSizeChanger: false }}
            onRow={(item) => ({ onClick: () => openDetail(item.id), style: { cursor: "pointer" } })}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có thông báo thu hồi" />
        )}
      </Card>

      <Modal
        title="Tạo thông báo thu hồi"
        open={creating}
        onCancel={() => {
          setCreating(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        okText="Tiếp tục"
        cancelText="Hủy"
        confirmLoading={create.isPending}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ issuedAt: dayjs(), items: [{ productId: undefined, batchNumber: "" }] }}
          onFinish={submit}
        >
          <Form.Item
            name="documentNumber"
            label="Số công văn"
            rules={[{ required: true, whitespace: true, message: "Nhập số công văn thu hồi" }]}
          >
            <Input maxLength={100} placeholder="Ví dụ: 123/QLD-CL" />
          </Form.Item>
          <div>
            <Form.Item name="issuedBy" label="Đơn vị ban hành">
              <Input maxLength={200} placeholder="Cơ quan hoặc nhà sản xuất" />
            </Form.Item>
            <Form.Item
              name="issuedAt"
              label="Ngày ban hành"
              rules={[{ required: true, message: "Chọn ngày ban hành" }]}
            >
              <DatePicker style={{ width: "100%" }} format="DD/MM/YYYY" />
            </Form.Item>
          </div>
          <Form.Item name="reason" label="Lý do / nội dung thu hồi">
            <Input.TextArea rows={2} maxLength={1000} />
          </Form.Item>
          <Form.List
            name="items"
            rules={[
              {
                validator: async (_, value: RecallFormValues["items"]) => {
                  if (!value?.length) throw new Error("Thêm ít nhất một sản phẩm và số lô");
                },
              },
            ]}
          >
            {(fields, { add, remove }, { errors }) => (
              <div className="detail-stack">
                <Typography.Text strong>Sản phẩm và số lô</Typography.Text>
                {fields.map((field, index) => (
                  <div key={field.key}>
                    <Form.Item
                      name={[field.name, "productId"]}
                      label={index === 0 ? "Sản phẩm" : undefined}
                      rules={[{ required: true, message: "Chọn sản phẩm" }]}
                    >
                      <ProductPicker />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, "batchNumber"]}
                      label={index === 0 ? "Số lô" : undefined}
                      rules={[{ required: true, whitespace: true, message: "Nhập số lô" }]}
                    >
                      <Input maxLength={50} placeholder="Số lô trên bao bì" />
                    </Form.Item>
                    {fields.length > 1 ? (
                      <Button
                        danger
                        aria-label={`Xóa dòng ${index + 1}`}
                        onClick={() => remove(field.name)}
                      >
                        Xóa
                      </Button>
                    ) : null}
                  </div>
                ))}
                <Form.ErrorList errors={errors} />
                <Button onClick={() => add({ productId: undefined, batchNumber: "" })}>
                  Thêm sản phẩm / lô
                </Button>
              </div>
            )}
          </Form.List>
        </Form>
      </Modal>

      <Drawer
        title={detailData?.documentNumber ?? "Chi tiết thu hồi"}
        open={selectedId !== null}
        onClose={() => setSelectedId(null)}
        size={screens.lg ? 860 : "default"}
        extra={
          detailData?.status === "OPEN" && detailData.remainingBaseQuantity === 0 ? (
            <Popconfirm
              title="Đóng thông báo thu hồi?"
              description="Chỉ đóng sau khi xác nhận đã xử lý hết tồn các lô bị ảnh hưởng."
              okText="Đóng thông báo"
              cancelText="Hủy"
              onConfirm={() => close.mutate(detailData.id)}
            >
              <Button type="primary" loading={close.isPending}>
                Đóng thông báo
              </Button>
            </Popconfirm>
          ) : null
        }
      >
        {detail.isLoading ? <Skeleton active /> : null}
        {detail.isError ? (
          <Alert
            type="error"
            showIcon
            title="Không tải được chi tiết"
            description={getErrorMessage(detail.error)}
          />
        ) : null}
        {detailData ? (
          <div className="detail-stack">
            <Descriptions size="small" column={{ xs: 1, sm: 2 }} bordered>
              <Descriptions.Item label="Trạng thái">
                <Tag color={STATUS[detailData.status].color}>{STATUS[detailData.status].label}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Ngày ban hành">
                {formatDate(detailData.issuedAt)}
              </Descriptions.Item>
              <Descriptions.Item label="Đơn vị ban hành">
                {detailData.issuedBy || "—"}
              </Descriptions.Item>
              <Descriptions.Item label="Người lập">
                {detailData.createdBy.fullName}
              </Descriptions.Item>
              <Descriptions.Item label="Lý do" span="filled">
                {detailData.reason || "—"}
              </Descriptions.Item>
              {detailData.closedAt ? (
                <Descriptions.Item label="Đã đóng">
                  {formatDateTime(detailData.closedAt)} · {detailData.closedBy?.fullName ?? "—"}
                </Descriptions.Item>
              ) : null}
            </Descriptions>

            <div>
              <Typography.Title level={5}>Sản phẩm / số lô trong công văn</Typography.Title>
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={detailData.items}
                scroll={{ x: 520 }}
                columns={[
                  {
                    title: "Sản phẩm",
                    render: (_: unknown, item: RecallDetail["items"][number]) =>
                      `${item.productCode} · ${item.productName}`,
                  },
                  { title: "Số lô", dataIndex: "batchNumber", width: 150 },
                  {
                    title: "Kết quả đối chiếu",
                    dataIndex: "foundInStock",
                    width: 170,
                    render: (value: boolean) =>
                      value ? <Tag color="red">Có lô trong kho</Tag> : <Tag>Chưa có trong kho</Tag>,
                  },
                ]}
              />
            </div>

            <div>
              <Typography.Title level={5}>Tồn các lô bị ảnh hưởng</Typography.Title>
              <Alert
                type={detailData.remainingBaseQuantity > 0 ? "warning" : "success"}
                showIcon
                title={`Còn ${formatNumber(detailData.remainingBaseQuantity)} đơn vị nhỏ nhất trong các cửa hàng`}
                description={
                  detailData.remainingBaseQuantity > 0 ? (
                    <>
                      Lô đã bị khóa bán. Xuất hàng còn tồn bằng{" "}
                      <Link to="/dieu-chinh-ton">phiếu điều chỉnh tồn</Link> với lý do “Thu hồi,
                      xuất hủy” tại từng cửa hàng rồi mới đóng thông báo.
                    </>
                  ) : (
                    "Đã hết tồn; có thể đóng thông báo."
                  )
                }
                style={{ marginBottom: 10 }}
              />
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={detailData.affectedBatches}
                scroll={{ x: 600 }}
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="Không có lô khớp trong kho"
                    />
                  ),
                }}
                columns={[
                  {
                    title: "Sản phẩm / lô",
                    render: (_: unknown, batch: RecallDetail["affectedBatches"][number]) => (
                      <div className="cell-main">
                        <span className="cell-title">{batch.productName}</span>
                        <span className="cell-sub">
                          {batch.productCode} · {batch.batchNumber}
                        </span>
                      </div>
                    ),
                  },
                  {
                    title: "Cửa hàng",
                    render: (_: unknown, batch: RecallDetail["affectedBatches"][number]) =>
                      `${batch.storeCode} · ${batch.storeName}`,
                  },
                  {
                    title: "Trạng thái",
                    dataIndex: "status",
                    width: 130,
                    render: (value: string) => (
                      <Tag color="red">{value === "RECALLED" ? "Đã khóa" : value}</Tag>
                    ),
                  },
                  {
                    title: "Tồn",
                    dataIndex: "quantityOnHand",
                    width: 90,
                    align: "right" as const,
                    render: (value: number) => formatNumber(value),
                  },
                ]}
              />
            </div>

            <div>
              <Space style={{ marginBottom: 8 }}>
                <Typography.Title level={5} style={{ margin: 0 }}>
                  Khách đã mua các lô này
                </Typography.Title>
                <Button
                  size="small"
                  icon={<EyeOutlined />}
                  onClick={() => setShowAffectedSales(true)}
                  loading={affectedSales.isFetching}
                >
                  Tải danh sách
                </Button>
              </Space>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 10 }}
                title="Danh sách có thông tin liên hệ khách hàng. Mỗi lần tải được ghi vào nhật ký hệ thống."
              />
              {showAffectedSales ? (
                affectedSales.isError ? (
                  <Alert
                    type="error"
                    showIcon
                    title="Không tải được danh sách"
                    description={getErrorMessage(affectedSales.error)}
                  />
                ) : affectedSales.isLoading ? (
                  <Skeleton active />
                ) : (
                  <Table
                    rowKey={(item) => `${item.invoiceId}:${item.batchNumber}:${item.productName}`}
                    size="small"
                    pagination={{ pageSize: 8, showSizeChanger: false }}
                    dataSource={affectedSales.data ?? []}
                    scroll={{ x: 640 }}
                    locale={{
                      emptyText: (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description="Không tìm thấy hóa đơn bán các lô bị thu hồi"
                        />
                      ),
                    }}
                    columns={[
                      {
                        title: "Hóa đơn / cửa hàng",
                        render: (_: unknown, item: AffectedSale) => (
                          <div className="cell-main">
                            <span className="cell-title">{item.invoiceCode}</span>
                            <span className="cell-sub">
                              {item.storeCode} · {formatDateTime(item.soldAt)}
                            </span>
                          </div>
                        ),
                      },
                      {
                        title: "Khách hàng",
                        render: (_: unknown, item: AffectedSale) => (
                          <div className="cell-main">
                            <span className="cell-title">
                              {item.customer?.fullName ?? "Khách vãng lai / đã ẩn danh"}
                            </span>
                            <span className="cell-sub">
                              {item.customer?.phone ?? "Không có số điện thoại"}
                            </span>
                          </div>
                        ),
                      },
                      {
                        title: "Sản phẩm / lô",
                        render: (_: unknown, item: AffectedSale) => (
                          <div className="cell-main">
                            <span>{item.productName}</span>
                            <span className="cell-sub">Lô {item.batchNumber}</span>
                          </div>
                        ),
                      },
                      {
                        title: "SL",
                        dataIndex: "baseQuantity",
                        width: 65,
                        align: "right" as const,
                        render: (value: number) => formatNumber(value),
                      },
                    ]}
                  />
                )
              ) : null}
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
