import { useQuery } from "@tanstack/react-query";
import { Card, Descriptions, Drawer, Space, Table, Tag, Typography } from "antd";
import { useState } from "react";
import { http } from "../../api/http.js";
import {
  formatVnd,
  type Envelope,
  type Paged,
  type ReturnDetail,
  type ReturnListItem,
} from "../../api/types.js";

export function ReturnsPage() {
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["returns", page],
    queryFn: async () => {
      const response = await http.get<Envelope<Paged<ReturnListItem>>>("/returns", {
        params: { page, limit: 20 },
      });
      return response.data.data;
    },
  });

  const detail = useQuery({
    queryKey: ["return", openId],
    enabled: openId !== null,
    queryFn: async () => {
      const response = await http.get<Envelope<ReturnDetail>>(`/returns/${openId}`);
      return response.data.data;
    },
  });

  return (
    <Card title="Phiếu trả hàng">
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
          { title: "Số phiếu", dataIndex: "code", width: 200 },
          { title: "Hóa đơn gốc", dataIndex: "invoiceCode", width: 200 },
          {
            title: "Thời điểm",
            width: 160,
            render: (_, row: ReturnListItem) =>
              new Date(row.createdAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
          },
          { title: "Người nhận", dataIndex: "createdByName" },
          {
            title: "Xử lý",
            width: 150,
            render: (_, row: ReturnListItem) =>
              row.disposition === "RESTOCK" ? (
                <Tag color="green">Nhập lại kho</Tag>
              ) : (
                <Tag color="red">Hủy hàng</Tag>
              ),
          },
          {
            title: "Tiền hoàn",
            width: 130,
            align: "right",
            render: (_, row: ReturnListItem) => (
              <Typography.Text strong>{formatVnd(row.refundAmount)}</Typography.Text>
            ),
          },
        ]}
      />

      <Drawer
        width={600}
        open={openId !== null}
        onClose={() => setOpenId(null)}
        title={detail.data?.code ?? "Chi tiết phiếu trả"}
      >
        {detail.data ? (
          <Space direction="vertical" style={{ width: "100%" }} size="middle">
            <Descriptions
              size="small"
              column={1}
              items={[
                { key: "i", label: "Hóa đơn gốc", children: detail.data.invoice.code },
                {
                  key: "d",
                  label: "Xử lý hàng",
                  children:
                    detail.data.disposition === "RESTOCK" ? "Nhập lại kho" : "Hủy, không bán lại",
                },
                { key: "m", label: "Hoàn tiền", children: formatVnd(detail.data.refundAmount) },
                { key: "n", label: "Người nhận", children: detail.data.createdBy.fullName },
                { key: "r", label: "Lý do", children: detail.data.reason ?? "—" },
              ]}
            />

            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={detail.data.lines}
              columns={[
                { title: "Sản phẩm", dataIndex: "productName" },
                { title: "Lô", dataIndex: "batchNumber", width: 120 },
                {
                  title: "SL",
                  width: 90,
                  align: "right",
                  render: (_, line) => `${line.quantity} ${line.unitName}`,
                },
                {
                  title: "Tiền hoàn",
                  width: 120,
                  align: "right",
                  render: (_, line) => formatVnd(line.refundAmount),
                },
              ]}
            />
          </Space>
        ) : null}
      </Drawer>
    </Card>
  );
}
