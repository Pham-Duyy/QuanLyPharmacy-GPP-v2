import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Card, Skeleton, Switch, Typography } from "antd";
import { getErrorMessage } from "../../api/http.js";
import { useAuth } from "../auth/auth-context.js";
import { mfaApi } from "../auth/mfa-api.js";

/**
 * Chính sách "bắt buộc xác thực hai lớp với Quản lý" (Phase 7, D31). Cài đặt
 * toàn chuỗi: chỉ quản lý toàn chuỗi đổi được.
 */
export function MfaPolicySettings() {
  const { me, reloadMe } = useAuth();
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const canEdit = me?.chainPermissions.includes("settings.manage") ?? false;
  const policy = useQuery({ queryKey: ["mfa-policy"], queryFn: mfaApi.policy });
  const save = useMutation({
    mutationFn: mfaApi.setPolicy,
    onSuccess: async (_, value) => {
      void message.success(value ? "Đã bắt buộc xác thực hai lớp với Quản lý" : "Đã bỏ bắt buộc");
      await queryClient.invalidateQueries({ queryKey: ["mfa-policy"] });
      await reloadMe();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được")),
  });

  function toggle(value: boolean) {
    if (!value) return save.mutate(false);
    modal.confirm({
      title: "Bắt buộc xác thực hai lớp với Quản lý?",
      content: me?.user.mfaEnabled
        ? "Quản lý nào chưa bật sẽ phải bật ở lần dùng phần mềm kế tiếp."
        : "Bạn chưa bật xác thực hai lớp: lưu xong, phần mềm sẽ bắt bạn bật ngay (cần điện thoại có ứng dụng Google Authenticator hoặc Microsoft Authenticator).",
      okText: "Bắt buộc",
      cancelText: "Quay lại",
      onOk: () => save.mutateAsync(true),
    });
  }

  return (
    <Card>
      {policy.isLoading ? (
        <Skeleton active />
      ) : (
        <div className="detail-stack">
          <label className="settings-switch-row">
            <Switch
              checked={policy.data ?? false}
              disabled={!canEdit}
              loading={save.isPending}
              onChange={toggle}
            />
            <span>
              <strong>Bắt buộc với Quản lý</strong>
              <Typography.Text type="secondary">
                {" "}
                — tài khoản có vai trò Quản lý phải bật xác thực hai lớp mới dùng được phần mềm.
              </Typography.Text>
            </span>
          </label>
          {!canEdit && (
            <Alert type="info" showIcon title="Chỉ quản lý toàn chuỗi đổi được cài đặt này." />
          )}
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            Nhân viên khác vẫn tự bật được ở menu tài khoản (góc trên bên phải) →{" "}
            <strong>Bật xác thực hai lớp</strong>. Nhân viên mất điện thoại và hết mã dự phòng thì
            quản lý vào <strong>Nhân viên</strong> → chọn người đó →{" "}
            <strong>Đặt lại xác thực hai lớp</strong>.
          </Typography.Paragraph>
        </div>
      )}
    </Card>
  );
}
