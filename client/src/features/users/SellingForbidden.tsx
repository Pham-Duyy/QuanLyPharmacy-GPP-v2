import { App, Button, Checkbox, Form, Input, Modal, Result } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router";
import { getErrorMessage, http } from "../../api/http";
import { useAuth } from "../auth/auth-context";

/**
 * Trang bán hàng khi người dùng chưa có vai trò Dược sĩ tại cửa hàng đang chọn
 * (Phase 7, D29). Theo GPP chỉ người có chuyên môn dược mới bán thuốc, nên vai
 * trò Quản lý không tự có quyền bán. Chủ nhà thuốc có chứng chỉ hành nghề thì
 * tự thêm vai trò Dược sĩ cho mình ngay tại đây.
 */
export function SellingForbidden() {
  const { can, me, storeId, reloadMe } = useAuth();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<{
    qualificationReference: string;
    practiceCertificateNumber: string;
    responsibleProfessional: boolean;
  }>();
  const store = me?.stores.find((item) => item.id === storeId);
  const canManageStaff = can("user.manage");

  async function submit() {
    // Thiếu ô bắt buộc thì form đã tự báo lỗi tại chỗ, không gửi đi.
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    setSaving(true);
    try {
      await http.post("/users/me/pharmacist-role", { storeId, ...values });
      await reloadMe();
      message.success("Đã thêm vai trò Dược sĩ. Bạn bán hàng được ngay.");
      setOpen(false);
    } catch (error) {
      message.error(getErrorMessage(error, "Không thêm được vai trò Dược sĩ"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Result
        status="403"
        title="Bán thuốc cần vai trò Dược sĩ"
        subTitle={
          <>
            Theo GPP, chỉ người có chuyên môn dược mới bán thuốc, nên vai trò Quản lý không tự có
            quyền bán. {store ? `Tại ${store.name}, ` : ""}
            {canManageStaff
              ? "nếu bạn là chủ nhà thuốc có chứng chỉ hành nghề dược, hãy thêm vai trò Dược sĩ cho chính mình. Vai trò Quản lý vẫn giữ nguyên."
              : "hãy nhờ quản lý thêm vai trò Dược sĩ cho bạn ở trang Nhân viên."}
          </>
        }
        extra={[
          canManageStaff && (
            <Button key="add" type="primary" onClick={() => setOpen(true)}>
              Thêm vai trò Dược sĩ cho tôi
            </Button>
          ),
          <Button key="home" onClick={() => void navigate("/")}>
            Về trang chính
          </Button>,
        ]}
      />
      <Modal
        open={open}
        title="Thêm vai trò Dược sĩ cho tôi"
        okText="Thêm vai trò"
        cancelText="Hủy"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setOpen(false)}
        destroyOnHidden
      >
        <p>
          Áp dụng tại <strong>{store?.name ?? "cửa hàng đang chọn"}</strong>. Thao tác được ghi vào
          nhật ký hệ thống.
        </p>
        <Form form={form} layout="vertical" initialValues={{ responsibleProfessional: false }}>
          <Form.Item
            name="practiceCertificateNumber"
            label="Số chứng chỉ hành nghề dược"
            rules={[{ required: true, whitespace: true, message: "Nhập số chứng chỉ hành nghề" }]}
          >
            <Input placeholder="Ví dụ: 01234/CCHN-D-SYT-HCM" maxLength={100} />
          </Form.Item>
          <Form.Item
            name="qualificationReference"
            label="Bằng cấp chuyên môn"
            rules={[{ required: true, whitespace: true, message: "Ghi bằng cấp chuyên môn" }]}
          >
            <Input placeholder="Ví dụ: Dược sĩ đại học, ĐH Dược Hà Nội, 2015" maxLength={500} />
          </Form.Item>
          <Form.Item name="responsibleProfessional" valuePropName="checked">
            <Checkbox>Tôi là người phụ trách chuyên môn của nhà thuốc này</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
