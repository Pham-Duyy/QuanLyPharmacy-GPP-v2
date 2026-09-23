import { CreditCardOutlined, DollarOutlined, HistoryOutlined, SettingOutlined, StopOutlined, WarningFilled } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Card, Checkbox, DatePicker, Empty, Form, Input, InputNumber, Modal, Radio, Skeleton, Table, Tag, Tooltip } from "antd";
import dayjs from "dayjs";
import { useMemo, useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { formatVnd, type Envelope } from "../../api/types.js";
import { formatDate, formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useAuth } from "../auth/AuthProvider.js";

type ReceiptDebt = {
  goodsReceiptId: string;
  code: string;
  receivedAt: string;
  supplierInvoiceNumber: string | null;
  totalCost: number;
  paidAmount: number;
  outstanding: number;
  dueDate: string | null;
  overdueDays: number;
};

type SupplierDebt = {
  supplierId: string;
  name: string;
  phone: string | null;
  paymentTermDays: number;
  totalCost: number;
  paidAmount: number;
  outstanding: number;
  overdueAmount: number;
  dueSoonAmount: number;
  receipts: ReceiptDebt[];
  oldestDueDate: string | null;
};

type DebtResponse = {
  items: SupplierDebt[];
  summary: { suppliers: number; outstanding: number; overdueAmount: number; dueSoonAmount: number; overdueSuppliers: number };
};

type Payment = {
  id: string;
  code: string;
  paidAt: string;
  supplier: { id: string; name: string };
  amount: number;
  method: "CASH" | "BANK_TRANSFER";
  reference: string | null;
  note: string | null;
  status: "ACTIVE" | "VOIDED";
  voidReason: string | null;
  voidedByName: string | null;
  createdByName: string;
  allocations: Array<{ goodsReceiptId: string; code: string; amount: number }>;
};

export function SupplierDebtsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [paying, setPaying] = useState<SupplierDebt | null>(null);
  const [term, setTerm] = useState<SupplierDebt | null>(null);
  const [termDays, setTermDays] = useState(0);
  const [showPayments, setShowPayments] = useState(false);
  const [voiding, setVoiding] = useState<Payment | null>(null);
  const [voidForm] = Form.useForm();
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [form] = Form.useForm();
  const canPay = can("supplier_payment.manage");

  const debts = useQuery({
    queryKey: ["supplier-debts"],
    queryFn: async () => (await http.get<Envelope<DebtResponse>>("/supplier-debts", { params: { onlyOutstanding: true, dueSoonDays: 7 } })).data.data,
  });

  const payments = useQuery({
    queryKey: ["supplier-payments"],
    enabled: showPayments,
    queryFn: async () => (await http.get<Envelope<Payment[]>>("/supplier-payments")).data.data,
  });

  const createPayment = useMutation({
    mutationFn: async (values: { paidAt: dayjs.Dayjs; method: "CASH" | "BANK_TRANSFER"; reference?: string; note?: string }) =>
      http.post("/supplier-payments", {
        supplierId: paying!.supplierId,
        paidAt: values.paidAt.format("YYYY-MM-DD"),
        method: values.method,
        reference: values.reference || null,
        note: values.note || null,
        allocations: Object.entries(selected)
          .filter(([, amount]) => amount > 0)
          .map(([goodsReceiptId, amount]) => ({ goodsReceiptId, amount })),
      }),
    onSuccess: async () => {
      void message.success("Đã ghi nhận thanh toán");
      setPaying(null);
      setSelected({});
      await queryClient.invalidateQueries({ queryKey: ["supplier-debts"] });
      await queryClient.invalidateQueries({ queryKey: ["supplier-payments"] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không ghi nhận được thanh toán"), 8),
  });

  const saveTerm = useMutation({
    mutationFn: async (days: number) => http.put(`/supplier-debts/${term!.supplierId}/term`, { paymentTermDays: days }),
    onSuccess: async () => {
      void message.success("Đã đổi kỳ hạn thanh toán. Kỳ hạn mới áp dụng cho các phiếu nhập kiểm nhập sau này.");
      setTerm(null);
      await queryClient.invalidateQueries({ queryKey: ["supplier-debts"] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không đổi được kỳ hạn")),
  });

  const voidPayment = useMutation({
    mutationFn: async (input: { id: string; reason: string }) => http.post(`/supplier-payments/${input.id}/void`, { reason: input.reason }),
    onSuccess: async () => {
      setVoiding(null);
      void message.success("Đã hủy phiếu chi, công nợ được tính lại");
      await queryClient.invalidateQueries({ queryKey: ["supplier-debts"] });
      await queryClient.invalidateQueries({ queryKey: ["supplier-payments"] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không hủy được phiếu chi")),
  });


  const chosenTotal = useMemo(() => Object.values(selected).reduce((sum, amount) => sum + amount, 0), [selected]);
  const summary = debts.data?.summary;

  const columns = [
    {
      title: "Nhà cung cấp",
      dataIndex: "name",
      render: (name: string, row: SupplierDebt) => (
        <div className="cell-main">
          <span className="cell-title">{name}</span>
          <span className="cell-sub">
            {row.phone ? `${row.phone} · ` : ""}Kỳ hạn {formatNumber(row.paymentTermDays)} ngày · {formatNumber(row.receipts.length)} phiếu còn nợ
          </span>
        </div>
      ),
    },
    {
      title: "Còn nợ",
      dataIndex: "outstanding",
      width: 150,
      align: "right" as const,
      render: (value: number) => <b>{formatVnd(value)}</b>,
    },
    {
      title: "Quá hạn",
      dataIndex: "overdueAmount",
      width: 170,
      align: "right" as const,
      render: (value: number, row: SupplierDebt) =>
        value > 0 ? (
          <div className="cell-main" style={{ alignItems: "flex-end" }}>
            <span className="count-diff-minus">{formatVnd(value)}</span>
            <span className="cell-sub">Hạn sớm nhất {row.oldestDueDate ? formatDate(row.oldestDueDate) : "—"}</span>
          </div>
        ) : (
          <span className="cell-sub">—</span>
        ),
    },
    {
      title: "Sắp đến hạn (7 ngày)",
      dataIndex: "dueSoonAmount",
      width: 170,
      align: "right" as const,
      render: (value: number) => (value > 0 ? formatVnd(value) : <span className="cell-sub">—</span>),
    },
    {
      title: "",
      dataIndex: "supplierId",
      width: 190,
      render: (_: string, row: SupplierDebt) =>
        canPay ? (
          <div className="expiry-actions">
            <Button
              size="small"
              type="primary"
              icon={<DollarOutlined />}
              onClick={() => {
                setPaying(row);
                setSelected({});
                form.setFieldsValue({ paidAt: dayjs(), method: "BANK_TRANSFER", reference: "", note: "" });
              }}
            >
              Trả tiền
            </Button>
            <Tooltip title="Đổi kỳ hạn thanh toán">
              <Button
                size="small"
                icon={<SettingOutlined />}
                onClick={() => {
                  setTerm(row);
                  setTermDays(row.paymentTermDays);
                }}
              />
            </Tooltip>
          </div>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        icon={<CreditCardOutlined />}
        title="Công nợ nhà cung cấp"
        description="Tiền còn nợ theo từng nhà cung cấp và từng phiếu nhập đã kiểm nhập, kèm hạn thanh toán."
        extra={
          <Button icon={<HistoryOutlined />} onClick={() => setShowPayments(true)}>
            Lịch sử thanh toán
          </Button>
        }
      />

      {debts.isError ? <Alert type="error" showIcon title="Không đọc được công nợ" description={getErrorMessage(debts.error)} /> : null}

      {summary ? (
        <>
          {summary.overdueAmount > 0 ? (
            <Alert
              className="count-banner"
              type="warning"
              showIcon
              icon={<WarningFilled />}
              title={`Quá hạn ${formatVnd(summary.overdueAmount)} ở ${formatNumber(summary.overdueSuppliers)} nhà cung cấp`}
              description="Trả chậm dễ mất chiết khấu và bị siết hạn mức công nợ cho lần nhập sau."
            />
          ) : null}
          <div className="count-stats">
            <div className="count-stat">
              <span>Tổng còn nợ</span>
              <b>{formatVnd(summary.outstanding)}</b>
            </div>
            <div className={`count-stat ${summary.overdueAmount > 0 ? "bad" : ""}`}>
              <span>Quá hạn</span>
              <b>{formatVnd(summary.overdueAmount)}</b>
            </div>
            <div className="count-stat">
              <span>Đến hạn trong 7 ngày</span>
              <b>{formatVnd(summary.dueSoonAmount)}</b>
            </div>
            <div className="count-stat">
              <span>Nhà cung cấp đang nợ</span>
              <b>{formatNumber(summary.suppliers)}</b>
            </div>
          </div>
        </>
      ) : null}

      <Card>
        {debts.isLoading ? (
          <Skeleton active />
        ) : (
          <Table
            rowKey="supplierId"
            size="small"
            dataSource={debts.data?.items ?? []}
            columns={columns}
            scroll={{ x: 900 }}
            pagination={false}
            expandable={{
              expandedRowRender: (row) => (
                <Table
                  rowKey="goodsReceiptId"
                  size="small"
                  dataSource={row.receipts}
                  pagination={false}
                  columns={[
                    { title: "Phiếu nhập", dataIndex: "code", render: (code: string, item: ReceiptDebt) => <span>{code}{item.supplierInvoiceNumber ? ` · HĐ ${item.supplierInvoiceNumber}` : ""}</span> },
                    { title: "Ngày nhận", dataIndex: "receivedAt", width: 120, render: (value: string) => formatDate(value) },
                    {
                      title: "Hạn trả",
                      dataIndex: "dueDate",
                      width: 150,
                      render: (value: string | null, item: ReceiptDebt) =>
                        value ? (
                          <span className={item.overdueDays > 0 ? "count-diff-minus" : undefined}>
                            {formatDate(value)}
                            {item.overdueDays > 0 ? ` · quá ${formatNumber(item.overdueDays)} ngày` : ""}
                          </span>
                        ) : (
                          <span className="cell-sub">—</span>
                        ),
                    },
                    { title: "Giá trị phiếu", dataIndex: "totalCost", width: 130, align: "right", render: (value: number) => formatVnd(value) },
                    { title: "Đã trả", dataIndex: "paidAmount", width: 120, align: "right", render: (value: number) => formatVnd(value) },
                    { title: "Còn nợ", dataIndex: "outstanding", width: 130, align: "right", render: (value: number) => <b>{formatVnd(value)}</b> },
                  ]}
                />
              ),
            }}
            locale={{ emptyText: <Empty description="Không còn nợ nhà cung cấp nào" /> }}
          />
        )}
      </Card>

      <Modal
        title={paying ? `Trả tiền cho ${paying.name}` : ""}
        open={Boolean(paying)}
        onCancel={() => setPaying(null)}
        width={780}
        okText={chosenTotal > 0 ? `Ghi nhận ${formatVnd(chosenTotal)}` : "Ghi nhận thanh toán"}
        cancelText="Hủy"
        okButtonProps={{ disabled: chosenTotal <= 0 }}
        confirmLoading={createPayment.isPending}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        {paying ? (
          <Form form={form} layout="vertical" onFinish={(values) => createPayment.mutate(values)}>
            <Table
              rowKey="goodsReceiptId"
              size="small"
              className="count-banner"
              dataSource={paying.receipts}
              pagination={false}
              columns={[
                {
                  title: "Trả",
                  dataIndex: "goodsReceiptId",
                  width: 56,
                  render: (id: string, row: ReceiptDebt) => (
                    <Checkbox
                      checked={(selected[id] ?? 0) > 0}
                      onChange={(event) =>
                        setSelected((current) => {
                          const next = { ...current };
                          if (event.target.checked) next[id] = row.outstanding;
                          else delete next[id];
                          return next;
                        })
                      }
                    />
                  ),
                },
                {
                  title: "Phiếu nhập",
                  dataIndex: "code",
                  render: (code: string, row: ReceiptDebt) => (
                    <div className="cell-main">
                      <span className="cell-title">{code}</span>
                      <span className={row.overdueDays > 0 ? "count-diff-minus" : "cell-sub"}>
                        {row.dueDate ? `Hạn ${formatDate(row.dueDate)}` : "Không có hạn"}
                        {row.overdueDays > 0 ? ` · quá ${formatNumber(row.overdueDays)} ngày` : ""}
                      </span>
                    </div>
                  ),
                },
                { title: "Còn nợ", dataIndex: "outstanding", width: 130, align: "right", render: (value: number) => formatVnd(value) },
                {
                  title: "Số tiền trả",
                  dataIndex: "goodsReceiptId",
                  width: 170,
                  render: (id: string, row: ReceiptDebt) => (
                    <InputNumber
                      min={0}
                      max={row.outstanding}
                      style={{ width: "100%" }}
                      value={selected[id] ?? 0}
                      formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}
                      parser={(value) => Number((value ?? "").replace(/\./g, ""))}
                      onChange={(value) =>
                        setSelected((current) => {
                          const next = { ...current };
                          const amount = Math.min(Number(value ?? 0), row.outstanding);
                          if (amount > 0) next[id] = amount;
                          else delete next[id];
                          return next;
                        })
                      }
                    />
                  ),
                },
              ]}
            />

            <div className="purchase-settings" style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
              <Form.Item name="paidAt" label="Ngày trả" rules={[{ required: true }]}>
                <DatePicker format="DD/MM/YYYY" />
              </Form.Item>
              <Form.Item name="method" label="Hình thức" rules={[{ required: true }]}>
                <Radio.Group
                  options={[
                    { value: "BANK_TRANSFER", label: "Chuyển khoản" },
                    { value: "CASH", label: "Tiền mặt" },
                  ]}
                  optionType="button"
                />
              </Form.Item>
              <Form.Item name="reference" label="Số chứng từ" style={{ flex: "1 1 200px" }}>
                <Input placeholder="Số ủy nhiệm chi, số phiếu chi…" maxLength={100} />
              </Form.Item>
            </div>
            <Form.Item name="note" label="Ghi chú">
              <Input.TextArea rows={2} maxLength={500} />
            </Form.Item>
          </Form>
        ) : null}
      </Modal>

      <Modal
        title={term ? `Kỳ hạn thanh toán · ${term.name}` : ""}
        open={Boolean(term)}
        onCancel={() => setTerm(null)}
        okText="Lưu kỳ hạn"
        cancelText="Hủy"
        confirmLoading={saveTerm.isPending}
        onOk={() => saveTerm.mutate(termDays)}
        destroyOnHidden
      >
        {term ? (
          <div className="supplier-term">
            <p>Số ngày được nợ tính từ ngày nhận hàng. Để 0 nghĩa là trả ngay khi nhận hàng.</p>
            <InputNumber min={0} max={365} value={termDays} onChange={(value) => setTermDays(Number(value ?? 0))} style={{ width: 160 }} />
            <Alert
              className="count-banner"
              style={{ marginTop: 12 }}
              type="info"
              showIcon
              title="Chỉ áp dụng cho phiếu nhập kiểm nhập sau này"
              description="Các phiếu đã kiểm nhập giữ nguyên hạn trả đã chốt, để công nợ cũ không bị đổi hạn."
            />
          </div>
        ) : null}
      </Modal>

      <Modal
        title={voiding ? `Hủy phiếu chi ${voiding.code}?` : ""}
        open={Boolean(voiding)}
        onCancel={() => setVoiding(null)}
        okText="Hủy phiếu chi"
        okButtonProps={{ danger: true }}
        cancelText="Quay lại"
        confirmLoading={voidPayment.isPending}
        onOk={() => voidForm.submit()}
        destroyOnHidden
      >
        {voiding ? (
          <Form form={voidForm} layout="vertical" onFinish={(values: { reason: string }) => voidPayment.mutate({ id: voiding.id, reason: values.reason })}>
            <p>
              {formatVnd(voiding.amount)} trả cho {voiding.supplier.name}. Hủy phiếu thì khoản nợ tương ứng quay lại. Phiếu vẫn nằm trong lịch sử để đối chiếu sổ sách.
            </p>
            <Form.Item name="reason" label="Lý do hủy" rules={[{ required: true, message: "Phải ghi lý do hủy phiếu chi" }]}>
              <Input.TextArea rows={2} maxLength={500} placeholder="Ví dụ: ghi nhầm nhà cung cấp" />
            </Form.Item>
          </Form>
        ) : null}
      </Modal>

      <Modal title="Lịch sử thanh toán nhà cung cấp" open={showPayments} onCancel={() => setShowPayments(false)} footer={null} width={900} destroyOnHidden>
        {payments.isLoading ? <Skeleton active /> : null}
        {payments.data ? (
          <Table
            rowKey="id"
            size="small"
            dataSource={payments.data}
            scroll={{ x: 760 }}
            pagination={payments.data.length > 15 ? { pageSize: 15, size: "small" } : false}
            columns={[
              {
                title: "Phiếu chi",
                dataIndex: "code",
                render: (code: string, row: Payment) => (
                  <div className="cell-main">
                    <span className="cell-title">{code}</span>
                    <span className="cell-sub">
                      {formatDate(row.paidAt)} · {row.method === "CASH" ? "Tiền mặt" : "Chuyển khoản"}
                      {row.reference ? ` · ${row.reference}` : ""} · {row.createdByName}
                    </span>
                  </div>
                ),
              },
              { title: "Nhà cung cấp", dataIndex: "supplier", render: (supplier: Payment["supplier"]) => supplier.name },
              {
                title: "Phiếu nhập",
                dataIndex: "allocations",
                render: (allocations: Payment["allocations"]) => (
                  <span className="cell-sub">{allocations.map((item) => `${item.code} (${formatVnd(item.amount)})`).join(", ")}</span>
                ),
              },
              { title: "Số tiền", dataIndex: "amount", width: 130, align: "right", render: (value: number) => <b>{formatVnd(value)}</b> },
              {
                title: "",
                dataIndex: "status",
                width: 150,
                render: (status: Payment["status"], row: Payment) =>
                  status === "VOIDED" ? (
                    <Tooltip title={`${row.voidReason ?? ""}${row.voidedByName ? ` (${row.voidedByName})` : ""}`}>
                      <Tag variant="filled">Đã hủy</Tag>
                    </Tooltip>
                  ) : canPay ? (
                    <Button size="small" danger icon={<StopOutlined />} onClick={() => setVoiding(row)}>
                      Hủy phiếu
                    </Button>
                  ) : null,
              },
            ]}
            locale={{ emptyText: <Empty description="Chưa có phiếu chi nào" /> }}
          />
        ) : null}
      </Modal>
    </div>
  );
}
