import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Typography,
  message,
} from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { formatVnd, type Envelope, type Invoice, type ReturnDetail } from "../../api/types.js";

type Draft = { allocationId: string; quantity: number };

/**
 * Nhận hàng khách trả. Mỗi dòng chọn theo **lô đã xuất** chứ không theo sản
 * phẩm, vì hàng phải quay về đúng lô in trên vỉ khách mang trả (contract §15).
 */
export function ReturnModal({
  invoice,
  open,
  onClose,
}: {
  invoice: Invoice;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [disposition, setDisposition] = useState<"RESTOCK" | "DISPOSE">("RESTOCK");
  const [refundMethod, setRefundMethod] = useState("CASH");
  const [reason, setReason] = useState("");

  const rows = invoice.lines.flatMap((line) =>
    line.allocations.map((allocation) => ({
      key: allocation.id,
      line,
      allocation,
      remaining: allocation.baseQuantity - allocation.returnedBaseQuantity,
    })),
  );

  const picked = Object.values(drafts).filter((draft) => draft.quantity > 0);

  const submit = useMutation({
    mutationFn: async () => {
      const lines = picked.map((draft) => {
        const row = rows.find((item) => item.allocation.id === draft.allocationId)!;
        return {
          invoiceLineId: row.line.id,
          allocationId: row.allocation.id,
          unitId: row.line.unitId,
          quantity: draft.quantity,
        };
      });

      const response = await http.post<Envelope<ReturnDetail>>(
        `/invoices/${invoice.id}/returns`,
        { reason: reason || null, disposition, refundMethod, lines },
        { headers: { "Idempotency-Key": crypto.randomUUID() } },
      );
      return response.data.data;
    },
    onSuccess: async (saved) => {
      void message.success(`Đã lập phiếu trả ${saved.code}, hoàn ${formatVnd(saved.refundAmount)}`);
      setDrafts({});
      setReason("");
      onClose();
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      await queryClient.invalidateQueries({ queryKey: ["invoice", invoice.id] });
      await queryClient.invalidateQueries({ queryKey: ["returns"] });
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không nhận trả được")),
  });

  // Ước lượng tiền hoàn theo tỷ lệ trên số tiền dòng đã lưu ở hóa đơn gốc.
  const estimatedRefund = picked.reduce((sum, draft) => {
    const row = rows.find((item) => item.allocation.id === draft.allocationId)!;
    const base = draft.quantity * row.line.conversionToBase;
    return sum + Math.round((row.line.lineTotal * base) / row.line.baseQuantity);
  }, 0);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => submit.mutate()}
      okText="Lập phiếu trả"
      okButtonProps={{ disabled: picked.length === 0 }}
      confirmLoading={submit.isPending}
      title={`Nhận trả hàng — ${invoice.code}`}
      width={760}
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <Table
          size="small"
          pagination={false}
          dataSource={rows}
          columns={[
            {
              title: "Sản phẩm",
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>{row.line.productName}</Typography.Text>
                  <Typography.Text type="secondary">
                    Lô {row.allocation.batchNumber} · hạn{" "}
                    {new Date(row.allocation.expiryDate).toLocaleDateString("vi-VN")}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: "Còn trả được",
              width: 120,
              align: "right",
              render: (_, row) => `${row.remaining} ${row.line.unitName}`,
            },
            {
              title: "Số lượng trả",
              width: 130,
              render: (_, row) => (
                <InputNumber
                  size="small"
                  min={0}
                  max={Math.floor(row.remaining / row.line.conversionToBase)}
                  style={{ width: "100%" }}
                  value={drafts[row.allocation.id]?.quantity ?? 0}
                  onChange={(value) =>
                    setDrafts((current) => ({
                      ...current,
                      [row.allocation.id]: {
                        allocationId: row.allocation.id,
                        quantity: value ?? 0,
                      },
                    }))
                  }
                />
              ),
            },
          ]}
        />

        <div>
          <Typography.Text type="secondary">Xử lý hàng trả</Typography.Text>
          <Radio.Group
            style={{ display: "block", marginTop: 4 }}
            value={disposition}
            onChange={(event) => setDisposition(event.target.value as "RESTOCK" | "DISPOSE")}
            options={[
              { value: "RESTOCK", label: "Nhập lại kho để bán" },
              { value: "DISPOSE", label: "Hủy, không bán lại" },
            ]}
          />
        </div>

        {disposition === "RESTOCK" ? (
          <Alert
            type="warning"
            showIcon
            message="Chỉ chọn nhập lại kho khi dược sĩ đã kiểm tra hàng còn nguyên vẹn và bảo quản đúng điều kiện. Thuốc kê đơn không được nhập lại kho."
          />
        ) : null}

        <div>
          <Typography.Text type="secondary">Hình thức hoàn tiền</Typography.Text>
          <Select
            style={{ width: "100%", marginTop: 4 }}
            value={refundMethod}
            onChange={setRefundMethod}
            options={[
              { value: "CASH", label: "Tiền mặt" },
              { value: "BANK_TRANSFER", label: "Chuyển khoản" },
              { value: "CARD", label: "Thẻ" },
            ]}
          />
        </div>

        <Input.TextArea
          rows={2}
          placeholder="Lý do khách trả (bắt buộc khi hủy hàng hoặc trả thuốc kê đơn)"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />

        <Typography.Text>
          Tiền hoàn tạm tính: <strong>{formatVnd(estimatedRefund)}</strong> — máy chủ tính lại theo
          đúng đơn giá và giảm giá đã lưu trên hóa đơn gốc.
        </Typography.Text>
      </Space>
    </Modal>
  );
}
