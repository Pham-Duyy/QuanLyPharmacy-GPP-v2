import { DollarCircleOutlined, FileTextOutlined, PrinterOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  Col,
  Descriptions,
  Dropdown,
  Empty,
  Input,
  Modal,
  Row,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import {
  formatVnd,
  type Envelope,
  type Invoice,
  type InvoiceListItem,
  type Paged,
} from "../../api/types.js";
import { useAuth } from "../auth/AuthProvider.js";
import { printInvoice } from "./print-invoice.js";
import { ReturnModal } from "./ReturnModal.js";

export function InvoicesPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voiding, setVoiding] = useState(false);
  const [returning, setReturning] = useState(false);

  const list = useQuery({
    queryKey: ["invoices", page],
    queryFn: async () => {
      const response = await http.get<Envelope<Paged<InvoiceListItem>>>("/invoices", {
        params: { page, limit: 20 },
      });
      return response.data.data;
    },
  });
  const invoices = list.data?.items ?? [];

  const detail = useQuery({
    queryKey: ["invoice", openId],
    enabled: openId !== null,
    queryFn: async () => {
      const response = await http.get<Envelope<Invoice>>(`/invoices/${openId}`);
      return response.data.data;
    },
  });

  const voidInvoice = useMutation({
    mutationFn: async () => {
      await http.post(
        `/invoices/${openId}/void`,
        { reason: voidReason },
        { headers: { "Idempotency-Key": crypto.randomUUID() } },
      );
    },
    onSuccess: async () => {
      void message.success("Đã hủy hóa đơn và hoàn tồn về đúng lô");
      setVoiding(false);
      setVoidReason("");
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      await queryClient.invalidateQueries({ queryKey: ["invoice", openId] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không hủy được hóa đơn")),
  });

  return (
    <div className="invoices-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}><FileTextOutlined /> Hóa đơn</Typography.Title>
          <Typography.Text>Quản lý, tra cứu và theo dõi toàn bộ hóa đơn bán hàng.</Typography.Text>
        </div>
        <Tag color="blue">{list.data?.pagination.total ?? 0} hóa đơn</Tag>
      </div>
      <Row gutter={[16, 16]} className="invoice-stats">
        <Col xs={24} md={12}>
          <Card>
            <Space>
              <span className="invoice-icon blue"><FileTextOutlined /></span>
              <div>
                <Typography.Text strong>Hóa đơn trên trang</Typography.Text>
                <Typography.Title level={3}>{invoices.length}</Typography.Title>
              </div>
            </Space>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card>
            <Space>
              <span className="invoice-icon green"><DollarCircleOutlined /></span>
              <div>
                <Typography.Text strong>Giá trị trên trang</Typography.Text>
                <Typography.Title level={3}>{formatVnd(invoices.reduce((sum, item) => sum + Number(item.totalAmount), 0))}</Typography.Title>
              </div>
            </Space>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card className="invoice-list-card" title="Danh sách hóa đơn">
            <Table
              rowKey="id"
              size="small"
              loading={list.isLoading}
              dataSource={invoices}
              onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
              rowClassName={(row) => (row.id === openId ? "row-selected" : "")}
              pagination={{
                current: page,
                pageSize: list.data?.pagination.limit ?? 20,
                total: list.data?.pagination.total ?? 0,
                onChange: setPage,
                showSizeChanger: false,
              }}
              columns={[
                { title: "Số hóa đơn", dataIndex: "code", width: 190 },
                {
                  title: "Thời điểm",
                  width: 160,
                  render: (_, row: InvoiceListItem) =>
                    new Date(row.soldAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
                },
                { title: "Khách", render: (_, row: InvoiceListItem) => row.customerName ?? "Khách lẻ" },
                { title: "Người bán", dataIndex: "sellerName", width: 150 },
                {
                  title: "Tổng tiền",
                  width: 120,
                  align: "right",
                  render: (_, row: InvoiceListItem) => (
                    <Typography.Text strong>{formatVnd(row.totalAmount)}</Typography.Text>
                  ),
                },
                {
                  title: "Trạng thái",
                  width: 100,
                  render: (_, row: InvoiceListItem) =>
                    row.status === "VOIDED" ? <Tag color="red">Đã hủy</Tag> : <Tag color="green">Hoàn tất</Tag>,
                },
              ]}
            />
          </Card>
        </Col>

        <Col xs={24} xl={9}>
          <InvoiceDetailPanel
            invoice={detail.data ?? null}
            loading={detail.isFetching}
            onPrint={(format) => void printInvoice(detail.data!.id, format)}
            onReturn={() => setReturning(true)}
            onVoid={() => setVoiding(true)}
          />
        </Col>
      </Row>

      {detail.data ? <ReturnModal invoice={detail.data} open={returning} onClose={() => setReturning(false)} /> : null}

      <Modal
        open={voiding}
        title="Hủy hóa đơn"
        okText="Xác nhận hủy"
        okButtonProps={{ danger: true, disabled: voidReason.trim().length === 0 }}
        confirmLoading={voidInvoice.isPending}
        onOk={() => voidInvoice.mutate()}
        onCancel={() => setVoiding(false)}
      >
        <Typography.Paragraph>
          Tồn sẽ được hoàn về đúng các lô đã xuất và ghi một dòng thẻ kho loại SALE_VOID. Chỉ hủy
          được hóa đơn trong ngày bán và chưa có phiếu trả.
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          placeholder="Lý do hủy (bắt buộc)"
          value={voidReason}
          onChange={(event) => setVoidReason(event.target.value)}
        />
      </Modal>
    </div>
  );
}

function InvoiceDetailPanel({
  invoice,
  loading,
  onPrint,
  onReturn,
  onVoid,
}: {
  invoice: Invoice | null;
  loading: boolean;
  onPrint: (format: "k80" | "a5") => void;
  onReturn: () => void;
  onVoid: () => void;
}) {
  const { can } = useAuth();

  return (
    <Card
      className="invoice-detail-card"
      title={invoice?.code ?? "Chi tiết hóa đơn"}
      loading={loading}
      extra={
        invoice ? (
          <Space>
            <Dropdown
              menu={{
                items: [
                  { key: "k80", label: "Khổ K80 (máy in nhiệt)" },
                  { key: "a5", label: "Khổ A5" },
                ],
                onClick: ({ key }) => onPrint(key as "k80" | "a5"),
              }}
            >
              <Button icon={<PrinterOutlined />}>In</Button>
            </Dropdown>
          </Space>
        ) : null
      }
    >
      {!invoice ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chọn một hóa đơn để xem chi tiết" />
      ) : (
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: "s", label: "Trạng thái", children: invoice.status === "VOIDED" ? <Tag color="red">Đã hủy</Tag> : <Tag color="green">Hoàn tất</Tag> },
              { key: "b", label: "Người bán", children: invoice.seller.fullName },
              { key: "k", label: "Khách", children: invoice.customer?.fullName ?? "Khách lẻ" },
              { key: "pm", label: "Thanh toán", children: invoice.paymentMethod === "CASH" ? "Tiền mặt" : "Chuyển khoản" },
              { key: "t", label: "Tạm tính", children: formatVnd(invoice.subtotal) },
              { key: "g", label: "Giảm giá", children: formatVnd(invoice.discountAmount) },
              { key: "v", label: "Trong đó VAT", children: formatVnd(invoice.vatAmount) },
              { key: "c", label: "Tổng tiền", children: <Typography.Text strong>{formatVnd(invoice.totalAmount)}</Typography.Text> },
              ...(invoice.voidReason ? [{ key: "r", label: "Lý do hủy", children: invoice.voidReason }] : []),
            ]}
          />

          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={invoice.lines}
            columns={[
              { title: "Sản phẩm", dataIndex: "productName" },
              { title: "ĐVT", dataIndex: "unitName", width: 70 },
              { title: "SL", dataIndex: "quantity", width: 50, align: "right" },
              { title: "Thành tiền", width: 100, align: "right", render: (_, line) => formatVnd(line.lineTotal) },
            ]}
            expandable={{
              expandedRowRender: (line) => (
                <Space direction="vertical" size={0}>
                  {line.allocations.map((allocation) => (
                    <Typography.Text key={allocation.id}>
                      Lô {allocation.batchNumber} · hạn {new Date(allocation.expiryDate).toLocaleDateString("vi-VN")} · {allocation.baseQuantity} đơn vị nhỏ nhất
                    </Typography.Text>
                  ))}
                </Space>
              ),
            }}
          />

          {invoice.status === "COMPLETED" ? (
            <Space wrap>
              {can("return.create") && invoice.returnStatus !== "FULL" ? <Button onClick={onReturn}>Nhận trả hàng</Button> : null}
              {can("invoice.void") && invoice.returnStatus === "NONE" ? <Button danger onClick={onVoid}>Hủy hóa đơn</Button> : null}
            </Space>
          ) : null}
        </Space>
      )}
    </Card>
  );
}
