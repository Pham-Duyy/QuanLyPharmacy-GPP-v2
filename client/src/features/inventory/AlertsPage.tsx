import { BellOutlined, ExclamationCircleOutlined, InboxOutlined, WarningOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Col, Descriptions, Empty, Row, Space, Tag, Typography } from "antd";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { http } from "../../api/http.js";
import { type BatchListItem, type Envelope, type InventoryOverviewItem, type Paged } from "../../api/types.js";

type Level = "danger" | "warning" | "info";
type AlertRow = { key: string; level: Level; kind: string; productName: string; detail: string; batch?: BatchListItem };

const daysToExpiry = (date: string) => Math.ceil((new Date(date).getTime() - Date.now()) / 86_400_000);
const dateText = (date: string) => new Date(date).toLocaleDateString("vi-VN");
const LEVEL_COLOR: Record<Level, string> = { danger: "red", warning: "orange", info: "blue" };
const LEVEL_ALERT_TYPE: Record<Level, "error" | "warning" | "info"> = { danger: "error", warning: "warning", info: "info" };

/** Cảnh báo vận hành lấy trực tiếp từ tồn theo lô và mức tồn tối thiểu, không có số liệu minh họa. */
export function AlertsPage() {
  const navigate = useNavigate();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const batches = useQuery({
    queryKey: ["alert-batches"],
    queryFn: async () => (await http.get<Envelope<Paged<BatchListItem>>>("/inventory/batches", { params: { page: 1, limit: 100 } })).data.data.items,
  });
  const overview = useQuery({
    queryKey: ["alert-overview"],
    queryFn: async () => (await http.get<Envelope<Paged<InventoryOverviewItem>>>("/inventory", { params: { page: 1, limit: 100, belowMinStock: "true" } })).data.data.items,
  });

  const alerts = useMemo<AlertRow[]>(() => {
    const batchAlerts: AlertRow[] = [];
    for (const batch of batches.data ?? []) {
      const days = daysToExpiry(batch.expiryDate);
      if (days < 0) batchAlerts.push({ key: `expired-${batch.id}`, level: "danger", kind: "Đã hết hạn", productName: batch.productName, detail: `Lô ${batch.batchNumber} đã hết hạn ${Math.abs(days)} ngày`, batch });
      else if (days <= 90) batchAlerts.push({ key: `near-${batch.id}`, level: "warning", kind: "Sắp hết hạn", productName: batch.productName, detail: `Lô ${batch.batchNumber} còn ${days} ngày · HSD ${dateText(batch.expiryDate)}`, batch });
    }
    const lowStock: AlertRow[] = (overview.data ?? []).map((item) => ({ key: `low-${item.productId}`, level: "info", kind: "Tồn thấp", productName: item.name, detail: `Còn ${item.stock.sellable}, mức tối thiểu ${item.minStockBaseQuantity}` }));
    return [...batchAlerts, ...lowStock];
  }, [batches.data, overview.data]);

  const expired = alerts.filter((item) => item.level === "danger");
  const nearExpiry = alerts.filter((item) => item.level === "warning");
  const lowStock = alerts.filter((item) => item.level === "info");
  const effectiveKey = selectedKey ?? alerts[0]?.key ?? null;
  const selected = alerts.find((item) => item.key === effectiveKey) ?? null;
  const loading = batches.isLoading || overview.isLoading;

  return (
    <div className="alerts-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}><BellOutlined /> Cảnh báo</Typography.Title>
          <Typography.Text>Theo dõi và xử lý kịp thời các cảnh báo về thuốc và tồn kho.</Typography.Text>
        </div>
        <Tag color="blue">Cập nhật theo dữ liệu kho</Tag>
      </div>
      <Row gutter={[16, 16]} className="alert-stats">
        <AlertStat icon={<ExclamationCircleOutlined />} color="red" label="Hết hạn" value={expired.length} />
        <AlertStat icon={<WarningOutlined />} color="orange" label="Sắp hết hạn" value={nearExpiry.length} />
        <AlertStat icon={<InboxOutlined />} color="blue" label="Tồn thấp" value={lowStock.length} />
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card className="alerts-list-card" title="Cảnh báo cần xử lý" loading={loading}>
            {!loading && alerts.length === 0 ? (
              <Empty description="Chưa có cảnh báo nào từ dữ liệu kho hiện tại" />
            ) : (
              <Space direction="vertical" size="large" style={{ width: "100%" }}>
                <AlertGroup title="Nguy cấp — cần xử lý ngay" level="danger" items={expired} selectedKey={effectiveKey} onSelect={setSelectedKey} />
                <AlertGroup title="Cảnh báo — cần xử lý sớm" level="warning" items={nearExpiry} selectedKey={effectiveKey} onSelect={setSelectedKey} />
                <AlertGroup title="Thông tin" level="info" items={lowStock} selectedKey={effectiveKey} onSelect={setSelectedKey} />
              </Space>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <AlertDetail alert={selected} navigate={navigate} />
        </Col>
      </Row>
    </div>
  );
}

function AlertStat({ icon, color, label, value }: { icon: ReactNode; color: string; label: string; value: number }) {
  return (
    <Col xs={24} md={8}>
      <Card>
        <Space>
          <span className="alert-icon" style={{ background: color }}>{icon}</span>
          <div>
            <Typography.Text strong>{label}</Typography.Text>
            <Typography.Title level={3}>{value}</Typography.Title>
          </div>
        </Space>
      </Card>
    </Col>
  );
}

function AlertGroup({ title, level, items, selectedKey, onSelect }: { title: string; level: Level; items: AlertRow[]; selectedKey: string | null; onSelect: (key: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className={`alert-group alert-group-${level}`}>
      <div className="alert-group-title">
        {title} <Tag color={LEVEL_COLOR[level]}>{items.length}</Tag>
      </div>
      <div className="alert-group-rows">
        {items.map((item) => (
          <button key={item.key} type="button" className={`alert-row${item.key === selectedKey ? " selected" : ""}`} onClick={() => onSelect(item.key)}>
            <Tag color={LEVEL_COLOR[level]}>{item.kind}</Tag>
            <span className="alert-row-body">
              <strong>{item.productName}</strong>
              <span>{item.detail}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AlertDetail({ alert, navigate }: { alert: AlertRow | null; navigate: (path: string) => void }) {
  return (
    <Card className="alert-detail-card" title="Chi tiết cảnh báo">
      {!alert ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chọn một cảnh báo bên trái để xem chi tiết" />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space direction="vertical" size={4}>
            <Tag color={LEVEL_COLOR[alert.level]}>{alert.kind}</Tag>
            <Typography.Title level={4} style={{ margin: 0 }}>{alert.productName}</Typography.Title>
          </Space>
          <Alert type={LEVEL_ALERT_TYPE[alert.level]} showIcon message={alert.detail} />
          {alert.batch ? (
            <Descriptions
              size="small"
              column={1}
              items={[
                { key: "batch", label: "Số lô", children: alert.batch.batchNumber },
                { key: "expiry", label: "Hạn dùng", children: dateText(alert.batch.expiryDate) },
                { key: "qty", label: "Tồn kho", children: `${alert.batch.quantityOnHand} ${alert.batch.baseUnitName}` },
                { key: "location", label: "Vị trí", children: alert.batch.shelfLocation ?? "—" },
              ]}
            />
          ) : null}
          <div className="alert-tips">
            <Typography.Text type="secondary">Gợi ý xử lý</Typography.Text>
            <ul>
              <li>Đối chiếu số lượng tồn thực tế tại quầy/kho.</li>
              <li>{alert.level === "info" ? "Cân nhắc lập phiếu nhập bổ sung nếu vẫn còn nhu cầu bán." : "Cách ly hoặc xử lý lô theo đúng quy trình hàng hết hạn/sắp hết hạn của nhà thuốc."}</li>
            </ul>
          </div>
          <Button type="primary" block onClick={() => navigate(alert.batch ? "/ton-kho" : "/phieu-nhap")}>
            {alert.batch ? "Xem lô thuốc" : "Tạo phiếu nhập"}
          </Button>
        </Space>
      )}
    </Card>
  );
}
