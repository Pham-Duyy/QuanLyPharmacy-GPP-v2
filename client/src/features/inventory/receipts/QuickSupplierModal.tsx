import { useMutation, useQueryClient } from "@tanstack/react-query";
import { App, Form, Input, Modal, Typography } from "antd";
import { getErrorMessage, http } from "../../../api/http.js";
import type { Envelope, SupplierListItem } from "../../../api/types.js";
import { phoneRule, taxCodeRule } from "../../../ui/validators";

type SupplierForm = {
  name: string;
  phone?: string;
  taxCode?: string;
  licenseNumber?: string;
  address?: string;
};

/** Thêm nhanh nhà cung cấp ngay trong phiếu nhập, không phải rời màn hình. */
export function QuickSupplierModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (supplier: SupplierListItem) => void;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<SupplierForm>();

  const create = useMutation({
    mutationFn: async (values: SupplierForm) =>
      (
        await http.post<Envelope<SupplierListItem>>("/suppliers", {
          name: values.name.trim(),
          phone: values.phone?.trim() || null,
          taxCode: values.taxCode?.trim() || null,
          licenseNumber: values.licenseNumber?.trim() || null,
          address: values.address?.trim() || null,
        })
      ).data.data,
    onSuccess: async (created) => {
      void message.success(`Đã thêm nhà cung cấp ${created.name}`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["receipt-suppliers"] }),
        queryClient.invalidateQueries({ queryKey: ["suppliers-page"] }),
      ]);
      form.resetFields();
      onCreated(created);
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không thêm được nhà cung cấp")),
  });

  return (
    <Modal
      open={open}
      title="Thêm nhà cung cấp"
      okText="Thêm và chọn"
      cancelText="Hủy"
      width={560}
      confirmLoading={create.isPending}
      onOk={() => void form.validateFields().then((values) => create.mutate(values))}
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        Nhà thuốc chỉ được mua hàng từ cơ sở kinh doanh dược hợp pháp — nên ghi đủ mã số thuế và số
        giấy phép.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" requiredMark="optional">
        <Form.Item
          name="name"
          label="Tên nhà cung cấp"
          rules={[{ required: true, whitespace: true, message: "Nhập tên nhà cung cấp" }]}
        >
          <Input placeholder="Ví dụ: Công ty CP Dược phẩm Traphaco" autoFocus />
        </Form.Item>
        <div className="form-grid">
          <Form.Item name="taxCode" label="Mã số thuế" rules={[taxCodeRule]}>
            <Input placeholder="10 hoặc 13 số" maxLength={20} />
          </Form.Item>
          <Form.Item name="licenseNumber" label="Số giấy phép kinh doanh dược">
            <Input maxLength={50} />
          </Form.Item>
          <Form.Item name="phone" label="Số điện thoại" rules={[phoneRule]}>
            <Input inputMode="tel" maxLength={20} />
          </Form.Item>
        </div>
        <Form.Item name="address" label="Địa chỉ">
          <Input placeholder="Số nhà, đường, phường/xã, tỉnh/thành phố" maxLength={500} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
