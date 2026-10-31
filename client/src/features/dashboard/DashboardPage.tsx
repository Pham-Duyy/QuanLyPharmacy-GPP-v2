import {
  BellOutlined,
  DollarCircleOutlined,
  FileTextOutlined,
  ReloadOutlined,
  RightOutlined,
  TeamOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Col, Empty, Result, Row, Skeleton, Table, Typography } from "antd";
import { lazy, Suspense } from "react";
import { useNavigate } from "react-router";
import { http } from "../../api/http.js";
import type { DashboardData, Envelope } from "../../api/types.js";
import { InfoTip } from "../../ui/InfoTip.js";
import { StatCard, StatGrid, Trend } from "../../ui/StatCard.js";
import { useAuth } from "../auth/auth-context.js";

const money = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});
const number = new Intl.NumberFormat("vi-VN");

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 11) return "Chào buổi sáng";
  if (hour < 14) return "Chào buổi trưa";
  if (hour < 18) return "Chào buổi chiều";
  return "Chào buổi tối";
}

// Tải riêng: nhân viên không có quyền báo cáo không phải tải phần Bảng điều hành.
const ExecutiveDashboard = lazy(async () => ({
  default: (await import("../bi/ExecutiveDashboardPage.js")).ExecutiveDashboardPage,
}));

/**
 * Tổng quan.
 * - Có quyền báo cáo (admin, kiểm toán, dược sĩ): Bảng điều hành theo phạm vi được xem, kèm việc hôm nay của
 *   cửa hàng đang chọn đặt trên các tab phân tích.
 * - Còn lại: việc hôm nay của cửa hàng (chỉ số trong ngày, lô cần xử lý, hàng dưới mức tối thiểu).
 * Chỉ hiển thị số liệu API trả về.
 */
export function DashboardPage() {
  const { me, storeId, can } = useAuth();
  const navigate = useNavigate();
  // days = 7: cùng khóa truy vấn với chuông thông báo nên không gọi API hai lần.
  const days = 7;
  const dashboard = useQuery({
    queryKey: ["dashboard", storeId, days],
    queryFn: async () =>
      (await http.get<Envelope<DashboardData>>("/dashboard", { params: { days } })).data.data,
    enabled: Boolean(storeId),
  });
  const data = dashboard.data;
  const store = me?.stores.find((item) => item.id === storeId);

  if (!me) return null;

  // report.inventory: dược sĩ xem Bảng điều hành cửa hàng mình, không thấy lợi nhuận (D23, D24).
  if (can("report.sales") || can("report.chain") || can("report.inventory")) {
    return (
      <Suspense fallback={<Skeleton active paragraph={{ rows: 10 }} />}>
        <ExecutiveDashboard
          title="Tổng quan"
          storeWork={
            <section className="store-work">
              <h2>
                Việc hôm nay <span>· {store?.name ?? "cửa hàng đang chọn"}</span>
              </h2>
              {dashboard.isLoading ? (
                <Skeleton active paragraph={{ rows: 4 }} />
              ) : dashboard.isError || !data ? (
                <Alert
                  type="warning"
                  showIcon
                  title="Không tải được việc hôm nay của cửa hàng"
                  action={
                    <Button size="small" onClick={() => void dashboard.refetch()}>
                      Thử lại
                    </Button>
                  }
                />
              ) : (
                <StoreWork data={data} navigate={navigate} />
              )}
            </section>
          }
        />
      </Suspense>
    );
  }

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
  const updatedAt = new Date(data.generatedAt).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
  });

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
      </section>

      <StatGrid>
        <StatCard
          tone="green"
          icon={<DollarCircleOutlined />}
          label={
            <>
              Doanh thu hôm nay
              <InfoTip>Hóa đơn hoàn tất, đã trừ tiền hoàn của hàng khách trả trong ngày.</InfoTip>
            </>
          }
          value={data.permissions.sales ? money.format(data.sales.today.revenue) : noAccess}
          hint={
            data.permissions.sales ? (
              <Trend value={data.sales.today.revenueChangePercent} suffix="so với hôm qua" />
            ) : null
          }
        />
        <StatCard
          tone="blue"
          icon={<FileTextOutlined />}
          label="Hóa đơn hôm nay"
          value={data.permissions.sales ? number.format(data.sales.today.invoiceCount) : noAccess}
          hint={
            data.permissions.sales ? (
              <Trend value={data.sales.today.invoiceChangePercent} suffix="so với hôm qua" />
            ) : null
          }
        />
        <StatCard
          tone="purple"
          icon={<TeamOutlined />}
          label="Khách mới hôm nay"
          value={
            data.permissions.sales && data.permissions.customers
              ? number.format(data.sales.today.newCustomerCount)
              : noAccess
          }
          hint={
            data.permissions.sales && data.permissions.customers ? (
              <Trend value={data.sales.today.newCustomerChangePercent} suffix="so với hôm qua" />
            ) : null
          }
        />
        <StatCard
          tone="orange"
          icon={<WarningOutlined />}
          label="Lô hết hạn ≤ 90 ngày"
          value={
            data.permissions.inventory ? number.format(data.inventory.counts.expiring) : noAccess
          }
          hint={
            data.permissions.inventory
              ? data.inventory.counts.expired > 0
                ? `${number.format(data.inventory.counts.expired)} lô đã hết hạn`
                : null
              : null
          }
        />
      </StatGrid>

      <StoreWork data={data} navigate={navigate} />
    </div>
  );
}

