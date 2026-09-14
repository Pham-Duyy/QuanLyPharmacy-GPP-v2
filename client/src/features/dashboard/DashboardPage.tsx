import { BellOutlined, DollarCircleOutlined, MedicineBoxOutlined, TeamOutlined, WarningOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Col, Empty, Progress, Row, Segmented, Skeleton, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { http } from "../../api/http.js";
import type { DashboardData, Envelope } from "../../api/types.js";
import { useAuth } from "../auth/AuthProvider.js";

const money = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("vi-VN");
const dateText = (value: string) => new Date(value).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });

/** Dashboard only renders data returned by the API, never placeholder business numbers. */
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
  if (dashboard.isLoading) return <Skeleton active paragraph={{ rows: 14 }} />;
  if (dashboard.isError || !data) return <Alert type="error" showIcon message="Không thể tải Dashboard" description="Hãy kiểm tra kết nối hoặc quyền truy cập của tài khoản." />;

  return <div className="dashboard-page">
    {me.user.mustChangePassword ? <Alert className="dashboard-password-alert" type="warning" showIcon message="Tài khoản đang dùng mật khẩu tạm" description="Hãy đổi mật khẩu trước khi sử dụng hệ thống cho công việc thật." /> : null}
    <section className="dashboard-welcome">
      <div>
        <Typography.Title level={2}>Chào mừng, {me.user.fullName}!</Typography.Title>
        <Typography.Text>Chăm sóc sức khỏe cộng đồng · Theo dõi hoạt động tại {store?.name ?? "cửa hàng đang chọn"}.</Typography.Text>
      </div>
      <Segmented value={days} options={[{ label: "7 ngày", value: 7 }, { label: "30 ngày", value: 30 }]} onChange={(value) => setDays(value as 7 | 30)} />
    </section>
    <Row gutter={[16, 16]} className="dashboard-stat-row">
      <MetricCard icon={<DollarCircleOutlined />} color="#08af8a" title="Doanh thu hôm nay" value={data.permissions.sales ? money.format(data.sales.today.revenue) : null} change={data.sales.today.revenueChangePercent} unavailable={!data.permissions.sales} />
      <MetricCard icon={<MedicineBoxOutlined />} color="#147cf5" title="Số hóa đơn" value={data.permissions.sales ? number.format(data.sales.today.invoiceCount) : null} change={data.sales.today.invoiceChangePercent} unavailable={!data.permissions.sales} />
      <MetricCard icon={<TeamOutlined />} color="#7c4bf2" title="Khách mới hôm nay" value={data.permissions.sales && data.permissions.customers ? number.format(data.sales.today.newCustomerCount) : null} change={data.sales.today.newCustomerChangePercent} unavailable={!data.permissions.sales || !data.permissions.customers} />
      <MetricCard icon={<WarningOutlined />} color="#ff9f1a" title="Lô sắp hết hạn" value={data.permissions.inventory ? number.format(data.inventory.counts.expiring) : null} note={data.permissions.inventory ? "Trong 90 ngày tới" : undefined} unavailable={!data.permissions.inventory} />
    </Row>
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={15}><Card className="dashboard-chart-card" title={`Doanh thu và số đơn ${days} ngày gần đây`} extra={data.permissions.sales ? <Tag color="blue">Dữ liệu thực tế</Tag> : null}>{data.permissions.sales ? <RevenueChart points={data.sales.trend} /> : <NoPermission />}</Card></Col>
      <Col xs={24} xl={9}><Card className="dashboard-top-products" title="Top thuốc bán chạy" extra={data.permissions.sales ? <Tag color="blue">Theo doanh thu</Tag> : null}>{data.permissions.sales ? <TopProducts items={data.sales.topProducts} /> : <NoPermission />}</Card></Col>
    </Row>
    <Row gutter={[16, 16]} className="dashboard-bottom-row">
      <Col xs={24} xl={15}><Card title="Danh sách lô sắp hết hạn" extra={<Button type="link" onClick={() => void navigate("/canh-bao")}>Xem tất cả →</Button>}>{data.permissions.inventory ? <Table size="small" rowKey="id" pagination={false} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có lô sắp hết hạn trong 90 ngày" /> }} dataSource={data.inventory.expiringBatches} columns={[{ title: "Tên thuốc", dataIndex: "productName", render: (value) => <Typography.Text strong>{value}</Typography.Text> }, { title: "Số lô", dataIndex: "batchNumber" }, { title: "HSD", dataIndex: "expiryDate", render: dateText }, { title: "Tồn kho", dataIndex: "quantityOnHand", align: "right", render: (value) => number.format(value) }]} /> : <NoPermission />}</Card></Col>
      <Col xs={24} xl={9}><Card title="Tồn kho theo nhóm hàng" extra={<Button type="link" onClick={() => void navigate("/ton-kho")}>Xem chi tiết →</Button>}>{data.permissions.inventory ? <CategoryStock items={data.inventory.categoryStock} /> : <NoPermission />}</Card></Col>
    </Row>
    <Row gutter={[16, 16]} className="dashboard-bottom-row">
      <Col xs={24} xl={15}><Card title="Mặt hàng tồn thấp" extra={<Button type="link" onClick={() => void navigate("/ton-kho")}>Mở quản lý kho →</Button>}>{data.permissions.inventory ? <LowStock items={data.inventory.lowStockProducts} /> : <NoPermission />}</Card></Col>
      <Col xs={24} xl={9}><Card className="dashboard-notifications" title={<Space><BellOutlined /> Thông báo & nhắc nhở</Space>}><Notifications items={data.notifications} navigate={navigate} /></Card></Col>
    </Row>
  </div>;
}

