import { BarChartOutlined, DownloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, Card, Col, DatePicker, Empty, Progress, Row, Skeleton, Space, Table, Tabs, Tag, Typography, Button } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useState } from "react";
import { http } from "../../api/http.js";
import { formatVnd, type Envelope, type ReportsSummary } from "../../api/types.js";

const money = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("vi-VN");
const dateText = (value: string) => new Date(value).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
const PAYMENT_LABEL: Record<string, string> = { CASH: "Tiền mặt", TRANSFER: "Chuyển khoản" };
const DONUT_COLORS = ["#1677ff", "#08c299", "#ffab2e", "#7c4bf2", "#f5455c", "#0ea5e9"];

function changeText(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Chưa có kỳ trước để so sánh";
  return `${value >= 0 ? "↑" : "↓"} ${Math.abs(value)}% so với kỳ trước`;
}

/** Xuất CSV từ dữ liệu đã tải, không phải tính năng máy chủ — dùng thẳng dữ liệu đang hiển thị. */
function downloadCsv(filename: string, rows: Array<Record<string, string | number>>): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]!);
  const csv = [headers.join(","), ...rows.map((row) => headers.map((key) => JSON.stringify(row[key] ?? "")).join(","))].join("\n");
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Báo cáo kinh doanh theo khoảng ngày tùy chọn: doanh thu, lợi nhuận, hàng hóa, nhân viên. */
export function ReportsPage() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(13, "day"), dayjs()]);

  const report = useQuery({
    queryKey: ["reports-summary", range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD")],
    queryFn: async () =>
      (
        await http.get<Envelope<ReportsSummary>>("/reports/summary", {
          params: { from: range[0].format("YYYY-MM-DD"), to: range[1].add(1, "day").format("YYYY-MM-DD") },
        })
      ).data.data,
  });
  const data = report.data;

  return (
    <div className="reports-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}><BarChartOutlined /> Báo cáo kinh doanh</Typography.Title>
          <Typography.Text>Theo dõi doanh thu, lợi nhuận và hiệu quả hoạt động kinh doanh của nhà thuốc.</Typography.Text>
        </div>
        <Space>
          <DatePicker.RangePicker
            value={range}
            format="DD/MM/YYYY"
            allowClear={false}
            onChange={(value) => {
              if (value?.[0] && value[1]) setRange([value[0], value[1]]);
            }}
          />
          <Button
            icon={<DownloadOutlined />}
            disabled={!data}
            onClick={() =>
              data &&
              downloadCsv(`bao-cao-${data.from}_${data.to}.csv`, [
                { muc: "Doanh thu thuần", gia_tri: data.kpis.netRevenue },
                { muc: "Lợi nhuận gộp", gia_tri: data.kpis.grossProfit },
                { muc: "Số hóa đơn", gia_tri: data.kpis.invoiceCount },
                ...data.topProducts.map((item) => ({ muc: `Sản phẩm: ${item.productName}`, gia_tri: item.revenue })),
              ])
            }
          >
            Xuất báo cáo
          </Button>
        </Space>
      </div>

      {report.isLoading ? <Skeleton active paragraph={{ rows: 10 }} /> : null}
      {report.isError ? <Alert type="error" showIcon message="Không tải được báo cáo" description="Hãy kiểm tra kết nối hoặc quyền truy cập của tài khoản." /> : null}

      {data ? (
        <>
          <Row gutter={[16, 16]} className="dashboard-stat-row">
            <MetricCard title="Doanh thu thuần" value={money.format(data.kpis.netRevenue)} change={data.kpis.netRevenueChangePercent} color="#08af8a" />
            <MetricCard title="Lợi nhuận gộp" value={money.format(data.kpis.grossProfit)} change={data.kpis.grossProfitChangePercent} color="#147cf5" />
            <MetricCard title="Số hóa đơn" value={number.format(data.kpis.invoiceCount)} change={data.kpis.invoiceCountChangePercent} color="#7c4bf2" />
            <MetricCard title="Giá trị đơn hàng trung bình" value={money.format(data.kpis.averageOrderValue)} change={data.kpis.averageOrderValueChangePercent} color="#ff9f1a" />
          </Row>

          <Tabs
            items={[
              { key: "revenue", label: "Doanh thu", children: <RevenueTab data={data} /> },
              { key: "profit", label: "Lợi nhuận", children: <ProfitTab data={data} /> },
              { key: "goods", label: "Hàng hóa", children: <GoodsTab data={data} /> },
              { key: "staff", label: "Nhân viên", children: <StaffTab data={data} /> },
            ]}
          />
        </>
      ) : null}
    </div>
  );
}

