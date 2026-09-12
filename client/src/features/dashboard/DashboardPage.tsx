import { Alert, Button, Card, Col, Descriptions, Layout, Row, Select, Space, Tag, Typography } from "antd";
import { useAuth } from "../auth/AuthProvider.js";

/**
 * Màn hình tạm sau khi đăng nhập: cho thấy phiên đăng nhập, cửa hàng đang
 * làm việc và quyền hiệu lực tại cửa hàng đó. Các phân hệ nghiệp vụ sẽ thay
 * dần vào đây.
 */
export function DashboardPage() {
  const { me, storeId, selectStore, logout } = useAuth();
  if (!me) return null;

  const currentStore = me.stores.find((store) => store.id === storeId) ?? null;

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "#0a7657",
        }}
      >
        <Typography.Text style={{ color: "#fff", fontSize: 18, fontWeight: 600 }}>
          Nhà thuốc GPP
        </Typography.Text>
        <Space>
          <Select
            value={storeId ?? undefined}
            onChange={selectStore}
            style={{ minWidth: 220 }}
            options={me.stores.map((store) => ({
              value: store.id,
              label: `${store.code} - ${store.name}`,
            }))}
          />
          <Typography.Text style={{ color: "#fff" }}>{me.user.fullName}</Typography.Text>
          <Button onClick={() => void logout()}>Đăng xuất</Button>
        </Space>
      </Layout.Header>

      <Layout.Content style={{ padding: 24, background: "#f0f4f3" }}>
        {me.user.mustChangePassword ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="Tài khoản đang dùng mật khẩu tạm"
            description="Hãy đổi mật khẩu trước khi sử dụng hệ thống cho công việc thật."
          />
        ) : null}

        <Row gutter={16}>
          <Col xs={24} lg={10}>
            <Card title="Phiên đăng nhập" style={{ marginBottom: 16 }}>
              <Descriptions
                column={1}
                size="small"
                items={[
                  { key: "u", label: "Tài khoản", children: me.user.username },
                  { key: "n", label: "Họ tên", children: me.user.fullName },
                  {
                    key: "s",
                    label: "Cửa hàng đang làm việc",
                    children: currentStore ? ` - ` : "Chưa chọn",
                  },
                  { key: "p", label: "Quyền toàn chuỗi", children: me.chainPermissions.length },
                ]}
              />
            </Card>
          </Col>

          <Col xs={24} lg={14}>
            <Card title={`Quyền hiệu lực tại cửa hàng (${currentStore?.permissions.length ?? 0})`}>
              <Space size={[4, 8]} wrap>
                {(currentStore?.permissions ?? []).map((permission) => (
                  <Tag key={permission} color="green">
                    {permission}
                  </Tag>
                ))}
              </Space>
            </Card>
          </Col>
        </Row>
      </Layout.Content>
    </Layout>
  );
}
