import { CheckCircleFilled, EditOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input, Modal, Select } from "antd";
import { useState } from "react";

export type ControlledBuyer = {
  buyerName: string;
  buyerIdNumber: string;
  buyerAddress: string;
  buyerPhone?: string | null;
  relationship: "SELF" | "RELATIVE" | "CAREGIVER" | "OTHER";
  relationshipNote?: string | null;
};

const RELATIONSHIPS = [
  { value: "SELF", label: "Chính người bệnh" },
  { value: "RELATIVE", label: "Người nhà" },
  { value: "CAREGIVER", label: "Người chăm sóc" },
  { value: "OTHER", label: "Khác" },
];

const labelOf = (value: string) => RELATIONSHIPS.find((item) => item.value === value)?.label ?? value;

/**
 * Bán thuốc gây nghiện, hướng thần, tiền chất phải ghi người mua vào sổ theo
 * dõi. Ô này hiện ngay ở quầy khi giỏ hàng có thuốc thuộc nhóm đó.
 */
export function ControlledBuyerCard({
  productNames,
  value,
  onChange,
}: {
  productNames: string[];
  value: ControlledBuyer | null;
  onChange: (buyer: ControlledBuyer | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form] = Form.useForm<ControlledBuyer>();
  const relationship = Form.useWatch("relationship", form);

  return (
    <div className="pos-controlled">
      <Alert
        type={value ? "success" : "warning"}
        showIcon
        icon={value ? <CheckCircleFilled /> : <SafetyCertificateOutlined />}
        title={value ? "Đã ghi thông tin người mua" : "Thuốc kiểm soát đặc biệt: bắt buộc ghi người mua"}
        description={
          value ? (
            <span>
              {value.buyerName} · {value.buyerIdNumber} · {labelOf(value.relationship)}
              <br />
              {value.buyerAddress}
            </span>
          ) : (
            <span>
              Giỏ hàng có {productNames.join(", ")}. Theo quy định về thuốc gây nghiện, hướng thần và tiền chất, phải ghi họ tên, số giấy tờ tùy thân và địa chỉ người mua vào sổ theo dõi.
            </span>
          )
        }
        action={
          <Button size="small" type={value ? "default" : "primary"} icon={value ? <EditOutlined /> : undefined} onClick={() => setEditing(true)}>
            {value ? "Sửa" : "Ghi thông tin"}
          </Button>
        }
      />

      <Modal
        title="Thông tin người mua thuốc kiểm soát đặc biệt"
        open={editing}
        onCancel={() => setEditing(false)}
        okText="Lưu vào sổ"
        cancelText="Hủy"
        onOk={() => form.submit()}
        destroyOnHidden
        width={620}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={value ?? { relationship: "SELF" }}
          onFinish={(values) => {
            onChange({ ...values, buyerName: values.buyerName.trim(), buyerIdNumber: values.buyerIdNumber.trim(), buyerAddress: values.buyerAddress.trim() });
            setEditing(false);
          }}
        >
          <Form.Item name="buyerName" label="Họ tên người mua" rules={[{ required: true, message: "Nhập họ tên như trên giấy tờ tùy thân" }]}>
            <Input autoFocus placeholder="Nguyễn Văn A" maxLength={200} />
          </Form.Item>
          <Form.Item
            name="buyerIdNumber"
            label="Số giấy tờ tùy thân"
            rules={[
              { required: true, message: "Nhập số CCCD, CMND hoặc hộ chiếu" },
              { min: 6, message: "Số giấy tờ quá ngắn" },
            ]}
            extra="CCCD, CMND hoặc hộ chiếu của người đến mua."
          >
            <Input placeholder="079123456789" maxLength={30} />
          </Form.Item>
          <Form.Item name="buyerAddress" label="Địa chỉ" rules={[{ required: true, message: "Nhập địa chỉ người mua" }]}>
            <Input placeholder="12 Lý Thường Kiệt, Quận 10, TP.HCM" maxLength={300} />
          </Form.Item>
          <Form.Item name="buyerPhone" label="Điện thoại">
            <Input placeholder="0901234567" maxLength={20} />
          </Form.Item>
          <Form.Item name="relationship" label="Quan hệ với người bệnh" rules={[{ required: true }]}>
            <Select options={RELATIONSHIPS} />
          </Form.Item>
          {relationship === "OTHER" ? (
            <Form.Item name="relationshipNote" label="Ghi rõ quan hệ" rules={[{ required: true, message: "Ghi rõ quan hệ với người bệnh" }]}>
              <Input maxLength={200} />
            </Form.Item>
          ) : null}
          <Alert
            type="info"
            showIcon
            title="Nhớ giữ bản chính đơn thuốc"
            description="Đơn thuốc kiểm soát đặc biệt phải lưu tại nhà thuốc. Nên tải ảnh đơn vào phần mềm để tra cứu khi thanh tra."
          />
        </Form>
      </Modal>
    </div>
  );
}