function MetricCard({ title, value, change, color }: { title: string; value: string; change: number | null; color: string }) {
  return (
    <Col xs={24} sm={12} xl={6}>
      <Card className="dashboard-metric" style={{ borderTop: `3px solid ${color}` }}>
        <Typography.Text strong>{title}</Typography.Text>
        <Typography.Title level={3} style={{ margin: "4px 0 2px", color: "#0d3474" }}>{value}</Typography.Title>
        <Typography.Text className={change !== null && change < 0 ? "metric-change negative" : "metric-change"}>{changeText(change)}</Typography.Text>
      </Card>
    </Col>
  );
}

function RevenueTrendChart({ points, field }: { points: ReportsSummary["trend"]; field: "revenue" | "profit" }) {
  const maximum = Math.max(...points.map((item) => Math.abs(item[field])), 1);
  if (points.every((item) => item[field] === 0)) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có dữ liệu trong khoảng thời gian này" />;
  return (
    <div className="revenue-chart" aria-label="Biểu đồ theo ngày">
      {points.map((point) => (
        <div className="revenue-bar-item" key={point.date}>
          <div className="revenue-bar-wrap">
            <div className="revenue-bar" style={{ height: `${Math.max((Math.abs(point[field]) / maximum) * 100, point[field] !== 0 ? 5 : 0)}%` }} />
          </div>
          <span>{dateText(point.date)}</span>
        </div>
      ))}
    </div>
  );
}

