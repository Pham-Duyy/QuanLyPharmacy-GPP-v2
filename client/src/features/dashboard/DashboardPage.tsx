import {
  AuditOutlined,
  BellOutlined,
  DollarCircleOutlined,
  FileTextOutlined,
  PhoneOutlined,
  ReloadOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, Col, Empty, Progress, Result, Row, Segmented, Skeleton, Table, Tag, Typography } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router";
import { http } from "../../api/http.js";
import type { DashboardData, Envelope } from "../../api/types.js";
import { chartColors, chartOtherColor } from "../../app/theme.js";
import { BarTrend, Donut } from "../../ui/charts.js";
import { StatCard, StatGrid, Trend } from "../../ui/StatCard.js";
import { useAuth } from "../auth/AuthProvider.js";

const money = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("vi-VN");
const dateText = (value: string) => new Date(value).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 11) return "Chào buổi sáng";
  if (hour < 14) return "Chào buổi trưa";
  if (hour < 18) return "Chào buổi chiều";
  return "Chào buổi tối";
}

/** Tổng quan chỉ hiển thị số liệu API trả về, không có số minh họa. */
export function DashboardPage() {
  const { me, storeId } = useAuth();
  const navigate = useNavigate();
  const [days, setDays] = useState<7 | 30>(7);
  const dashboard = useQuery({
    queryKey: ["dashboard", storeId, days],
    queryFn: async () => (await http.get<Envelope<DashboardData>>("/dashboard", { params: { days } })).data.data,
    enabled: Boolean(storeId),
  });
  const data = dashboard.data;
  const store = me?.stores.find((item) => item.id === storeId);

  if (!me) return null;
  if (dashboard.isLoading) {
    return (
      <div className="dashboard-page">
        <Skeleton.Node active style={{ width: "100%", height: 96 }} />
        <StatGrid>
          {[0, 1, 2, 3].map((key) => (
            <Skeleton.Node key={key} active style={{ width: "100%", height: 104 }} />
          ))}
        </StatGrid>
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    );
  }
  if (dashboard.isError || !data) {
    return (
      <Result
        status="warning"
        title="Không tải được dữ liệu tổng quan"
        subTitle="Kiểm tra kết nối mạng hoặc quyền truy cập của tài khoản rồi thử lại."
        extra={
          <Button type="primary" icon={<ReloadOutlined />} onClick={() => void dashboard.refetch()}>
            Thử lại
          </Button>
        }
      />
    );
  }

  const noAccess = <span className="dashboard-no-access">Không có quyền xem</span>;
  const updatedAt = new Date(data.generatedAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="dashboard-page">
      <section className="dashboard-welcome">
        <div>
          <h1>
            {greeting()}, {me.user.fullName}
          </h1>
          <p>
            Tình hình hoạt động tại {store?.name ?? "cửa hàng đang chọn"} · cập nhật lúc {updatedAt}
          </p>
        </div>
        <Segmented
          value={days}
          options={[
            { label: "7 ngày", value: 7 },
            { label: "30 ngày", value: 30 },
          ]}
          onChange={(value) => setDays(value as 7 | 30)}
        />
      </section>

      <StatGrid>
        <StatCard
          tone="green"
          icon={<DollarCircleOutlined />}
          label="Doanh thu hôm nay"
          value={data.permissions.sales ? money.format(data.sales.today.revenue) : noAccess}
          hint={data.permissions.sales ? <Trend value={data.sales.today.revenueChangePercent} suffix="so với hôm qua" /> : null}
        />
        <StatCard
          tone="blue"
          icon={<FileTextOutlined />}
          label="Hóa đơn hôm nay"
          value={data.permissions.sales ? number.format(data.sales.today.invoiceCount) : noAccess}
          hint={data.permissions.sales ? <Trend value={data.sales.today.invoiceChangePercent} suffix="so với hôm qua" /> : null}
        />
        <StatCard
          tone="purple"
          icon={<TeamOutlined />}
          label="Khách mới hôm nay"
          value={data.permissions.sales && data.permissions.customers ? number.format(data.sales.today.newCustomerCount) : noAccess}
          hint={
            data.permissions.sales && data.permissions.customers ? (
              <Trend value={data.sales.today.newCustomerChangePercent} suffix="so với hôm qua" />
            ) : null
          }
        />
        <StatCard
          tone="orange"
          icon={<WarningOutlined />}
          label="Lô sắp hết hạn"
          value={data.permissions.inventory ? number.format(data.inventory.counts.expiring) : noAccess}
          hint={
            data.permissions.inventory
              ? data.inventory.counts.expired > 0
                ? `Trong 90 ngày tới · ${number.format(data.inventory.counts.expired)} lô đã hết hạn`
                : "Trong 90 ngày tới"
              : null
          }
        />
      </StatGrid>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card title={`Doanh thu ${days} ngày gần đây`} className="card-fill" extra={data.permissions.sales ? <Tag color="blue">Hóa đơn hoàn tất</Tag> : null}>
            {data.permissions.sales ? (
              <BarTrend
                emptyText="Chưa có hóa đơn hoàn tất trong khoảng thời gian này"
                points={data.sales.trend.map((point) => ({
                  key: point.date,
                  label: dateText(point.date),
                  value: point.revenue,
                  tooltip: (
                    <div>
                      {dateText(point.date)}
                      <br />
                      Doanh thu: {money.format(point.revenue)}
                      <br />
                      Số đơn: {number.format(point.invoiceCount)}
                    </div>
                  ),
                }))}
              />
            ) : (
              <NoPermission />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card title="Thuốc bán chạy" className="card-fill" extra={data.permissions.sales ? <Tag color="blue">Theo doanh thu</Tag> : null}>
            {data.permissions.sales ? <TopProductsDonut items={data.sales.topProducts} trend={data.sales.trend} /> : <NoPermission />}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card
            title="Lô sắp hết hạn"
            className="card-fill"
            extra={
              <Button type="link" onClick={() => void navigate("/canh-bao")}>
                Xem tất cả <RightOutlined />
              </Button>
            }
          >
            {data.permissions.inventory ? (
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                scroll={{ x: 520 }}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có lô nào hết hạn trong 90 ngày tới" /> }}
                dataSource={data.inventory.expiringBatches}
                columns={[
                  { title: "Tên thuốc", dataIndex: "productName", ellipsis: true, render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
                  { title: "Số lô", dataIndex: "batchNumber", width: 130, render: (value: string) => <span className="mono">{value}</span> },
                  { title: "Hạn dùng", dataIndex: "expiryDate", width: 110, render: (value: string) => new Date(value).toLocaleDateString("vi-VN") },
                  { title: "Tồn", dataIndex: "quantityOnHand", width: 90, align: "right", render: (value: number) => number.format(value) },
                ]}
              />
            ) : (
              <NoPermission />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card
            title="Tồn kho theo nhóm hàng"
            className="card-fill"
            extra={
              <Button type="link" onClick={() => void navigate("/ton-kho")}>
                Chi tiết <RightOutlined />
              </Button>
            }
          >
            {data.permissions.inventory ? <CategoryStock items={data.inventory.categoryStock} /> : <NoPermission />}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card
            title="Mặt hàng dưới mức tồn tối thiểu"
            className="card-fill"
            extra={
              <Button type="link" onClick={() => void navigate("/ton-kho")}>
                Mở tồn kho <RightOutlined />
              </Button>
            }
          >
            {data.permissions.inventory ? <LowStock items={data.inventory.lowStockProducts} /> : <NoPermission />}
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card
            className="card-fill"
            title={
              <span>
                <BellOutlined /> Việc cần chú ý
              </span>
            }
          >
            <Notifications items={data.notifications} navigate={navigate} />
          </Card>
        </Col>
      </Row>

      <div className="dashboard-trust-row">
        <div className="trust-badge">
          <SafetyCertificateOutlined />
          <div>
            <strong>Tuân thủ GPP</strong>
            <span>Quy trình theo Thực hành tốt nhà thuốc</span>
          </div>
        </div>
        <div className="trust-badge">
          <AuditOutlined />
          <div>
            <strong>Kiểm soát truy cập</strong>
            <span>Phân quyền theo vai trò, ghi nhật ký thao tác</span>
          </div>
        </div>
        <div className="trust-badge">
          <PhoneOutlined />
          <div>
            <strong>Hỗ trợ</strong>
            <span>{store?.phone ?? "Liên hệ quản trị viên hệ thống"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** "Khác" = doanh thu cả kỳ trừ các sản phẩm top, không phải số minh họa. */
function TopProductsDonut({ items, trend }: { items: DashboardData["sales"]["topProducts"]; trend: DashboardData["sales"]["trend"] }) {
  const periodRevenue = trend.reduce((sum, point) => sum + point.revenue, 0);
  const topRevenue = items.reduce((sum, item) => sum + item.revenue, 0);
  const otherRevenue = Math.max(0, periodRevenue - topRevenue);
  const slices = [
    ...items.map((item, index) => ({ label: item.productName, value: item.revenue, color: chartColors[index % chartColors.length]! })),
    ...(otherRevenue > 0 ? [{ label: "Khác", value: otherRevenue, color: chartOtherColor }] : []),
  ];
  return <Donut slices={slices} centerLabel="Tổng doanh thu" formatTotal={(total) => money.format(total)} emptyText="Chưa có dữ liệu bán hàng" />;
}

function CategoryStock({ items }: { items: DashboardData["inventory"]["categoryStock"] }) {
  if (items.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có dữ liệu tồn kho" />;
  const maximum = Math.max(...items.map((item) => item.quantity), 1);
  return (
    <div className="category-stock-list">
      {items.map((item) => (
        <div key={item.categoryName}>
          <div className="category-stock-title">
            <span>{item.categoryName}</span>
            <strong>{number.format(item.quantity)}</strong>
          </div>
          <Progress percent={Math.round((item.quantity / maximum) * 100)} showInfo={false} strokeColor="var(--c-accent)" size="small" />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {number.format(item.productCount)} mặt hàng
          </Typography.Text>
        </div>
      ))}
    </div>
  );
}

function LowStock({ items }: { items: DashboardData["inventory"]["lowStockProducts"] }) {
  if (items.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có mặt hàng dưới mức tồn tối thiểu" />;
  return (
    <div className="low-stock-list">
      {items.map((item) => (
        <div className="low-stock-row" key={item.productId}>
          <Typography.Text strong ellipsis>
            {item.productName}
          </Typography.Text>
          <span>
            Còn <b>{number.format(item.stock)}</b> / tối thiểu {number.format(item.minimumStock)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Notifications({ items, navigate }: { items: DashboardData["notifications"]; navigate: (href: string) => void }) {
  if (items.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có việc cần xử lý" />;
  return (
    <div className="notification-list">
      {items.map((item) => (
        <button type="button" className={`notification-item ${item.severity}`} key={item.type} onClick={() => void navigate(item.href)}>
          <span className="notification-dot" />
          <span>{item.title}</span>
        </button>
      ))}
    </div>
  );
}

function NoPermission() {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Vai trò hiện tại không có quyền xem dữ liệu này" />;
}
