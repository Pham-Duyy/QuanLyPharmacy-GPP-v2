import { GiftOutlined, HistoryOutlined, MinusOutlined, PlusOutlined } from "@ant-design/icons";
import { useMutation } from "@tanstack/react-query";
import { Alert, App, Button, Empty, Form, Input, InputNumber, Modal, Skeleton, Table, Tag } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { formatDate, formatDateTime, formatNumber } from "../../ui/format.js";
import { useAuth } from "../auth/AuthProvider.js";
import { money } from "../customers/customer-labels.js";
import { useCustomerLoyalty, useLoyaltySettings, type LoyaltyTransaction } from "./loyalty-api.js";

const TONE: Record<LoyaltyTransaction["type"], string> = {
  EARN: "green",
  REDEEM: "blue",
  REVERSE: "orange",
  ADJUST: "purple",
};

/** Điểm tích lũy của một khách: số dư, điểm sắp hết hạn và toàn bộ sổ điểm. */
export function LoyaltyPanel({ customerId }: { customerId: string }) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const [adjusting, setAdjusting] = useState<null | "ADD" | "SUBTRACT">(null);
  const [form] = Form.useForm<{ points: number; reason: string }>();

  const settingsQuery = useLoyaltySettings();
  const loyaltyQuery = useCustomerLoyalty(customerId);
  const settings = settingsQuery.data?.settings;
  const data = loyaltyQuery.data;

  const adjust = useMutation({
    mutationFn: async (values: { points: number; reason: string }) =>
      http.post(`/customers/${customerId}/loyalty/adjust`, {
        points: adjusting === "SUBTRACT" ? -values.points : values.points,
        reason: values.reason,
      }),
    onSuccess: async () => {
      void message.success(adjusting === "SUBTRACT" ? "Đã trừ điểm" : "Đã cộng điểm");
      setAdjusting(null);
      await loyaltyQuery.refetch();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không điều chỉnh được điểm"), 8),
  });

  if (loyaltyQuery.isLoading || settingsQuery.isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (!data) {
    return (
      <Alert
        type="warning"
        showIcon
        title="Không tải được điểm tích lũy"
        description={getErrorMessage(loyaltyQuery.error, "Thử lại sau.")}
      />
    );
  }

  const { balance } = data;

  return (
    <div className="loyalty-panel">
      {settings && !settings.enabled ? (
        <Alert
          type="info"
          showIcon
          title="Cửa hàng chưa bật chương trình tích điểm"
          description="Điểm cũ vẫn giữ nguyên, nhưng hóa đơn mới sẽ không tích thêm và khách chưa đổi điểm được. Bật trong Cài đặt › Khách hàng › Tích điểm khách thân thiết."
        />
      ) : null}

      <div className="cust-metrics">
        <div className="cust-metric tone-green">
          <GiftOutlined aria-hidden />
          <span>Điểm dùng được</span>
          <strong>{formatNumber(balance.available)}</strong>
        </div>
        <div className="cust-metric tone-blue">
          <PlusOutlined aria-hidden />
          <span>Tổng đã tích</span>
          <strong>{formatNumber(balance.totalEarned)}</strong>
        </div>
        <div className="cust-metric tone-purple">
          <MinusOutlined aria-hidden />
          <span>Đã đổi</span>
          <strong>{formatNumber(balance.totalRedeemed)}</strong>
        </div>
        <div className="cust-metric tone-orange">
          <HistoryOutlined aria-hidden />
          <span>Quy ra tiền</span>
          <strong>{settings ? money(balance.available * settings.pointValue) : "—"}</strong>
        </div>
      </div>

      {balance.expiringSoon > 0 ? (
        <Alert
          type="warning"
          showIcon
          title={`${formatNumber(balance.expiringSoon)} điểm sắp hết hạn`}
          description={`Hạn gần nhất là ${formatDate(balance.nextExpiryAt)}. Nên nhắc khách dùng trước khi mất.`}
        />
      ) : null}

      {can("loyalty.manage") ? (
        <div className="loyalty-actions">
          {/* Hộp thoại bị hủy khi đóng (destroyOnHidden) nên các ô nhập tự
              trống ở lần mở sau, không cần xóa tay. */}
          <Button icon={<PlusOutlined />} onClick={() => setAdjusting("ADD")}>
            Cộng điểm
          </Button>
          <Button icon={<MinusOutlined />} disabled={balance.available === 0} onClick={() => setAdjusting("SUBTRACT")}>
            Trừ điểm
          </Button>
        </div>
      ) : null}

      <Table
        rowKey="id"
        size="small"
        dataSource={data.transactions}
        pagination={false}
        scroll={{ x: 620 }}
        locale={{ emptyText: <Empty description="Khách chưa có giao dịch điểm nào" /> }}
        columns={[
          {
            title: "Thời điểm",
            dataIndex: "createdAt",
            width: 150,
            render: (value: string) => formatDateTime(value),
          },
          {
            title: "Nội dung",
            dataIndex: "typeLabel",
            render: (label: string, row: LoyaltyTransaction) => (
              <div className="cell-main">
                <span className="cell-title">
                  <Tag variant="filled" color={TONE[row.type]}>
                    {label}
                  </Tag>
                </span>
                <span className="cell-sub">
                  {row.invoice ? `Hóa đơn ${row.invoice.code}` : (row.note ?? "—")}
                  {row.amount !== null ? ` · ${money(row.amount)}` : ""}
                  {row.createdByName ? ` · ${row.createdByName}` : ""}
                </span>
              </div>
            ),
          },
          {
            title: "Điểm",
            dataIndex: "points",
            width: 90,
            align: "right" as const,
            render: (points: number) => (
              <strong className={points > 0 ? "loyalty-plus" : "loyalty-minus"}>
                {points > 0 ? "+" : ""}
                {formatNumber(points)}
              </strong>
            ),
          },
          {
            title: "Hạn dùng",
            dataIndex: "expiresAt",
            width: 120,
            render: (value: string | null) => (value ? formatDate(value) : <span className="muted">Không hết hạn</span>),
          },
        ]}
      />

      <Modal
        open={adjusting !== null}
        title={adjusting === "SUBTRACT" ? "Trừ điểm của khách" : "Cộng điểm cho khách"}
        okText={adjusting === "SUBTRACT" ? "Trừ điểm" : "Cộng điểm"}
        cancelText="Hủy"
        confirmLoading={adjust.isPending}
        destroyOnHidden
        mask={{ closable: !adjust.isPending }}
        onCancel={() => setAdjusting(null)}
        onOk={() => void form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={(values) => adjust.mutate(values)}>
          <Form.Item
            name="points"
            label="Số điểm"
            rules={[
              { required: true, message: "Nhập số điểm" },
              ...(adjusting === "SUBTRACT"
                ? [{ type: "number" as const, max: balance.available, message: `Khách chỉ còn ${balance.available} điểm` }]
                : []),
            ]}
          >
            <InputNumber min={1} style={{ width: "100%" }} placeholder="VD: 50" />
          </Form.Item>
          <Form.Item
            name="reason"
            label="Lý do"
            extra="Lý do được ghi vào sổ điểm và nhật ký, khách hỏi lại là tra ra ngay."
            rules={[{ required: true, message: "Phải ghi lý do điều chỉnh" }]}
          >
            <Input.TextArea
              rows={3}
              maxLength={500}
              placeholder={adjusting === "SUBTRACT" ? "VD: Trừ điểm cộng nhầm ngày 20/9" : "VD: Bù điểm hóa đơn quên quét thẻ"}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