function CategoryBars({ items }: { items: ReportsSummary["categoryBreakdown"] }) {
  if (items.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có dữ liệu" />;
  const maximum = Math.max(...items.map((item) => item.revenue), 1);
  return (
    <Space direction="vertical" style={{ width: "100%" }} size={10}>
      {items.map((item) => (
        <div key={item.categoryName}>
          <div className="category-stock-title">
            <span>{item.categoryName}</span>
            <strong>{formatVnd(item.revenue)} ({item.percent}%)</strong>
          </div>
          <Progress percent={Math.round((item.revenue / maximum) * 100)} showInfo={false} size="small" strokeColor="#0876eb" />
        </div>
      ))}
    </Space>
  );
}

function PaymentDonut({ items }: { items: ReportsSummary["paymentMethods"] }) {
  if (items.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có dữ liệu" />;
  const total = items.reduce((sum, item) => sum + item.amount, 0) || 1;
  const cumulative = items.reduce<number[]>((acc, item) => [...acc, (acc.at(-1) ?? 0) + item.amount], []);
  const stops = items.map((_item, index) => {
    const start = ((cumulative[index - 1] ?? 0) / total) * 360;
    const end = (cumulative[index]! / total) * 360;
    return `${DONUT_COLORS[index % DONUT_COLORS.length]} ${start}deg ${end}deg`;
  });
  return (
    <div className="donut-wrap">
      <div className="donut-chart" style={{ background: `conic-gradient(${stops.join(", ")})` }}>
        <div className="donut-center">
          <span>Tổng doanh thu</span>
          <strong>{formatVnd(total)}</strong>
        </div>
      </div>
      <div className="donut-legend">
        {items.map((item, index) => (
          <div className="donut-legend-item" key={item.method}>
            <span className="donut-dot" style={{ background: DONUT_COLORS[index % DONUT_COLORS.length] }} />
            <span className="donut-legend-label">{PAYMENT_LABEL[item.method] ?? item.method}</span>
            <span className="donut-legend-value">{item.percent}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TopProductsTable({ items, limit }: { items: ReportsSummary["topProducts"]; limit?: number }) {
  return (
    <Table
      rowKey="productId"
      size="small"
      pagination={false}
      dataSource={limit ? items.slice(0, limit) : items}
      locale={{ emptyText: "Chưa có dữ liệu bán hàng" }}
      columns={[
        { title: "STT", width: 50, render: (_, __, index) => index + 1 },
        { title: "Tên thuốc", dataIndex: "productName" },
        { title: "Số lượng", dataIndex: "quantity", width: 90, align: "right", render: (value) => number.format(value) },
        { title: "Doanh thu", width: 130, align: "right", render: (_, row) => <Typography.Text strong>{formatVnd(row.revenue)}</Typography.Text> },
      ]}
    />
  );
}

function RevenueTab({ data }: { data: ReportsSummary }) {
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={15}>
        <Card title="Biểu đồ doanh thu theo ngày" style={{ marginBottom: 16 }}>
          <RevenueTrendChart points={data.trend} field="revenue" />
        </Card>
        <Card title="Top 10 thuốc bán chạy">
          <TopProductsTable items={data.topProducts} />
        </Card>
      </Col>
      <Col xs={24} xl={9}>
        <Card title="Nhóm hàng bán chạy" style={{ marginBottom: 16 }}>
          <CategoryBars items={data.categoryBreakdown} />
        </Card>
        <Card title="Hình thức thanh toán">
          <PaymentDonut items={data.paymentMethods} />
        </Card>
      </Col>
    </Row>
  );
}

function ProfitTab({ data }: { data: ReportsSummary }) {
  const marginPercent = data.kpis.netRevenue > 0 ? Math.round((data.kpis.grossProfit / data.kpis.netRevenue) * 1000) / 10 : null;
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={16}>
        <Card title="Biểu đồ lợi nhuận theo ngày">
          <RevenueTrendChart points={data.trend} field="profit" />
        </Card>
      </Col>
      <Col xs={24} xl={8}>
        <Card title="Biên lợi nhuận gộp">
          {marginPercent === null ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có doanh thu trong kỳ" />
          ) : (
            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
              <Typography.Title level={2} style={{ margin: 0, color: marginPercent >= 0 ? "#08a97f" : "#e85b6d" }}>{marginPercent}%</Typography.Title>
              <Typography.Text type="secondary">Lợi nhuận gộp / Doanh thu thuần trong kỳ đang xem.</Typography.Text>
              <Typography.Text>Giá vốn ước tính: <strong>{formatVnd(data.kpis.netRevenue - data.kpis.grossProfit)}</strong></Typography.Text>
            </Space>
          )}
        </Card>
      </Col>
    </Row>
  );
}

function GoodsTab({ data }: { data: ReportsSummary }) {
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={9}>
        <Card title="Cơ cấu doanh thu theo nhóm hàng">
          <CategoryBars items={data.categoryBreakdown} />
        </Card>
      </Col>
      <Col xs={24} xl={15}>
        <Card title="Toàn bộ top sản phẩm bán chạy trong kỳ">
          <TopProductsTable items={data.topProducts} />
        </Card>
      </Col>
    </Row>
  );
}

function StaffTab({ data }: { data: ReportsSummary }) {
  return (
    <Card title="Doanh thu theo nhân viên bán hàng">
      <Table
        rowKey="userId"
        size="small"
        pagination={false}
        dataSource={data.staffPerformance}
        locale={{ emptyText: "Chưa có dữ liệu bán hàng" }}
        columns={[
          { title: "STT", width: 50, render: (_, __, index) => index + 1 },
          { title: "Nhân viên", dataIndex: "fullName" },
          { title: "Số hóa đơn", dataIndex: "invoiceCount", width: 110, align: "right", render: (value) => number.format(value) },
          {
            title: "Doanh thu",
            width: 150,
            align: "right",
            render: (_, row, index) => (
              <Space>
                {index === 0 ? <Tag color="gold">Top 1</Tag> : null}
                <Typography.Text strong>{formatVnd(row.revenue)}</Typography.Text>
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}
