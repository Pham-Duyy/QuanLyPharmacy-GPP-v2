import { CheckCircleOutlined, PlusOutlined, RollbackOutlined, SearchOutlined, StopOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Card, Empty, Form, Input, InputNumber, Modal, Radio, Segmented, Select, Skeleton, Table, Tag } from "antd";
import { useMemo, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { formatVnd, type Envelope, type Paged } from "../../api/types.js";
import { formatDate, formatDateTime, formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useAuth } from "../auth/AuthProvider.js";

type Settlement = "DEDUCT_DEBT" | "REFUND" | "REPLACEMENT";
type Status = "DRAFT" | "CONFIRMED" | "CANCELLED";

type Returnable = {
  batchId: string;
  productCode: string;
  productName: string;
  batchNumber: string;
  expiryDate: string;
  quantityOnHand: number;
  batchStatus: string;
  unitCost: number | null;
  units: Array<{ id: string; name: string; conversionToBase: number }>;
  supplier: { id: string; name: string } | null;
  goodsReceipt: { id: string; code: string } | null;
};

type ReturnListItem = {
  id: string;
  code: string;
  status: Status;
  reason: string;
  settlement: Settlement;
  totalValue: number;
  returnedAt: string;
  supplier: { id: string; name: string; phone: string | null };
  createdByName: string;
  confirmedByName: string | null;
  lineCount: number;
};

type ReturnDetail = ReturnListItem & {
  note: string | null;
  cancelReason: string | null;
  lines: Array<{
    id: string;
    lineNo: number;
    productCode: string;
    productName: string;
    batchNumber: string;
    expiryDate: string;
    unitName: string;
    quantity: number;
    baseQuantity: number;
    unitCost: number;
    lineValue: number;
    goodsReceipt: { id: string; code: string } | null;
  }>;
};

const SETTLEMENTS: Array<{ value: Settlement; label: string; hint: string }> = [
  { value: "DEDUCT_DEBT", label: "Trừ vào công nợ", hint: "Giá trị hàng trả được trừ thẳng vào khoản còn nợ của phiếu nhập gốc." },
  { value: "REFUND", label: "Nhận lại tiền", hint: "Nhà cung cấp hoàn tiền; công nợ giữ nguyên." },
  { value: "REPLACEMENT", label: "Đổi hàng khác", hint: "Nhà cung cấp giao bù hàng; công nợ giữ nguyên, hàng về lập phiếu nhập mới." },
];

const settlementLabel = (value: Settlement) => SETTLEMENTS.find((item) => item.value === value)?.label ?? value;

/**
 * Đơn vị mặc định khi trả: đơn vị lớn nhất mà tồn còn đủ ít nhất một đơn vị.
 * Lấy thẳng đơn vị lớn nhất thì lô còn ít hơn một hộp sẽ không nhập được số nào.
 */
function defaultUnit(row: Returnable): { id: string; name: string; conversionToBase: number } {
  const fits = row.units.filter((unit) => unit.conversionToBase <= row.quantityOnHand);
  return fits.at(-1) ?? row.units[0]!;
}

type SupplierOption = { id: string; name: string };

export function SupplierReturnsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<Status | "ALL">("ALL");
  const [supplierId, setSupplierId] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Record<string, { unitId: string; quantity: number }>>({});
  const [form] = Form.useForm();
  const [cancelling, setCancelling] = useState<ReturnDetail | null>(null);
  const [cancelForm] = Form.useForm();
  const canCreate = can("goods_receipt.create");
  const canConfirm = can("goods_receipt.confirm");

  const list = useQuery({
    queryKey: ["supplier-returns", statusFilter],
    queryFn: async () =>
      (await http.get<Envelope<ReturnListItem[]>>("/supplier-returns", { params: { status: statusFilter === "ALL" ? undefined : statusFilter } })).data.data,
  });

  const detail = useQuery({
    queryKey: ["supplier-return", openId],
    enabled: Boolean(openId),
    queryFn: async () => (await http.get<Envelope<ReturnDetail>>(`/supplier-returns/${openId}`)).data.data,
  });

  const suppliers = useQuery({
    queryKey: ["suppliers-for-return"],
    enabled: creating,
    queryFn: async () => (await http.get<Envelope<Paged<SupplierOption>>>("/suppliers", { params: { limit: 100 } })).data.data.items,
  });

  const returnable = useQuery({
    queryKey: ["returnable-batches", supplierId, search],
    enabled: creating && Boolean(supplierId),
    queryFn: async () => (await http.get<Envelope<Returnable[]>>("/supplier-returns/returnable", { params: { supplierId, search: search.trim() || undefined } })).data.data,
  });

  const create = useMutation({
    mutationFn: async (values: { reason: string; settlement: Settlement; note?: string }) =>
      http.post<Envelope<ReturnDetail>>("/supplier-returns", {
        supplierId,
        reason: values.reason,
        settlement: values.settlement,
        note: values.note || null,
        lines: Object.entries(picked)
          .filter(([, line]) => line.quantity > 0)
          .map(([batchId, line]) => ({ batchId, unitId: line.unitId, quantity: line.quantity })),
      }),
    onSuccess: async (response) => {
      void message.success(`Đã lập phiếu trả ${response.data.data.code} ở trạng thái nháp`);
      setCreating(false);
      setPicked({});
      setOpenId(response.data.data.id);
      await queryClient.invalidateQueries({ queryKey: ["supplier-returns"] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lập được phiếu trả hàng"), 8),
  });

  const confirm = useMutation({
    mutationFn: async (id: string) => http.post(`/supplier-returns/${id}/confirm`, {}),
    onSuccess: async () => {
      void message.success("Đã xác nhận trả hàng, tồn kho đã trừ");
      await queryClient.invalidateQueries({ queryKey: ["supplier-returns"] });
      await queryClient.invalidateQueries({ queryKey: ["supplier-return"] });
      await queryClient.invalidateQueries({ queryKey: ["supplier-debts"] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không xác nhận được phiếu trả"), 8),
  });

  const cancel = useMutation({
    mutationFn: async (values: { reason: string }) => http.post(`/supplier-returns/${cancelling!.id}/cancel`, { reason: values.reason }),
    onSuccess: async () => {
      void message.success("Đã hủy phiếu trả hàng");
      setCancelling(null);
      await queryClient.invalidateQueries({ queryKey: ["supplier-returns"] });
      await queryClient.invalidateQueries({ queryKey: ["supplier-return"] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không hủy được phiếu trả")),
  });

  const pickedTotal = useMemo(() => {
    const rows = returnable.data ?? [];
    return Object.entries(picked).reduce((sum, [batchId, line]) => {
      const row = rows.find((item) => item.batchId === batchId);
      const unit = row?.units.find((item) => item.id === line.unitId);
      return sum + (row?.unitCost ?? 0) * line.quantity * (unit?.conversionToBase ?? 1);
    }, 0);
  }, [picked, returnable.data]);

  const statusTag = (status: Status) =>
    status === "DRAFT" ? (
      <Tag variant="filled" color="gold">
        Nháp
      </Tag>
    ) : status === "CONFIRMED" ? (
      <Tag variant="filled" color="green">
        Đã trả
      </Tag>
    ) : (
      <Tag variant="filled">Đã hủy</Tag>
    );

  return (
    <div>
      <PageHeader
        icon={<RollbackOutlined />}
        title="Trả hàng nhà cung cấp"
        description="Trả lại hàng cận hạn, hàng lỗi hoặc giao sai. Xác nhận phiếu mới trừ tồn kho và ghi thẻ kho."
        extra={
          canCreate ? (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setCreating(true);
                setPicked({});
                setSupplierId(undefined);
                setSearch("");
              }}
            >
              Lập phiếu trả hàng
            </Button>
          ) : null
        }
      />

      {list.isError ? <Alert type="error" showIcon title="Không đọc được danh sách phiếu trả" description={getErrorMessage(list.error)} /> : null}

      <Card>
        <div className="count-toolbar">
          <Segmented
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as Status | "ALL")}
            options={[
              { value: "ALL", label: "Tất cả" },
              { value: "DRAFT", label: "Nháp" },
              { value: "CONFIRMED", label: "Đã trả" },
              { value: "CANCELLED", label: "Đã hủy" },
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
            scroll={{ x: 900 }}
            pagination={(list.data?.length ?? 0) > 20 ? { pageSize: 20, size: "small" } : false}
            onRow={(row) => ({ onClick: () => setOpenId(row.id) })}
            columns={[
              {
                title: "Phiếu trả",
                dataIndex: "code",
                render: (code: string, row: ReturnListItem) => (
                  <div className="cell-main">
                    <span className="cell-title">{code}</span>
                    <span className="cell-sub">
                      {formatDateTime(row.returnedAt)} · {row.createdByName} · {formatNumber(row.lineCount)} dòng
                    </span>
                  </div>
                ),
              },
              { title: "Nhà cung cấp", dataIndex: "supplier", render: (supplier: ReturnListItem["supplier"]) => supplier.name },
              {
                title: "Lý do",
                dataIndex: "reason",
                render: (reason: string, row: ReturnListItem) => (
                  <div className="cell-main">
                    <span className="cell-title">{reason}</span>
                    <span className="cell-sub">{settlementLabel(row.settlement)}</span>
                  </div>
                ),
              },
              { title: "Giá trị", dataIndex: "totalValue", width: 130, align: "right", render: (value: number) => <b>{formatVnd(value)}</b> },
              { title: "Trạng thái", dataIndex: "status", width: 120, render: (status: Status) => statusTag(status) },
            ]}
            locale={{ emptyText: <Empty description="Chưa có phiếu trả hàng nào" /> }}
          />
        )}
      </Card>

      <Modal
        title="Lập phiếu trả hàng nhà cung cấp"
        open={creating}
        onCancel={() => setCreating(false)}
        width={900}
        okText={pickedTotal > 0 ? `Lập phiếu nháp · ${formatVnd(pickedTotal)}` : "Lập phiếu nháp"}
        cancelText="Hủy"
        okButtonProps={{ disabled: Object.keys(picked).length === 0 }}
        confirmLoading={create.isPending}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" initialValues={{ settlement: "DEDUCT_DEBT" }} onFinish={(values) => create.mutate(values)}>
          <div className="count-toolbar">
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="Chọn nhà cung cấp"
              style={{ minWidth: 280 }}
              loading={suppliers.isLoading}
              value={supplierId}
              onChange={(value) => {
                setSupplierId(value);
                setPicked({});
              }}
              options={(suppliers.data ?? []).map((item) => ({ value: item.id, label: item.name }))}
            />
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="Tìm tên thuốc, mã hoặc số lô"
              className="count-search"
              disabled={!supplierId}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          {!supplierId ? (
            <Alert type="info" showIcon className="count-banner" title="Chọn nhà cung cấp trước" description="Danh sách chỉ hiện những lô đã nhập từ nhà cung cấp đó, để trả đúng nơi đã mua." />
          ) : (
            <Table
              rowKey="batchId"
              size="small"
              className="count-banner"
              loading={returnable.isFetching}
              dataSource={returnable.data ?? []}
              pagination={(returnable.data?.length ?? 0) > 8 ? { pageSize: 8, size: "small" } : false}
              scroll={{ x: 640 }}
              columns={[
                {
                  title: "Sản phẩm / lô",
                  dataIndex: "productName",
                  render: (_: string, row: Returnable) => (
                    <div className="cell-main">
                      <span className="cell-title">{row.productName}</span>
                      <span className="cell-sub">
                        {row.productCode} · Lô {row.batchNumber} · HSD {formatDate(row.expiryDate)}
                        {row.goodsReceipt ? ` · ${row.goodsReceipt.code}` : ""}
                      </span>
                    </div>
                  ),
                },
                {
                  title: "Tồn",
                  dataIndex: "quantityOnHand",
                  width: 110,
                  align: "right",
                  render: (value: number, row: Returnable) => (
                    <div className="cell-main" style={{ alignItems: "flex-end" }}>
                      <span className="cell-title">{formatNumber(value)}</span>
                      <span className="cell-sub">{row.unitCost === null ? "Chưa có giá vốn" : `${formatVnd(row.unitCost)}/đv`}</span>
                    </div>
                  ),
                },
                {
                  title: "Trả lại",
                  dataIndex: "batchId",
                  width: 260,
                  render: (batchId: string, row: Returnable) => {
                    const current = picked[batchId];
                    const unitId = current?.unitId ?? defaultUnit(row).id;
                    const conversion = row.units.find((unit) => unit.id === unitId)?.conversionToBase ?? 1;
                    const maxQuantity = Math.floor(row.quantityOnHand / conversion);
                    return (
                      <div className="count-entry">
                        <InputNumber
                          min={0}
                          max={maxQuantity}
                          className="count-input"
                          disabled={maxQuantity === 0}
                          value={current?.quantity ?? 0}
                          onChange={(value) =>
                            setPicked((state) => {
                              const next = { ...state };
                              const quantity = Math.min(Number(value ?? 0), maxQuantity);
                              if (quantity > 0) next[batchId] = { unitId, quantity };
                              else delete next[batchId];
                              return next;
                            })
                          }
                        />
                        <Select
                          className="count-unit"
                          value={unitId}
                          options={row.units.map((unit) => ({
                            value: unit.id,
                            label: unit.name,
                            // Đơn vị lớn hơn tồn hiện có thì không chọn được.
                            disabled: unit.conversionToBase > row.quantityOnHand,
                          }))}
                          onChange={(value) =>
                            setPicked((state) => {
                              const nextConversion = row.units.find((unit) => unit.id === value)?.conversionToBase ?? 1;
                              const limit = Math.floor(row.quantityOnHand / nextConversion);
                              const quantity = Math.min(state[batchId]?.quantity ?? 0, limit);
                              const next = { ...state };
                              if (quantity > 0) next[batchId] = { unitId: value, quantity };
                              else delete next[batchId];
                              return next;
                            })
                          }
                        />
                        <span className="cell-sub">tối đa {formatNumber(maxQuantity)}</span>
                      </div>
                    );
                  },
                },
              ]}
              locale={{ emptyText: <Empty description="Nhà cung cấp này không còn lô nào trong kho" /> }}
            />
          )}

          <Form.Item name="reason" label="Lý do trả hàng" rules={[{ required: true, message: "Phải ghi lý do trả hàng" }]}>
            <Input placeholder="Ví dụ: hàng cận hạn, nhà cung cấp đồng ý nhận lại" maxLength={500} />
          </Form.Item>
          <Form.Item name="settlement" label="Cách tất toán" rules={[{ required: true }]}>
            <Radio.Group>
              {SETTLEMENTS.map((item) => (
                <Radio key={item.value} value={item.value} style={{ display: "block", marginBottom: 6 }}>
                  {item.label} <span className="cell-sub">— {item.hint}</span>
                </Radio>
              ))}
            </Radio.Group>
          </Form.Item>
          <Form.Item name="note" label="Ghi chú">
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={detail.data ? `Phiếu trả ${detail.data.code}` : "Phiếu trả hàng"}
        open={Boolean(openId)}
        onCancel={() => setOpenId(null)}
        width={860}
        destroyOnHidden
        footer={
          detail.data?.status === "DRAFT" ? (
            <div className="expiry-actions" style={{ justifyContent: "flex-end" }}>
              {canCreate ? (
                <Button danger icon={<StopOutlined />} onClick={() => setCancelling(detail.data!)}>
                  Hủy phiếu
                </Button>
              ) : null}
              <Button onClick={() => setOpenId(null)}>Đóng</Button>
              {canConfirm ? (
                <Button type="primary" icon={<CheckCircleOutlined />} loading={confirm.isPending} onClick={() => confirm.mutate(detail.data!.id)}>
                  Xác nhận trả hàng
                </Button>
              ) : null}
            </div>
          ) : (
            <Button onClick={() => setOpenId(null)}>Đóng</Button>
          )
        }
      >
        {detail.isLoading ? <Skeleton active /> : null}
        {detail.data ? (
          <>
            <Alert
              className="count-banner"
              type={detail.data.status === "CONFIRMED" ? "success" : detail.data.status === "CANCELLED" ? "warning" : "info"}
              showIcon
              title={
                <span>
                  {statusTag(detail.data.status)} {detail.data.supplier.name} · {settlementLabel(detail.data.settlement)}
                </span>
              }
              description={
                <span>
                  {detail.data.reason}
                  {detail.data.note ? ` · ${detail.data.note}` : ""}
                  <br />
                  Lập bởi {detail.data.createdByName} lúc {formatDateTime(detail.data.returnedAt)}
                  {detail.data.confirmedByName ? ` · xác nhận bởi ${detail.data.confirmedByName}` : ""}
                  {detail.data.cancelReason ? ` · hủy: ${detail.data.cancelReason}` : ""}
                  {detail.data.status === "DRAFT" ? " · tồn kho chưa bị trừ, chỉ trừ khi xác nhận" : ""}
                </span>
              }
            />
            <Table
              rowKey="id"
              size="small"
              dataSource={detail.data.lines}
              pagination={false}
              scroll={{ x: 640 }}
              columns={[
                {
                  title: "Sản phẩm / lô",
                  dataIndex: "productName",
                  render: (_: string, row: ReturnDetail["lines"][number]) => (
                    <div className="cell-main">
                      <span className="cell-title">{row.productName}</span>
                      <span className="cell-sub">
                        {row.productCode} · Lô {row.batchNumber} · HSD {formatDate(row.expiryDate)}
                        {row.goodsReceipt ? ` · từ ${row.goodsReceipt.code}` : ""}
                      </span>
                    </div>
                  ),
                },
                {
                  title: "Số lượng",
                  dataIndex: "quantity",
                  width: 140,
                  align: "right",
                  render: (value: number, row: ReturnDetail["lines"][number]) => `${formatNumber(value)} ${row.unitName}`,
                },
                { title: "Giá vốn", dataIndex: "unitCost", width: 120, align: "right", render: (value: number) => formatVnd(value) },
                { title: "Thành tiền", dataIndex: "lineValue", width: 130, align: "right", render: (value: number) => <b>{formatVnd(value)}</b> },
              ]}
              summary={() => (
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={3}>
                    <b>Tổng giá trị trả lại</b>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={3} align="right">
                    <b>{formatVnd(detail.data!.totalValue)}</b>
                  </Table.Summary.Cell>
                </Table.Summary.Row>
              )}
            />
          </>
        ) : null}
      </Modal>

      <Modal
        title={cancelling ? `Hủy phiếu ${cancelling.code}?` : ""}
        open={Boolean(cancelling)}
        onCancel={() => setCancelling(null)}
        okText="Hủy phiếu"
        okButtonProps={{ danger: true }}
        cancelText="Quay lại"
        confirmLoading={cancel.isPending}
        onOk={() => cancelForm.submit()}
        destroyOnHidden
      >
        <Form form={cancelForm} layout="vertical" onFinish={(values) => cancel.mutate(values)}>
          <p>Phiếu còn nháp nên chưa trừ tồn kho. Hủy xong phiếu vẫn nằm trong danh sách để tra lại.</p>
          <Form.Item name="reason" label="Lý do hủy" rules={[{ required: true, message: "Phải ghi lý do hủy phiếu" }]}>
            <Input.TextArea rows={2} maxLength={500} placeholder="Ví dụ: chọn nhầm lô" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
