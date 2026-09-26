import { BarChartOutlined, DollarCircleOutlined, DownloadOutlined, FileTextOutlined, ReloadOutlined, RiseOutlined, ShoppingOutlined, TrophyFilled } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Col, DatePicker, Empty, Progress, Result, Row, Skeleton, Table, Tabs, Typography } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useState } from "react";
import { http } from "../../api/http.js";
import { formatVnd, type Envelope, type ReportsSummary } from "../../api/types.js";
import { chartColors } from "../../app/theme.js";
import { BarTrend, Donut } from "../../ui/charts.js";
import { formatNumber } from "../../ui/format.js";
import { paymentMethodLabel } from "../../ui/labels.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { StatCard, StatGrid, Trend } from "../../ui/StatCard.js";

const dateText = (value: string) => new Date(value).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });

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
    placeholderData: (previous) => previous,
  });
  const data = report.data;

  return (
    <div>
      <PageHeader
        icon={<BarChartOutlined />}
        title="Báo cáo kinh doanh"
        description="Doanh thu thuần, lợi nhuận gộp (theo giá vốn từng lô), hàng hóa và nhân viên trong kỳ."
        extra={
          <>
            <DatePicker.RangePicker
              value={range}
              format="DD/MM/YYYY"
              allowClear={false}
              presets={[
                { label: "7 ngày qua", value: [dayjs().subtract(6, "day"), dayjs()] },
                { label: "30 ngày qua", value: [dayjs().subtract(29, "day"), dayjs()] },
                { label: "Tháng này", value: [dayjs().startOf("month"), dayjs()] },
                { label: "Tháng trước", value: [dayjs().subtract(1, "month").startOf("month"), dayjs().subtract(1, "month").endOf("month")] },
              ]}
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
              Xuất CSV
            </Button>
          </>
        }
      />

      {report.isLoading ? <Skeleton active paragraph={{ rows: 10 }} /> : null}
      {report.isError && !data ? (
        <Result
          status="warning"
          title="Không tải được báo cáo"
          subTitle="Kiểm tra kết nối hoặc quyền truy cập của tài khoản."
          extra={
            <Button icon={<ReloadOutlined />} onClick={() => void report.refetch()}>
              Thử lại
            </Button>
          }
        />
      ) : null}

      {data ? (
        <>
          <StatGrid>
            <StatCard tone="green" icon={<DollarCircleOutlined />} label="Doanh thu thuần" value={formatVnd(data.kpis.netRevenue)} hint={<Trend value={data.kpis.netRevenueChangePercent} suffix="so với kỳ trước" />} />
            <StatCard
              tone="blue"
              icon={<RiseOutlined />}
              label="Lợi nhuận gộp"
              value={formatVnd(data.kpis.grossProfit)}
              hint={
                // Kỳ này hoặc kỳ so sánh thiếu giá vốn thì tỷ lệ tăng/giảm
                // không phải số đáng tin, không hiển thị như số chính xác.
                data.costQuality.comparisonExact ? (
                  <Trend value={data.kpis.grossProfitChangePercent} suffix="so với kỳ trước" />
                ) : (
                  <span className="muted">Chưa so sánh được với kỳ trước: giá vốn chưa đủ</span>
                )
              }
            />
            <StatCard tone="purple" icon={<FileTextOutlined />} label="Số hóa đơn" value={formatNumber(data.kpis.invoiceCount)} hint={<Trend value={data.kpis.invoiceCountChangePercent} suffix="so với kỳ trước" />} />
            <StatCard tone="orange" icon={<ShoppingOutlined />} label="Giá trị đơn trung bình" value={formatVnd(data.kpis.averageOrderValue)} hint={<Trend value={data.kpis.averageOrderValueChangePercent} suffix="so với kỳ trước" />} />
          </StatGrid>

          {!data.costQuality.exact ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 14 }}
              title="Lợi nhuận gộp của kỳ này chưa phải số chính xác"
              description={
                <>
                  {`Kỳ này có ${formatNumber(data.costQuality.saleLines)} dòng xuất bán và ${formatNumber(data.costQuality.returnLines)} dòng hàng trả nhập lại kho tham gia tính giá vốn. `}
                  {data.costQuality.estimatedLines > 0
                    ? `${formatNumber(data.costQuality.estimatedLines)} dòng dùng giá vốn ƯỚC TÍNH (dữ liệu có trước khi phần mềm chụp giá vốn lúc bán), lệch về phía nào chưa xác định được. `
                    : ""}
                  {data.costQuality.unknownSaleLines > 0
                    ? `${formatNumber(data.costQuality.unknownSaleLines)} dòng BÁN không có giá vốn nên đang tính là 0, làm lợi nhuận CAO hơn thực tế. `
                    : ""}
                  {data.costQuality.unknownReturnLines > 0
                    ? `${formatNumber(data.costQuality.unknownReturnLines)} dòng HÀNG TRẢ không có giá vốn nên phần hoàn lại bị thiếu, làm lợi nhuận THẤP hơn thực tế. `
                    : ""}
                  Doanh thu và số hóa đơn vẫn chính xác.
                </>
              }
            />
          ) : null}

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

function TrendChart({ points, field }: { points: ReportsSummary["trend"]; field: "revenue" | "profit" }) {
  return (
    <BarTrend
      variant={field}
      emptyText="Chưa có dữ liệu trong khoảng thời gian này"
      points={points.map((point) => ({
        key: point.date,
        label: dateText(point.date),
        value: point[field],
        tooltip: (
          <div>
            {dateText(point.date)}
            <br />
            Doanh thu: {formatVnd(point.revenue)}
            <br />
            Lợi nhuận: {formatVnd(point.profit)}
          </div>
        ),
      }))}
    />
  );
}

