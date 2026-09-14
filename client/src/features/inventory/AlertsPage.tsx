import { BellOutlined, ExclamationCircleOutlined, InboxOutlined, WarningOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, Col, Empty, Row, Space, Table, Tag, Typography } from "antd";
import { useMemo } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { http } from "../../api/http.js";
import { type BatchListItem, type Envelope, type InventoryOverviewItem, type Paged } from "../../api/types.js";

type AlertRow = { key: string; level: "danger" | "warning" | "info"; kind: string; productName: string; detail: string; batch?: BatchListItem };
const daysToExpiry = (date: string) => Math.ceil((new Date(date).getTime() - Date.now()) / 86_400_000);
const dateText = (date: string) => new Date(date).toLocaleDateString("vi-VN");

/** Cảnh báo vận hành lấy trực tiếp từ tồn theo lô và mức tồn tối thiểu, không có số liệu minh họa. */
export function AlertsPage() {
  const navigate = useNavigate();
  const batches = useQuery({ queryKey: ["alert-batches"], queryFn: async () => (await http.get<Envelope<Paged<BatchListItem>>>("/inventory/batches", { params: { page: 1, limit: 100 } })).data.data.items });
  const overview = useQuery({ queryKey: ["alert-overview"], queryFn: async () => (await http.get<Envelope<Paged<InventoryOverviewItem>>>("/inventory", { params: { page: 1, limit: 100, belowMinStock: "true" } })).data.data.items });
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
  return <div className="alerts-page"><div className="page-heading"><div><Typography.Title level={2}><BellOutlined /> Cảnh báo</Typography.Title><Typography.Text>Theo dõi và xử lý kịp thời các cảnh báo về thuốc và tồn kho.</Typography.Text></div><Tag color="blue">Cập nhật theo dữ liệu kho</Tag></div><Row gutter={[16, 16]} className="alert-stats"><AlertStat icon={<ExclamationCircleOutlined />} color="red" label="Hết hạn" value={expired.length} /><AlertStat icon={<WarningOutlined />} color="orange" label="Sắp hết hạn" value={nearExpiry.length} /><AlertStat icon={<InboxOutlined />} color="blue" label="Tồn thấp" value={lowStock.length} /></Row><Card className="alerts-list-card" title="Cảnh báo cần xử lý" loading={batches.isLoading || overview.isLoading}><Table rowKey="key" size="small" dataSource={alerts} pagination={{ pageSize: 15, showSizeChanger: false }} locale={{ emptyText: <Empty description="Chưa có cảnh báo từ dữ liệu đang tải" /> }} columns={[{ title: "Mức độ", width: 145, render: (_, item: AlertRow) => <Tag color={item.level === "danger" ? "red" : item.level === "warning" ? "orange" : "blue"}>{item.kind}</Tag> }, { title: "Thuốc / sản phẩm", dataIndex: "productName", render: (value) => <Typography.Text strong>{value}</Typography.Text> }, { title: "Chi tiết", dataIndex: "detail" }, { title: "Thao tác", width: 150, render: (_, item: AlertRow) => <Button size="small" onClick={() => void navigate(item.batch ? "/ton-kho" : "/phieu-nhap")}>{item.batch ? "Xem lô thuốc" : "Tạo phiếu nhập"}</Button> }]} /></Card></div>;
}

function AlertStat({ icon, color, label, value }: { icon: ReactNode; color: string; label: string; value: number }) { return <Col xs={24} md={8}><Card><Space><span className="alert-icon" style={{ background: color }}>{icon}</span><div><Typography.Text strong>{label}</Typography.Text><Typography.Title level={3}>{value}</Typography.Title></div></Space></Card></Col>; }
