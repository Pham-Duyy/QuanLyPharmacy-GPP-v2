import { PlusOutlined, UserSwitchOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { useState } from "react";
import { PageHeader } from "../../ui/PageHeader.js";
import { useAuth } from "../auth/auth-context.js";
import { CreateStaffModal } from "./CreateStaffModal.js";
import { StaffList } from "./StaffList.js";

/** Phân mục Nhân viên: tài khoản đăng nhập và phân quyền làm việc. */
export function UsersPage() {
  const { can } = useAuth();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="staff-workspace">
      <PageHeader
        icon={<UserSwitchOutlined />}
        title="Nhân viên"
        extra={
          can("user.manage") ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              Thêm nhân viên
            </Button>
          ) : null
        }
      />

      <StaffList selectedId={selected} onSelect={setSelected} />

      <CreateStaffModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(user) => {
          setCreating(false);
          setSelected(user.id);
        }}
      />
    </div>
  );
}