/** Lô cần xử lý, việc cần chú ý, hàng dưới mức tối thiểu của cửa hàng đang chọn. */
function StoreWork({ data, navigate }: { data: DashboardData; navigate: (href: string) => void }) {
  return (
    <>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card
            title="Lô hết hạn trong 90 ngày"
            className="card-fill"
            extra={
              <Button type="link" onClick={() => void navigate("/can-han")}>
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
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="Không có lô nào hết hạn trong 90 ngày tới"
                    />
                  ),
                }}
                dataSource={data.inventory.expiringBatches}
                columns={[
                  {
                    title: "Tên thuốc",
                    dataIndex: "productName",
                    ellipsis: true,
                    render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
                  },
                  {
                    title: "Số lô",
                    dataIndex: "batchNumber",
                    width: 130,
                    render: (value: string) => <span className="mono">{value}</span>,
                  },
                  {
                    title: "Hạn dùng",
                    dataIndex: "expiryDate",
                    width: 110,
                    render: (value: string) => new Date(value).toLocaleDateString("vi-VN"),
                  },
                  {
                    title: "Tồn",
                    dataIndex: "quantityOnHand",
                    width: 90,
                    align: "right",
                    render: (value: number) => number.format(value),
                  },
                ]}
              />
            ) : (
              <NoPermission />
            )}
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

      <Card
        title="Mặt hàng dưới mức tồn tối thiểu"
        extra={
          <Button type="link" onClick={() => void navigate("/ton-kho")}>
            Mở tồn kho <RightOutlined />
          </Button>
        }
      >
        {data.permissions.inventory ? (
          <LowStock items={data.inventory.lowStockProducts} />
        ) : (
          <NoPermission />
        )}
      </Card>
    </>
  );
}

function LowStock({ items }: { items: DashboardData["inventory"]["lowStockProducts"] }) {
  if (items.length === 0)
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Không có mặt hàng dưới mức tồn tối thiểu"
      />
    );
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

function Notifications({
  items,
  navigate,
}: {
  items: DashboardData["notifications"];
  navigate: (href: string) => void;
}) {
  if (items.length === 0)
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có việc cần xử lý" />;
  return (
    <div className="notification-list">
      {items.map((item) => (
        <button
          type="button"
          className={`notification-item ${item.severity}`}
          key={item.type}
          onClick={() => void navigate(item.href)}
        >
          <span className="notification-dot" />
          <span>{item.title}</span>
        </button>
      ))}
    </div>
  );
}

function NoPermission() {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description="Vai trò hiện tại không có quyền xem dữ liệu này"
    />
  );
}
