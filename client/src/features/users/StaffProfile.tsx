import {
  CloseOutlined,
  EditOutlined,
  KeyOutlined,
  LockOutlined,
  SafetyOutlined,
  UnlockOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Popconfirm, Result, Skeleton, Tag } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import type { Envelope } from "../../api/types.js";
import { PanelEmpty } from "../../ui/PanelEmpty.js";
import { useAuth } from "../auth/AuthProvider.js";
import { staffKeys, useStaffDetail } from "./staff-api.js";
import { AccountStatus, Pairs, StaffAvatar, StaffNote } from "./staff-ui.js";
import { ChangeRolesModal, EditUserModal, TempPasswordAlert } from "./StaffAccountModals.js";

/** Hồ sơ nhân viên bằng dữ liệu thật: thông tin tài khoản, vai trò và thao tác theo quyền. */
export function StaffProfile({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can, me } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const detail = useStaffDetail(id);
  const [editing, setEditing] = useState(false);
  const [changingRoles, setChangingRoles] = useState(false);
  // Mật khẩu tạm chỉ giữ tới khi đóng thông báo hoặc chuyển sang người khác.
  const [tempPassword, setTempPassword] = useState<{ userId: string; value: string } | null>(null);

  async function refresh(): Promise<void> {
    await Promise.all([
      id ? queryClient.invalidateQueries({ queryKey: staffKeys.detail(id) }) : Promise.resolve(),
      queryClient.invalidateQueries({ queryKey: staffKeys.list }),
    ]);
  }

  const toggleActive = useMutation({
    mutationFn: (active: boolean) =>
      http.post(`/users/${id}/${active ? "deactivate" : "activate"}`),
    onSuccess: async (_, active) => {
      void message.success(active ? "Đã khóa tài khoản" : "Đã kích hoạt lại tài khoản");
      await refresh();
    },
    onError: (error) =>
      void message.error(getErrorMessage(error, "Không cập nhật được trạng thái tài khoản")),
  });

  const resetPassword = useMutation({
    mutationFn: async () =>
      (await http.post<Envelope<{ tempPassword: string }>>(`/users/${id}/reset-password`)).data
        .data,
    onSuccess: (data) => setTempPassword({ userId: id!, value: data.tempPassword }),
    onError: (error) => void message.error(getErrorMessage(error, "Không đặt lại được mật khẩu")),
  });

  if (id === null) {
    return (
      <PanelEmpty
        icon={<UserOutlined />}
        title="Chưa chọn nhân viên"
        description="Chọn một dòng trong danh sách để xem hồ sơ, vai trò và thao tác tài khoản."
      />
    );
  }
  if (detail.isLoading) return <Skeleton active avatar paragraph={{ rows: 8 }} />;
  if (detail.isError || !detail.data) {
    return (
      <Result
        status="warning"
        title="Không tải được hồ sơ"
        subTitle={getErrorMessage(detail.error, "Kiểm tra kết nối rồi thử lại.")}
        extra={<Button onClick={() => void detail.refetch()}>Thử lại</Button>}
      />
    );
  }

  const user = detail.data;
  const isSelf = user.id === me?.user.id;
  const manage = can("user.manage");

  return (
    <div className="staff-profile">
      <div className="staff-profile-head">
        <StaffAvatar name={user.fullName} id={user.id} size="lg" />
        <div>
          <h3>{user.fullName}</h3>
          <span className="staff-mono">@{user.username}</span>
          <div className="staff-profile-tags">
            <AccountStatus active={user.isActive} />
            {isSelf ? <Tag>Tài khoản của bạn</Tag> : null}
          </div>
        </div>
        <Button
          type="text"
          icon={<CloseOutlined />}
          aria-label="Đóng hồ sơ"
          onClick={onClose}
          className="staff-profile-close"
        />
      </div>

      {tempPassword?.userId === user.id ? (
        <TempPasswordAlert
          username={user.username}
          tempPassword={tempPassword.value}
          onDismiss={() => setTempPassword(null)}
        />
      ) : null}
      {user.mustChangePassword ? (
        <Alert type="info" showIcon title="Nhân viên chưa đổi mật khẩu được cấp." />
      ) : null}

      <section className="staff-profile-section">
        <h4>Thông tin nhân viên</h4>
        <Pairs
          items={[
            ["Họ và tên", user.fullName],
            ["Số điện thoại", user.phone ?? "—"],
            ["Chứng chỉ hành nghề", user.practiceCertificateNumber ?? "—"],
          ]}
        />
      </section>

      <section className="staff-profile-section">
        <h4>Tài khoản &amp; phân quyền</h4>
        <Pairs
          items={[
            [
              "Tên đăng nhập",
              <span className="staff-mono" key="u">
                @{user.username}
              </span>,
            ],
            ["Trạng thái tài khoản", <AccountStatus key="s" active={user.isActive} />],
          ]}
        />
        <ul className="staff-role-list" aria-label="Vai trò và phạm vi">
          {user.roles.length === 0 ? (
            <li className="staff-role-empty">
              Chưa gán vai trò — tài khoản chưa dùng được hệ thống.
            </li>
          ) : (
            user.roles.map((role, index) => (
              <li key={`${role.roleCode}-${role.storeId ?? "chain"}-${index}`}>
                <div>
                  <strong>{role.roleName}</strong>
                  <span>{role.storeId ? (role.storeName ?? "Cửa hàng") : "Toàn chuỗi"}</span>
                </div>
                {role.responsibleProfessional ? <Tag color="blue">Phụ trách chuyên môn</Tag> : null}
                {role.additionalPermissions?.length ? (
                  <small>{role.additionalPermissions.length} quyền bổ sung tại cửa hàng</small>
                ) : null}
                {role.roleCode === "pharmacist" ? (
                  <small>
                    {role.qualificationReference
                      ? `Căn cứ chuyên môn: ${role.qualificationReference}`
                      : "Chưa ghi căn cứ kiểm tra chuyên môn — cần rà soát"}
                  </small>
                ) : null}
              </li>
            ))
          )}
        </ul>
        <StaffNote>
          Vai trò truy cập quyết định quyền trong phần mềm; chức danh là thông tin nghiệp vụ nhân
          sự, hiện chưa có trong dữ liệu hệ thống.
        </StaffNote>
      </section>

      {manage ? (
        <div className="staff-profile-actions">
          <Button
            type="primary"
            icon={<SafetyOutlined />}
            disabled={isSelf}
            title={isSelf ? "Không tự đổi vai trò của chính mình" : undefined}
            onClick={() => setChangingRoles(true)}
          >
            Quản lý vai trò
          </Button>
          <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
            Sửa thông tin
          </Button>
          <Popconfirm
            title="Đặt lại mật khẩu?"
            description="Mật khẩu tạm mới hiện một lần; mọi phiên đăng nhập của người này bị đăng xuất."
            okText="Đặt lại"
            cancelText="Quay lại"
            onConfirm={() => resetPassword.mutate()}
          >
            <Button icon={<KeyOutlined />} loading={resetPassword.isPending}>
              Đặt lại mật khẩu
            </Button>
          </Popconfirm>
          {isSelf ? null : (
            <Popconfirm
              title={user.isActive ? "Khóa tài khoản này?" : "Kích hoạt lại tài khoản này?"}
              description={
                user.isActive
                  ? "Người này bị đăng xuất và không đăng nhập được cho tới khi kích hoạt lại. Tình trạng làm việc không thay đổi."
                  : undefined
              }
              okText={user.isActive ? "Khóa" : "Kích hoạt"}
              okButtonProps={{ danger: user.isActive }}
              cancelText="Quay lại"
              onConfirm={() => toggleActive.mutate(user.isActive)}
            >
              <Button
                danger={user.isActive}
                icon={user.isActive ? <LockOutlined /> : <UnlockOutlined />}
                loading={toggleActive.isPending}
              >
                {user.isActive ? "Khóa tài khoản" : "Kích hoạt lại"}
              </Button>
            </Popconfirm>
          )}
        </div>
      ) : null}

      <EditUserModal
        open={editing}
        user={user}
        onClose={() => setEditing(false)}
        onSaved={async () => {
          setEditing(false);
          await refresh();
        }}
      />
      {changingRoles ? (
        <ChangeRolesModal
          open
          user={user}
          onClose={() => setChangingRoles(false)}
          onSaved={async () => {
            setChangingRoles(false);
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}