function CategoryBars({ items }: { items: ReportsSummary["categoryBreakdown"] }) {
  if (items.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có dữ liệu" />;
  const maximum = Math.max(...items.map((item) => item.revenue), 1);
  return (
    <div className="category-stock-list">
      {items.map((item) => (
        <div key={item.categoryName}>
          <div className="category-stock-title">
            <span>{item.categoryName}</span>
            <strong>
              {formatVnd(item.revenue)} <span className="text-secondary">· {item.percent}%</span>
            </strong>
          </div>
          <Progress percent={Math.round((item.revenue / maximum) * 100)} showInfo={false} size="small" strokeColor="var(--c-primary)" />
        </div>
      ))}
    </div>
  );
}

function PaymentDonut({ items }: { items: ReportsSummary["paymentMethods"] }) {
  return (
    <Donut
      centerLabel="Tổng thu"
      formatTotal={formatVnd}
      slices={items.map((item, index) => ({ label: `${paymentMethodLabel(item.method)} (${formatNumber(item.count)} đơn)`, value: item.amount, color: chartColors[index % chartColors.length]! }))}
    />
  );
}

function TopProductsTable({ items }: { items: ReportsSummary["topProducts"] }) {
  return (
    <Table
      rowKey="productId"
      size="small"
      pagination={false}
      dataSource={items}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có dữ liệu bán hàng" /> }}
      columns={[
        { title: "#", key: "rank", width: 44, render: (_: unknown, __: unknown, index: number) => <span className="rank-badge">{index + 1}</span> },
        { title: "Sản phẩm", dataIndex: "productName", ellipsis: true },
        { title: "Số lượng", dataIndex: "quantity", width: 100, align: "right", render: (value: number) => formatNumber(value) },
        { title: "Doanh thu", key: "revenue", width: 130, align: "right", render: (_: unknown, row: ReportsSummary["topProducts"][number]) => <Typography.Text strong>{formatVnd(row.revenue)}</Typography.Text> },
      ]}
    />
  );
}

function RevenueTab({ data }: { data: ReportsSummary }) {
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={15}>
        <div className="detail-stack">
          <Card title="Doanh thu theo ngày">
            <TrendChart points={data.trend} field="revenue" />
          </Card>
          <Card title="Top 10 sản phẩm bán chạy">
            <TopProductsTable items={data.topProducts} />
          </Card>
        </div>
      </Col>
      <Col xs={24} xl={9}>
        <div className="detail-stack">
          <Card title="Nhóm hàng bán chạy">
            <CategoryBars items={data.categoryBreakdown} />
          </Card>
          <Card title="Hình thức thanh toán">
            <PaymentDonut items={data.paymentMethods} />
          </Card>
        </div>
      </Col>
    </Row>
  );
}

function ProfitTab({ data }: { data: ReportsSummary }) {
  const marginPercent = data.kpis.netRevenue > 0 ? Math.round((data.kpis.grossProfit / data.kpis.netRevenue) * 1000) / 10 : null;
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={16}>
        <Card title="Lợi nhuận gộp theo ngày">
          <TrendChart points={data.trend} field="profit" />
        </Card>
      </Col>
      <Col xs={24} xl={8}>
        <Card title="Biên lợi nhuận gộp">
          {marginPercent === null ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có doanh thu trong kỳ" />
          ) : (
            <div className="detail-stack">
              <Progress type="dashboard" percent={Math.max(0, Math.min(100, marginPercent))} format={() => `${marginPercent}%`} strokeColor={marginPercent >= 0 ? "var(--tone-green)" : "var(--tone-red)"} />
              <dl className="kv-list">
                <div>
                  <dt>Doanh thu thuần</dt>
                  <dd>{formatVnd(data.kpis.netRevenue)}</dd>
                </div>
                <div>
                  <dt>Giá vốn hàng bán</dt>
                  <dd>{formatVnd(data.kpis.netRevenue - data.kpis.grossProfit)}</dd>
                </div>
                <div>
                  <dt>Lợi nhuận gộp</dt>
                  <dd>
                    <strong>{formatVnd(data.kpis.grossProfit)}</strong>
                  </dd>
                </div>
              </dl>
              <p className="section-note">Giá vốn tính theo giá nhập của đúng lô đã xuất; hàng khách trả về kho được hoàn giá vốn, hàng xuất hủy thì không.</p>
            </div>
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
        <Card title="Sản phẩm bán chạy trong kỳ">
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
        pagination={false}
        dataSource={data.staffPerformance}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có dữ liệu bán hàng" /> }}
        columns={[
          { title: "#", key: "rank", width: 50, render: (_: unknown, __: unknown, index: number) => (index === 0 ? <TrophyFilled style={{ color: "#f5a524", fontSize: 18 }} /> : <span className="rank-badge">{index + 1}</span>) },
          { title: "Nhân viên", dataIndex: "fullName" },
          { title: "Số hóa đơn", dataIndex: "invoiceCount", width: 120, align: "right", render: (value: number) => formatNumber(value) },
          { title: "Doanh thu", key: "revenue", width: 150, align: "right", render: (_: unknown, row: ReportsSummary["staffPerformance"][number]) => <Typography.Text strong>{formatVnd(row.revenue)}</Typography.Text> },
        ]}
      />
    </Card>
  );
}
