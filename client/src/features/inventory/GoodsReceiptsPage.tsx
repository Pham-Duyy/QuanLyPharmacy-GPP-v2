import { useQuery } from "@tanstack/react-query";
import { Card, Table, Tag, Typography } from "antd";
import { useState } from "react";
import { http } from "../../api/http.js";
import { formatVnd, type Envelope, type Money, type Paged } from "../../api/types.js";

type ReceiptListItem = {
  id: string;
  code: string;
  status: "DRAFT" | "CONFIRMED" | "CANCELLED";
  supplierName: string | null;
  receivedAt: string;
  totalCost: Money;
  lineCount: number;
};

const STATUS: Record<string, { text: string; color: string }> = {
  DRAFT: { text: "Nháp", color: "default" },
  CONFIRMED: { text: "Đã kiểm nhập", color: "green" },
  CANCELLED: { text: "Đã hủy", color: "red" },
};

export function GoodsReceiptsPage() {
  const [page, setPage] = useState(1);

  const list = useQuery({
    queryKey: ["goods-receipts", page],
    queryFn: async () => {
      const response = await http.get<Envelope<Paged<ReceiptListItem>>>("/goods-receipts", {
        params: { page, limit: 20 },
      });
      return response.data.data;
    },
  });

  return (
    <Card title="Phiếu nhập kho">
      <Table
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        pagination={{
          current: page,
          pageSize: list.data?.pagination.limit ?? 20,
          total: list.data?.pagination.total ?? 0,
          onChange: setPage,
          showSizeChanger: false,
        }}
        columns={[
          { title: "Số phiếu", dataIndex: "code", width: 200 },
          {
            title: "Ngày nhập",
            width: 140,
            render: (_, row: ReceiptListItem) =>
              new Date(row.receivedAt).toLocaleDateString("vi-VN"),
          },
          {
            title: "Nhà cung cấp",
            render: (_, row: ReceiptListItem) => row.supplierName ?? "—",
          },
          { title: "Số dòng", dataIndex: "lineCount", width: 80, align: "right" },
          {
            title: "Giá trị",
            width: 140,
            align: "right",
            render: (_, row: ReceiptListItem) => (
              <Typography.Text strong>{formatVnd(row.totalCost)}</Typography.Text>
            ),
          },
          {
            title: "Trạng thái",
            width: 140,
            render: (_, row: ReceiptListItem) => {
              const info = STATUS[row.status] ?? { text: row.status, color: "default" };
              return <Tag color={info.color}>{info.text}</Tag>;
            },
          },
        ]}
      />
    </Card>
  );
}
