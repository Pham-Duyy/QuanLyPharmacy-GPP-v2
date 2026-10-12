import { useMutation } from "@tanstack/react-query";
import { App, Input, Modal, Space, Typography } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../../api/http.js";
import type { CustomerDetail, Envelope } from "../../../api/types.js";

import type { Customer } from "./sale-cart.js";

/** Thêm khách mới ngay ở quầy rồi chọn luôn cho đơn đang bán. */
export function NewCustomerModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (customer: Customer) => void;
}) {
  const { message } = App.useApp();
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");

  const createCustomer = useMutation({
    mutationFn: async () =>
      (
        await http.post<Envelope<CustomerDetail>>("/customers", {
          fullName: newCustomerName.trim() || null,
          phone: newCustomerPhone.trim() || null,
        })
      ).data.data,
    onSuccess: (created) => {
      setNewCustomerName("");
      setNewCustomerPhone("");
      void message.success("Đã tạo và chọn khách hàng cho đơn bán");
      onCreated({ id: created.id, fullName: created.fullName, phone: created.phone });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không thể tạo khách hàng")),
  });

  return (
    <Modal
      open={open}
      title="Thêm khách hàng mới"
      okText="Tạo và chọn"
      cancelText="Hủy"
      confirmLoading={createCustomer.isPending}
      okButtonProps={{ disabled: !newCustomerName.trim() && !newCustomerPhone.trim() }}
      onOk={() => createCustomer.mutate()}
      onCancel={onClose}
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          Nhập ít nhất họ tên hoặc số điện thoại. Thông tin sức khỏe chỉ được bổ sung khi khách đồng
          ý.
        </Typography.Text>
        <Input
          placeholder="Họ và tên"
          value={newCustomerName}
          onChange={(event) => setNewCustomerName(event.target.value)}
          autoFocus
        />
        <Input
          placeholder="Số điện thoại"
          inputMode="tel"
          value={newCustomerPhone}
          onChange={(event) => setNewCustomerPhone(event.target.value)}
        />
      </Space>
    </Modal>
  );
}
