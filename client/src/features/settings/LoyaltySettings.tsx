import { SaveOutlined, UndoOutlined } from "@ant-design/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Card, Form, InputNumber, Result, Skeleton, Switch, Tag } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { formatDateTime } from "../../ui/format.js";
import { money } from "../customers/customer-labels.js";
import {
  LOYALTY_SETTINGS_KEY,
  useLoyaltySettings,
  type EffectiveLoyaltySettings,
  type LoyaltySettings as Settings,
} from "../loyalty/loyalty-api.js";
import { useUnsavedGuard } from "./settings-shared.js";

/** Cài đặt → Khách hàng → Tích điểm khách thân thiết. */
export function LoyaltySettings() {
  const query = useLoyaltySettings();

  if (query.isLoading) {
    return (
      <Card>
        <Skeleton active paragraph={{ rows: 8 }} />
      </Card>
    );
  }

  if (query.isError || !query.data) {
    return (
      <Card>
        <Result
          status="error"
          title="Không tải được cài đặt tích điểm"
          subTitle={getErrorMessage(query.error, "Kiểm tra kết nối rồi thử lại.")}
          extra={<Button onClick={() => void query.refetch()}>Thử lại</Button>}
        />
      </Card>
    );
  }

  return <LoyaltyForm key={query.data.updatedAt ?? "default"} state={query.data} />;
}

function LoyaltyForm({ state }: { state: EffectiveLoyaltySettings }) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<Settings>();
  const [dirty, setDirty] = useState(false);
  const [draft, setDraft] = useState<Settings>(state.settings);

  useUnsavedGuard(dirty, "Cài đặt tích điểm");

  const save = useMutation({
    mutationFn: async (values: Settings) =>
      (await http.put("/loyalty/settings", values)).data as unknown,
    onSuccess: async () => {
      void message.success("Đã lưu cài đặt tích điểm");
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: LOYALTY_SETTINGS_KEY });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không lưu được cài đặt"), 8),
  });

  const current = draft;
  // Ví dụ tính trên một hóa đơn 500.000đ để chủ nhà thuốc hình dung được
  // chi phí thật của chương trình.
  const sample = 500_000;
  const samplePoints = Math.floor(sample / Math.max(1, current.earnAmountPerPoint));
  const sampleValue = samplePoints * current.pointValue;
  const refundPercent = ((current.pointValue / Math.max(1, current.earnAmountPerPoint)) * 100).toFixed(1);

  return (
    <Card
      title="Tích điểm khách thân thiết"
      extra={
        state.isDefault ? (
          <Tag variant="filled" color="default">
            Đang dùng mặc định
          </Tag>
        ) : (
          <span className="muted">Cập nhật {formatDateTime(state.updatedAt)}</span>
        )
      }
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        title="Thuốc và chương trình khuyến mại"
        description="Luật Dược nghiêm cấm khuyến mại thuốc trực tiếp cho người dùng. Vì vậy mặc định hàng thuốc nằm ngoài chương trình tích điểm: chỉ thực phẩm chức năng, mỹ phẩm, thiết bị y tế và hàng khác mới được tính. Chỉ bật mục cuối cùng khi đã đối chiếu quy định hiện hành."
      />

      <Form
        form={form}
        layout="vertical"
        initialValues={state.settings}
        onValuesChange={(_changed, values) => {
          setDirty(true);
          setDraft(values);
        }}
        onFinish={(values) => save.mutate(values)}
      >
        <Form.Item
          name="enabled"
          label="Chạy chương trình tích điểm"
          valuePropName="checked"
          extra="Tắt thì hóa đơn mới không tích điểm và khách không đổi được điểm; điểm đã có vẫn giữ nguyên."
        >
          <Switch />
        </Form.Item>

        <div className="loyalty-settings-grid">
          <Form.Item
            name="earnAmountPerPoint"
            label="Chi bao nhiêu được 1 điểm"
            rules={[{ required: true, message: "Nhập số tiền" }]}
          >
            <InputNumber min={1000} step={1000} style={{ width: "100%" }} suffix="đ" />
          </Form.Item>

          <Form.Item
            name="pointValue"
            label="1 điểm đổi được"
            rules={[{ required: true, message: "Nhập giá trị điểm" }]}
          >
            <InputNumber min={100} step={100} style={{ width: "100%" }} suffix="đ" />
          </Form.Item>

          <Form.Item
            name="minRedeemPoints"
            label="Mỗi lần đổi tối thiểu"
            rules={[{ required: true, message: "Nhập số điểm" }]}
          >
            <InputNumber min={0} style={{ width: "100%" }} suffix="điểm" />
          </Form.Item>

          <Form.Item
            name="maxRedeemPercent"
            label="Một hóa đơn giảm tối đa"
            rules={[{ required: true, message: "Nhập phần trăm" }]}
          >
            <InputNumber min={1} max={100} style={{ width: "100%" }} suffix="%" />
          </Form.Item>

          <Form.Item
            name="expiryMonths"
            label="Điểm hết hạn sau"
            extra="Để 0 nếu điểm không hết hạn."
            rules={[{ required: true, message: "Nhập số tháng" }]}
          >
            <InputNumber min={0} max={120} style={{ width: "100%" }} suffix="tháng" />
          </Form.Item>
        </div>

        <Form.Item
          name="earnOnDrugs"
          label="Tính điểm cho cả hàng thuốc"
          valuePropName="checked"
          extra="Chỉ bật khi đã chắc chắn về quy định khuyến mại thuốc áp dụng cho nhà thuốc của mình."
        >
          <Switch />
        </Form.Item>

        <Alert
          type="info"
          showIcon
          title="Thử với một hóa đơn 500.000đ hàng được tính điểm"
          description={`Khách được ${samplePoints} điểm, tương đương ${money(sampleValue)} cho lần mua sau — nhà thuốc bù khoảng ${refundPercent}% doanh thu của nhóm hàng này.`}
        />

        <div className="settings-form-actions">
          <Button
            icon={<UndoOutlined />}
            disabled={!dirty || save.isPending}
            onClick={() => {
              form.setFieldsValue(state.settings);
              setDraft(state.settings);
              setDirty(false);
            }}
          >
            Khôi phục
          </Button>
          <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={() => void form.submit()}>
            Lưu cài đặt
          </Button>
        </div>
      </Form>
    </Card>
  );
}
