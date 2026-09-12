import { Alert, Card, Col, Descriptions, Row, Space, Tag } from "antd";
import { useAuth } from "../auth/AuthProvider.js";

/** Thông tin phiên đăng nhập và quyền hiệu lực tại cửa hàng đang làm việc. */
export function DashboardPage() {
  const { me, storeId } = useAuth();
  if (!me) return null;

  const currentStore = me.stores.find((store) => store.id === storeId) ?? null;

  return (
    <>
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
                  children: currentStore
                    ? `${currentStore.code} — ${currentStore.name}`
                    : "Chưa chọn",
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
    </>
  );
}
