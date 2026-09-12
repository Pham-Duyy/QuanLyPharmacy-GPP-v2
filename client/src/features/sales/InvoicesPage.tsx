import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  Descriptions,
  Drawer,
  Input,
  Modal,
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
import { ReturnModal } from "./ReturnModal.js";

export function InvoicesPage() {
  const { can } = useAuth();
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
    <Card title="Hóa đơn">
      <Table
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
        pagination={{
          current: page,
          pageSize: list.data?.pagination.limit ?? 20,
          total: list.data?.pagination.total ?? 0,
          onChange: setPage,
          showSizeChanger: false,
        }}
        columns={[
          { title: "Số hóa đơn", dataIndex: "code", width: 200 },
          {
            title: "Thời điểm",
            width: 170,
            render: (_, row: InvoiceListItem) =>
              new Date(row.soldAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
          },
          { title: "Khách", render: (_, row: InvoiceListItem) => row.customerName ?? "Khách lẻ" },
          { title: "Người bán", dataIndex: "sellerName", width: 160 },
          { title: "Số dòng", dataIndex: "lineCount", width: 80, align: "right" },
          {
            title: "Tổng tiền",
            width: 130,
            align: "right",
            render: (_, row: InvoiceListItem) => (
              <Typography.Text strong>{formatVnd(row.totalAmount)}</Typography.Text>
            ),
          },
          {
            title: "Trạng thái",
            width: 110,
            render: (_, row: InvoiceListItem) =>
              row.status === "VOIDED" ? (
                <Tag color="red">Đã hủy</Tag>
              ) : (
                <Tag color="green">Hoàn tất</Tag>
              ),
          },
        ]}
      />

      <Drawer
        width={640}
        open={openId !== null}
        onClose={() => setOpenId(null)}
        title={detail.data?.code ?? "Chi tiết hóa đơn"}
        extra={
          detail.data?.status === "COMPLETED" ? (
            <Space>
              {can("return.create") && detail.data.returnStatus !== "FULL" ? (
                <Button onClick={() => setReturning(true)}>Nhận trả hàng</Button>
              ) : null}
              {can("invoice.void") && detail.data.returnStatus === "NONE" ? (
                <Button danger onClick={() => setVoiding(true)}>
                  Hủy hóa đơn
                </Button>
              ) : null}
            </Space>
          ) : null
        }
      >
        {detail.data ? (
          <Space direction="vertical" style={{ width: "100%" }} size="middle">
            <Descriptions
              size="small"
              column={1}
              items={[
                { key: "s", label: "Trạng thái", children: detail.data.status },
                { key: "b", label: "Người bán", children: detail.data.seller.fullName },
                {
                  key: "k",
                  label: "Khách",
                  children: detail.data.customer?.fullName ?? "Khách lẻ",
                },
                { key: "t", label: "Tạm tính", children: formatVnd(detail.data.subtotal) },
                { key: "g", label: "Giảm giá", children: formatVnd(detail.data.discountAmount) },
                { key: "v", label: "Trong đó VAT", children: formatVnd(detail.data.vatAmount) },
                { key: "c", label: "Tổng tiền", children: formatVnd(detail.data.totalAmount) },
                ...(detail.data.voidReason
                  ? [{ key: "r", label: "Lý do hủy", children: detail.data.voidReason }]
                  : []),
              ]}
            />

            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={detail.data.lines}
              columns={[
                { title: "Sản phẩm", dataIndex: "productName" },
                { title: "ĐVT", dataIndex: "unitName", width: 80 },
                { title: "SL", dataIndex: "quantity", width: 60, align: "right" },
                {
                  title: "Đơn giá",
                  width: 110,
                  align: "right",
                  render: (_, line) => formatVnd(line.unitPrice),
                },
                {
                  title: "Thành tiền",
                  width: 120,
                  align: "right",
                  render: (_, line) => formatVnd(line.lineTotal),
                },
              ]}
              expandable={{
                expandedRowRender: (line) => (
                  <Space direction="vertical" size={0}>
                    {line.allocations.map((allocation) => (
                      <Typography.Text key={allocation.id}>
                        Lô {allocation.batchNumber} · hạn{" "}
                        {new Date(allocation.expiryDate).toLocaleDateString("vi-VN")} ·{" "}
                        {allocation.baseQuantity} đơn vị nhỏ nhất
                      </Typography.Text>
                    ))}
                  </Space>
                ),
              }}
            />
          </Space>
        ) : null}
      </Drawer>

      {detail.data ? (
        <ReturnModal
          invoice={detail.data}
          open={returning}
          onClose={() => setReturning(false)}
        />
      ) : null}

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
    </Card>
  );
}
