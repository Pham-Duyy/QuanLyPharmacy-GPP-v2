import { useQuery } from "@tanstack/react-query";
import { Card, Input, Space, Table, Tag, Typography } from "antd";
import { useState } from "react";
import { http } from "../../api/http.js";
import { formatVnd, type Envelope, type Paged, type ProductListItem } from "../../api/types.js";

const DRUG_CLASS: Record<string, { text: string; color: string }> = {
  OTC: { text: "Không kê đơn", color: "green" },
  RX: { text: "Kê đơn", color: "orange" },
  CONTROLLED: { text: "Kiểm soát đặc biệt", color: "red" },
};

/** Danh mục sản phẩm kèm giá hiện hành và tồn bán được tại cửa hàng đang đứng. */
export function ProductsPage() {
  const [term, setTerm] = useState("");
  const [page, setPage] = useState(1);

  const products = useQuery({
    queryKey: ["products-page", term, page],
    queryFn: async () => {
      const response = await http.get<Envelope<Paged<ProductListItem>>>("/products", {
        params: { search: term || undefined, page, limit: 20 },
      });
      return response.data.data;
    },
  });

  return (
    <Card
      title="Sản phẩm"
      extra={
        <Input.Search
          allowClear
          style={{ width: 340 }}
          placeholder="Tìm theo tên, mã hoặc hoạt chất"
          onSearch={(value) => {
            setTerm(value);
            setPage(1);
          }}
        />
      }
    >
      <Table
        rowKey="id"
        size="small"
        loading={products.isLoading}
        dataSource={products.data?.items ?? []}
        pagination={{
          current: page,
          pageSize: products.data?.pagination.limit ?? 20,
          total: products.data?.pagination.total ?? 0,
          onChange: setPage,
          showSizeChanger: false,
        }}
        columns={[
          { title: "Mã", dataIndex: "code", width: 110 },
          {
            title: "Tên sản phẩm",
            render: (_, item: ProductListItem) => (
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{item.name}</Typography.Text>
                <Typography.Text type="secondary">{item.categoryName}</Typography.Text>
              </Space>
            ),
          },
          {
            title: "Phân loại",
            width: 150,
            render: (_, item: ProductListItem) => {
              const info = item.drugClass ? DRUG_CLASS[item.drugClass] : null;
              return info ? <Tag color={info.color}>{info.text}</Tag> : <Tag>Không phải thuốc</Tag>;
            },
          },
          {
            title: "Đơn vị bán",
            width: 110,
            render: (_, item: ProductListItem) => item.defaultUnit?.name ?? "—",
          },
          {
            title: "Giá bán",
            width: 130,
            align: "right",
            render: (_, item: ProductListItem) => (
              <Space direction="vertical" size={0} style={{ alignItems: "flex-end" }}>
                <span>{formatVnd(item.currentPrice?.salePrice)}</span>
                {item.currentPrice?.isStoreOverride ? (
                  <Tag color="blue">Giá riêng cửa hàng</Tag>
                ) : null}
              </Space>
            ),
          },
          {
            title: "Tồn bán được",
            width: 130,
            align: "right",
            render: (_, item: ProductListItem) => (
              <Space direction="vertical" size={0} style={{ alignItems: "flex-end" }}>
                <Typography.Text strong>{item.stock?.sellable ?? 0}</Typography.Text>
                {item.stock?.quarantined ? (
                  <Typography.Text type="warning">
                    biệt trữ {item.stock.quarantined}
                  </Typography.Text>
                ) : null}
                {item.stock?.expired ? (
                  <Typography.Text type="danger">hết hạn {item.stock.expired}</Typography.Text>
                ) : null}
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}
