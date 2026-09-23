import { BellOutlined, CheckCircleOutlined, ExclamationCircleOutlined, FieldTimeOutlined, InboxOutlined, ShoppingOutlined, WarningOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Empty, Skeleton, Tag } from "antd";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { http } from "../../api/http.js";
import { type BatchListItem, type DashboardData, type Envelope, type InventoryOverviewItem, type Paged } from "../../api/types.js";
import { daysUntil, formatDate, formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { PanelEmpty } from "../../ui/PanelEmpty.js";
import { StatCard, StatGrid } from "../../ui/StatCard.js";
import { useAuth } from "../auth/AuthProvider.js";

type Level = "danger" | "warning" | "info";
type AlertRow = { key: string; level: Level; kind: string; productName: string; detail: string; batch?: BatchListItem };

const LEVEL_COLOR: Record<Level, string> = { danger: "red", warning: "orange", info: "blue" };
const LEVEL_ALERT_TYPE: Record<Level, "error" | "warning" | "info"> = { danger: "error", warning: "warning", info: "info" };

/** Cảnh báo vận hành lấy trực tiếp từ tồn theo lô và mức tồn tối thiểu, không có số liệu minh họa. */
export function AlertsPage() {
  const { storeId } = useAuth();
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
  // Số đếm lấy từ máy chủ (toàn bộ lô), danh sách bên dưới giới hạn 100 dòng mỗi loại.
  const dashboard = useQuery({
    queryKey: ["dashboard", storeId, 7],
    queryFn: async () => (await http.get<Envelope<DashboardData>>("/dashboard", { params: { days: 7 } })).data.data,
    enabled: Boolean(storeId),
    staleTime: 60_000,
  });
  const counts = dashboard.data?.inventory.counts;

  const alerts = useMemo<AlertRow[]>(() => {
    const batchAlerts: AlertRow[] = [];
    for (const batch of batches.data ?? []) {
      if (batch.quantityOnHand <= 0) continue;
      const days = daysUntil(batch.expiryDate);
      if (days < 0) batchAlerts.push({ key: `expired-${batch.id}`, level: "danger", kind: "Đã hết hạn", productName: batch.productName, detail: `Lô ${batch.batchNumber} đã hết hạn ${Math.abs(days)} ngày`, batch });
      else if (days <= 90) batchAlerts.push({ key: `near-${batch.id}`, level: "warning", kind: "Sắp hết hạn", productName: batch.productName, detail: `Lô ${batch.batchNumber} còn ${days} ngày · HSD ${formatDate(batch.expiryDate)}`, batch });
    }
    batchAlerts.sort((a, b) => daysUntil(a.batch!.expiryDate) - daysUntil(b.batch!.expiryDate));
    const lowStock: AlertRow[] = (overview.data ?? []).map((item) => ({
      key: `low-${item.productId}`,
      level: "info",
      kind: "Tồn thấp",
      productName: item.name,
      detail: `Còn ${formatNumber(item.stock.sellable)}, mức tối thiểu ${formatNumber(item.minStockBaseQuantity)}`,
    }));
    return [...batchAlerts, ...lowStock];
  }, [batches.data, overview.data]);

  const expired = alerts.filter((item) => item.level === "danger");
  const nearExpiry = alerts.filter((item) => item.level === "warning");
  const lowStock = alerts.filter((item) => item.level === "info");
  const effectiveKey = selectedKey ?? alerts[0]?.key ?? null;
  const selected = alerts.find((item) => item.key === effectiveKey) ?? null;
  const loading = batches.isLoading || overview.isLoading;

  return (
    <div>
      <PageHeader
        icon={<BellOutlined />}
        title="Cảnh báo"
        description="Lô hết hạn, sắp hết hạn và mặt hàng dưới mức tồn tối thiểu — tính trực tiếp từ dữ liệu kho."
        extra={
          <>
            <Button icon={<FieldTimeOutlined />} onClick={() => void navigate("/can-han")}>
              Xử lý hàng cận hạn
            </Button>
            <Button icon={<ShoppingOutlined />} onClick={() => void navigate("/de-xuat-dat-hang")}>
              Đề xuất đặt hàng
            </Button>
          </>
        }
      />

      <StatGrid>
        <StatCard tone="red" icon={<ExclamationCircleOutlined />} label="Lô đã hết hạn" value={formatNumber(counts?.expired)} loading={dashboard.isLoading} hint="Nguy cấp — xử lý ngay" />
        <StatCard tone="orange" icon={<WarningOutlined />} label="Lô sắp hết hạn" value={formatNumber(counts?.expiring)} loading={dashboard.isLoading} hint="Trong 90 ngày tới" />
        <StatCard tone="blue" icon={<InboxOutlined />} label="Dưới tồn tối thiểu" value={formatNumber(counts?.lowStock)} loading={dashboard.isLoading} hint="Mặt hàng nên nhập thêm" />
      </StatGrid>

      <div className="split-layout">
        <Card title="Cảnh báo cần xử lý">
          {loading ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : alerts.length === 0 ? (
            <PanelEmpty icon={<CheckCircleOutlined />} title="Không có cảnh báo nào" description="Mọi lô còn hạn dài và tồn kho đều trên mức tối thiểu." />
          ) : (
            <div className="detail-stack">
              <AlertGroup title="Nguy cấp — cần xử lý ngay" level="danger" items={expired} selectedKey={effectiveKey} onSelect={setSelectedKey} />
              <AlertGroup title="Cảnh báo — cần xử lý sớm" level="warning" items={nearExpiry} selectedKey={effectiveKey} onSelect={setSelectedKey} />
              <AlertGroup title="Thông tin — tồn thấp" level="info" items={lowStock} selectedKey={effectiveKey} onSelect={setSelectedKey} />
            </div>
          )}
        </Card>
        <aside className="split-aside">
          <AlertDetail alert={selected} navigate={navigate} />
        </aside>
      </div>
    </div>
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
  if (!alert) {
    return (
      <Card title="Chi tiết cảnh báo">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chọn một cảnh báo bên trái để xem chi tiết" />
      </Card>
    );
  }
  return (
    <Card title="Chi tiết cảnh báo">
      <div className="detail-stack">
        <div>
          <Tag color={LEVEL_COLOR[alert.level]}>{alert.kind}</Tag>
          <h3 className="detail-title" style={{ marginTop: 8 }}>
            {alert.productName}
          </h3>
        </div>
        <Alert type={LEVEL_ALERT_TYPE[alert.level]} showIcon title={alert.detail} />
        {alert.batch ? (
          <dl className="kv-list">
            <div>
              <dt>Số lô</dt>
              <dd className="mono">{alert.batch.batchNumber}</dd>
            </div>
            <div>
              <dt>Hạn dùng</dt>
              <dd>{formatDate(alert.batch.expiryDate)}</dd>
            </div>
            <div>
              <dt>Tồn kho</dt>
              <dd>
                {formatNumber(alert.batch.quantityOnHand)} {alert.batch.baseUnitName}
              </dd>
            </div>
            <div>
              <dt>Vị trí kệ</dt>
              <dd>{alert.batch.shelfLocation ?? "—"}</dd>
            </div>
          </dl>
        ) : null}
        <div className="alert-tips">
          <strong>Gợi ý xử lý</strong>
          <ul>
            <li>Đối chiếu số lượng tồn thực tế tại quầy/kho.</li>
            {alert.level === "info" ? (
              <li>Cân nhắc lập phiếu nhập bổ sung nếu vẫn còn nhu cầu bán.</li>
            ) : alert.level === "warning" ? (
              <li>Ưu tiên bán lô này trước (FEFO đã tự áp dụng khi bán), cân nhắc biệt trữ nếu còn quá ít ngày.</li>
            ) : (
              <li>Biệt trữ ngay để chặn bán, sau đó xử lý hủy theo quy trình hàng hết hạn của nhà thuốc.</li>
            )}
          </ul>
        </div>
        <Button type="primary" block onClick={() => navigate(alert.batch ? "/ton-kho" : "/phieu-nhap")}>
          {alert.batch ? "Mở Tồn kho để xử lý lô" : "Tạo phiếu nhập"}
        </Button>
      </div>
    </Card>
  );
}
