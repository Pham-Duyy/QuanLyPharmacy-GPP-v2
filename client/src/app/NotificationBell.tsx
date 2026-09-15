import { BellOutlined, CheckCircleOutlined, RightOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Popover, Spin } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router";
import { http } from "../api/http.js";
import type { DashboardData, Envelope } from "../api/types.js";
import { useAuth } from "../features/auth/AuthProvider.js";

/**
 * Dùng chung truy vấn với trang Tổng quan (cùng queryKey, days = 7) nên không
 * gọi thêm API khi người dùng đang ở Tổng quan. Thông báo do backend tính
 * theo quyền của người dùng, ở đây chỉ hiển thị.
 */
export function NotificationBell() {
  const { storeId, can } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const enabled = Boolean(storeId) && can("catalog.read");

  const dashboard = useQuery({
    queryKey: ["dashboard", storeId, 7],
    queryFn: async () => (await http.get<Envelope<DashboardData>>("/dashboard", { params: { days: 7 } })).data.data,
    enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const items = dashboard.data?.notifications ?? [];
  const urgent = items.filter((item) => item.severity !== "info").length;

  const content = (
    <div className="notif-panel">
      <div className="notif-panel-head">
        <strong>Thông báo</strong>
        <span>{items.length > 0 ? `${items.length} mục cần chú ý` : "Cập nhật theo dữ liệu kho"}</span>
      </div>
      {dashboard.isLoading ? (
        <div className="notif-panel-empty">
          <Spin size="small" />
        </div>
      ) : items.length === 0 ? (
        <div className="notif-panel-empty">
          <CheckCircleOutlined />
          <span>Không có cảnh báo nào cần xử lý</span>
        </div>
      ) : (
        <ul className="notif-list">
          {items.map((item) => (
            <li key={item.type}>
              <button
                type="button"
                className={`notif-item notif-${item.severity}`}
                onClick={() => {
                  setOpen(false);
                  void navigate(item.href);
                }}
              >
                <span className="notif-dot" aria-hidden />
                <span className="notif-title">{item.title}</span>
                <RightOutlined className="notif-arrow" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  if (!enabled) return null;

  return (
    <Popover content={content} trigger="click" placement="bottomRight" open={open} onOpenChange={setOpen} arrow={false}>
      <Button type="text" className="header-icon-btn" aria-label={urgent > 0 ? `${urgent} thông báo cần xử lý` : "Thông báo"}>
        <Badge count={urgent} size="small" offset={[2, -2]}>
          <BellOutlined />
        </Badge>
      </Button>
    </Popover>
  );
}
