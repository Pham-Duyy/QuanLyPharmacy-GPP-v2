import {
  AppstoreOutlined,
  FileTextOutlined,
  InboxOutlined,
  RollbackOutlined,
  ShoppingCartOutlined,
} from "@ant-design/icons";
import { Button, Layout, Menu, Select, Space, Typography } from "antd";
import { Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "../features/auth/AuthProvider.js";

const ITEMS = [
  { key: "/ban-hang", icon: <ShoppingCartOutlined />, label: "Bán hàng", permission: "invoice.create" },
  { key: "/hoa-don", icon: <FileTextOutlined />, label: "Hóa đơn", permission: "invoice.read" },
  { key: "/tra-hang", icon: <RollbackOutlined />, label: "Trả hàng", permission: "invoice.read" },
  { key: "/san-pham", icon: <AppstoreOutlined />, label: "Sản phẩm", permission: "catalog.read" },
  { key: "/phieu-nhap", icon: <InboxOutlined />, label: "Phiếu nhập", permission: "goods_receipt.read" },
];

/** Khung chung: chọn cửa hàng ở trên, điều hướng bên trái, nội dung ở giữa. */
export function AppLayout() {
  const { me, storeId, selectStore, logout, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  if (!me) return null;

  // Chỉ hiện menu người dùng thực sự có quyền tại cửa hàng đang đứng.
  const visible = ITEMS.filter((item) => can(item.permission));

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "#0a7657",
          paddingInline: 20,
        }}
      >
        <Typography.Text style={{ color: "#fff", fontSize: 18, fontWeight: 600 }}>
          Nhà thuốc GPP
        </Typography.Text>
        <Space>
          <Select
            value={storeId ?? undefined}
            onChange={selectStore}
            style={{ minWidth: 240 }}
            options={me.stores.map((store) => ({
              value: store.id,
              label: `${store.code} — ${store.name}`,
            }))}
          />
          <Typography.Text style={{ color: "#fff" }}>{me.user.fullName}</Typography.Text>
          <Button onClick={() => void logout()}>Đăng xuất</Button>
        </Space>
      </Layout.Header>

      <Layout>
        <Layout.Sider width={200} theme="light" breakpoint="lg" collapsedWidth={56}>
          <Menu
            mode="inline"
            style={{ height: "100%", borderInlineEnd: 0 }}
            selectedKeys={[visible.find((item) => location.pathname.startsWith(item.key))?.key ?? ""]}
            onClick={({ key }) => void navigate(key)}
            items={visible.map((item) => ({
              key: item.key,
              icon: item.icon,
              label: item.label,
            }))}
          />
        </Layout.Sider>

        <Layout.Content style={{ padding: 20, background: "#f3f6f5" }}>
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