function MetricCard({ icon, color, title, value, change, note, unavailable }: { icon: ReactNode; color: string; title: string; value: string | null; change?: number | null; note?: string; unavailable: boolean }) {
  const changeText = change === null || change === undefined ? "Chưa có số liệu so sánh" : `${change >= 0 ? "↑" : "↓"} ${Math.abs(change)}% so với hôm qua`;
  return <Col xs={24} sm={12} xl={6}><Card className="dashboard-metric"><Space align="start"><span className="dashboard-metric-icon" style={{ background: color }}>{icon}</span><div><Typography.Text strong>{title}</Typography.Text>{unavailable ? <Typography.Text type="secondary" className="dashboard-no-access">Không có quyền xem</Typography.Text> : <><Statistic value={value ?? "—"} valueStyle={{ fontSize: 24, color: "#0d3474", fontWeight: 750 }} /><Typography.Text className={change !== null && change !== undefined && change < 0 ? "metric-change negative" : "metric-change"}>{note ?? changeText}</Typography.Text></>}</div></Space></Card></Col>;
}

function RevenueChart({ points }: { points: DashboardData["sales"]["trend"] }) {
  const maximum = Math.max(...points.map((item) => item.revenue), 1);
  if (points.every((item) => item.revenue === 0 && item.invoiceCount === 0)) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có hóa đơn hoàn tất trong khoảng thời gian này" />;
  return <div className="revenue-chart" aria-label="Biểu đồ doanh thu và số hóa đơn">{points.map((point) => <Tooltip key={point.date} title={<div>{dateText(point.date)}<br />Doanh thu: {money.format(point.revenue)}<br />Số đơn: {number.format(point.invoiceCount)}</div>}><div className="revenue-bar-item"><div className="revenue-bar-wrap"><div className="revenue-bar" style={{ height: `${Math.max((point.revenue / maximum) * 100, point.revenue > 0 ? 5 : 0)}%` }} /></div><span>{dateText(point.date)}</span></div></Tooltip>)}</div>;
}

function TopProducts({ items }: { items: DashboardData["sales"]["topProducts"] }) {
  const maximum = Math.max(...items.map((item) => item.revenue), 1);
  if (items.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có dữ liệu bán hàng" />;
  return <div className="rank-list">{items.map((item, index) => <div className="rank-row" key={item.productId}><span className="rank-number">{index + 1}</span><div className="rank-name"><Typography.Text strong ellipsis>{item.productName}</Typography.Text><Progress percent={Math.round((item.revenue / maximum) * 100)} showInfo={false} strokeColor="#147cf5" size="small" /></div><div className="rank-value">{money.format(item.revenue)}<small>{number.format(item.quantity)} đơn vị</small></div></div>)}</div>;
}

function CategoryStock({ items }: { items: DashboardData["inventory"]["categoryStock"] }) {
  const maximum = Math.max(...items.map((item) => item.quantity), 1);
  if (items.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có dữ liệu tồn kho" />;
  return <div className="category-stock-list">{items.map((item) => <div key={item.categoryName}><div className="category-stock-title"><span>{item.categoryName}</span><strong>{number.format(item.quantity)}</strong></div><Progress percent={Math.round((item.quantity / maximum) * 100)} showInfo={false} strokeColor="#08af8a" size="small" /><Typography.Text type="secondary">{number.format(item.productCount)} mặt hàng</Typography.Text></div>)}</div>;
}

function LowStock({ items }: { items: DashboardData["inventory"]["lowStockProducts"] }) {
  if (items.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có mặt hàng dưới mức tồn tối thiểu" />;
  return <div className="low-stock-list">{items.map((item) => <div className="low-stock-row" key={item.productId}><Typography.Text strong>{item.productName}</Typography.Text><span>Còn <b>{number.format(item.stock)}</b> / tối thiểu {number.format(item.minimumStock)}</span></div>)}</div>;
}

function Notifications({ items, navigate }: { items: DashboardData["notifications"]; navigate: (href: string) => void }) {
  if (items.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có thông báo cần xử lý" />;
  return <div className="notification-list">{items.map((item) => <button className={`notification-item ${item.severity}`} key={item.type} onClick={() => void navigate(item.href)}><span className="notification-dot" /><span>{item.title}</span></button>)}</div>;
}

function NoPermission() { return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Vai trò hiện tại không có quyền xem dữ liệu này" />; }
