import { AuditOutlined, PlusOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Card, Form, Input, Modal, Progress, Select, Skeleton, Table, Tag } from "antd";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { getErrorMessage, http } from "../../../api/http.js";
import type { Envelope, Paged } from "../../../api/types.js";
import { formatDateTime, formatNumber } from "../../../ui/format.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { useAuth } from "../../auth/AuthProvider.js";
import { CountingBoard } from "./CountingBoard.js";
import { listCounts, openCount, type CountListItem } from "./stock-count-api.js";

type CategoryItem = { id: string; name: string };

export function StockCountsPage() {
  const { message } = App.useApp();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [categorySearch, setCategorySearch] = useState("");
  const [form] = Form.useForm();
  const scopeType = Form.useWatch("scopeType", form) as string | undefined;
  const openId = params.get("dot");

  const list = useQuery({ queryKey: ["stock-counts"], queryFn: () => listCounts() });
  // API trả tối đa 100 nhóm mỗi lần, nên gõ để tìm khi danh mục dài.
  const categories = useQuery({
    queryKey: ["product-categories", categorySearch],
    enabled: creating,
    queryFn: async () => (await http.get<Envelope<Paged<CategoryItem>>>("/categories", { params: { limit: 100, search: categorySearch || undefined } })).data.data.items,
  });

  const create = useMutation({
    mutationFn: openCount,
    onSuccess: async (data) => {
      setCreating(false);
      form.resetFields();
      await queryClient.invalidateQueries({ queryKey: ["stock-counts"] });
      queryClient.setQueryData(["stock-count", data.count.id], data);
      select(data.count.id);
      void message.success(`Đã mở đợt ${data.count.code} với ${formatNumber(data.lines.length)} dòng cần đếm`);
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không mở được đợt kiểm kê"), 8),
  });

  function select(id: string | null): void {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id) next.set("dot", id);
        else next.delete("dot");
        return next;
      },
      { replace: true },
    );
  }

  if (openId) return <CountingBoard countId={openId} onBack={() => select(null)} />;

  const columns = [
    {
      title: "Đợt kiểm kê",
      dataIndex: "code",
      render: (code: string, row: CountListItem) => (
        <div className="cell-main">
          <span className="cell-title">{code}</span>
          <span className="cell-sub">
            {row.scopeType === "ALL" ? "Toàn bộ kho" : row.scopeType === "CATEGORY" ? `Nhóm: ${row.scopeLabel}` : `Kệ: ${row.scopeLabel}`} · {formatDateTime(row.startedAt)} · {row.createdByName}
          </span>
        </div>
      ),
    },
    {
      title: "Trạng thái",
      dataIndex: "status",
      width: 130,
      render: (status: CountListItem["status"]) =>
        status === "COUNTING" ? (
          <Tag variant="filled" color="blue">
            Đang đếm
          </Tag>
        ) : status === "CLOSED" ? (
          <Tag variant="filled" color="green">
            Đã chốt
          </Tag>
        ) : (
          <Tag variant="filled">Đã hủy</Tag>
        ),
    },
    {
      title: "Tiến độ",
      dataIndex: "countedLines",
      width: 200,
      render: (counted: number, row: CountListItem) => (
        <div className="cell-main">
          <Progress percent={row.totalLines === 0 ? 0 : Math.round((counted / row.totalLines) * 100)} size="small" />
          <span className="cell-sub">
            {formatNumber(counted)}/{formatNumber(row.totalLines)} dòng
          </span>
        </div>
      ),
    },
    {
      title: "Chênh lệch",
      dataIndex: "differenceLines",
      width: 150,
      render: (value: number, row: CountListItem) =>
        value > 0 ? (
          <div className="cell-main">
            <span className="cell-title">{formatNumber(value)} dòng lệch</span>
            {row.adjustment ? <span className="cell-sub">Phiếu {row.adjustment.code}</span> : null}
          </div>
        ) : (
          <span className="cell-sub">Khớp sổ</span>
        ),
    },
    {
      title: "",
      dataIndex: "id",
      width: 120,
      render: (id: string, row: CountListItem) => (
        <Button size="small" type={row.status === "COUNTING" ? "primary" : "default"} onClick={() => select(id)}>
          {row.status === "COUNTING" ? "Đếm tiếp" : "Xem"}
        </Button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        icon={<AuditOutlined />}
        title="Kiểm kê kho"
        description="Đếm hàng thực tế trên kệ và đối chiếu với tồn hệ thống, chênh lệch được chuyển thành phiếu điều chỉnh chờ duyệt."
        extra={
          can("stock.adjust.create") ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)} disabled={Boolean(list.data?.open)}>
              Mở đợt kiểm kê
            </Button>
          ) : null
        }
      />

      {list.data?.open ? (
        <Alert
          className="count-banner"
          type="info"
          showIcon
          title={`Đang có đợt kiểm kê ${list.data.open.code} chưa chốt`}
          description="Mỗi cửa hàng chỉ đếm một đợt tại một thời điểm. Chốt hoặc hủy đợt này rồi mới mở đợt mới."
          action={
            <Button size="small" type="primary" onClick={() => select(list.data!.open!.id)}>
              Đếm tiếp
            </Button>
          }
        />
      ) : null}

      <Card>
        {list.isLoading ? (
          <Skeleton active />
        ) : (
          <Table
            rowKey="id"
            size="small"
            dataSource={list.data?.items ?? []}
            columns={columns}
            scroll={{ x: 760 }}
            pagination={(list.data?.items.length ?? 0) > 20 ? { pageSize: 20, size: "small" } : false}
            locale={{ emptyText: "Chưa có đợt kiểm kê nào. Nhà thuốc nên kiểm kê định kỳ hằng tháng hoặc hằng quý." }}
          />
        )}
      </Card>

      <Modal
        title="Mở đợt kiểm kê"
        open={creating}
        onCancel={() => setCreating(false)}
        okText="Mở đợt và bắt đầu đếm"
        cancelText="Hủy"
        confirmLoading={create.isPending}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" initialValues={{ scopeType: "ALL" }} onFinish={(values) => create.mutate(values)}>
          <Form.Item name="scopeType" label="Phạm vi kiểm kê">
            <Select
              options={[
                { value: "ALL", label: "Toàn bộ kho" },
                { value: "CATEGORY", label: "Một nhóm hàng" },
                { value: "SHELF", label: "Một kệ" },
              ]}
            />
          </Form.Item>
          {scopeType === "CATEGORY" ? (
            <Form.Item name="scopeValue" label="Nhóm hàng" rules={[{ required: true, message: "Chọn nhóm hàng cần kiểm kê" }]}>
              <Select
                showSearch
                filterOption={false}
                loading={categories.isFetching}
                placeholder="Gõ để tìm nhóm hàng"
                onSearch={setCategorySearch}
                notFoundContent={categories.isFetching ? "Đang tìm…" : "Không có nhóm hàng khớp"}
                options={(categories.data ?? []).map((item) => ({ value: item.id, label: item.name }))}
              />
            </Form.Item>
          ) : null}
          {scopeType === "SHELF" ? (
            <Form.Item name="scopeValue" label="Tên kệ" rules={[{ required: true, message: "Nhập đúng tên kệ như đã ghi trên lô" }]} extra="Gõ đúng tên kệ đang ghi trên lô, ví dụ: Kệ A1.">
              <Input placeholder="Kệ A1" />
            </Form.Item>
          ) : null}
          <Form.Item name="note" label="Ghi chú" extra="Ví dụ: kiểm kê định kỳ quý III, bàn giao ca.">
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            title="Vẫn bán hàng bình thường trong lúc kiểm kê"
            description="Mỗi dòng được so với tồn hệ thống tại đúng thời điểm bạn ghi số đếm, nên hàng bán sau đó không bị tính thành thất thoát."
          />
        </Form>
      </Modal>
    </div>
  );
}
