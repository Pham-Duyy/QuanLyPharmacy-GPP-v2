import { CheckCircleOutlined, CloseCircleOutlined } from "@ant-design/icons";
import { useMutation } from "@tanstack/react-query";
import { Alert, App, Input, Modal, Segmented } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../../api/http.js";
import type { GoodsReceiptDetail } from "../../../api/types.js";
import { formatDate, formatNumber } from "../../../ui/format.js";
import { ShelfLocationInput } from "../ShelfLocationInput.js";
import { useShelfHints } from "../shelf-location-api.js";

/** `shelfLocation` chưa gõ (undefined) thì dùng vị trí gần nhất của cùng thuốc. */
type InspectionResult = { passed: boolean; rejectReason: string; shelfLocation?: string };

/**
 * Kiểm nhập cảm quan trước khi xác nhận (thực hành GPP): mỗi dòng phải được
 * đánh dấu đạt/không đạt. Mặc định "Đạt" cho đỡ mất công ở trường hợp phổ
 * biến — hàng không có vấn đề gì; dòng không đạt bắt buộc ghi lý do và sẽ
 * vào lô biệt trữ ngay, không có lúc nào ở trạng thái bán được.
 */
export function InspectionModal({
  open,
  receipt,
  getIdempotencyKey,
  onClose,
  onConfirmed,
}: {
  open: boolean;
  receipt: GoodsReceiptDetail;
  getIdempotencyKey: () => string;
  onClose: () => void;
  onConfirmed: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const [results, setResults] = useState<Record<string, InspectionResult>>({});
  const hints = useShelfHints(
    receipt.lines.map((line) => line.productId),
    open,
  );
  const shelfOf = (line: GoodsReceiptDetail["lines"][number]) =>
    results[line.id]?.shelfLocation ?? hints.data?.byProduct[line.productId] ?? "";

  // Nạp lại form mỗi lần mở, ngay trong lượt render (không qua effect nên không vẽ thêm một lượt).
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setResults(
        Object.fromEntries(
          receipt.lines.map((line) => [line.id, { passed: true, rejectReason: "" }]),
        ),
      );
    }
  }

  const confirm = useMutation({
    mutationFn: () =>
      http.post(
        `/goods-receipts/${receipt.id}/confirm`,
        {
          lines: receipt.lines.map((line) => ({
            lineId: line.id,
            passed: results[line.id]?.passed ?? true,
            rejectReason: results[line.id]?.passed ? null : results[line.id]?.rejectReason,
            shelfLocation: shelfOf(line) || null,
          })),
        },
        { headers: { "Idempotency-Key": getIdempotencyKey() } },
      ),
    onSuccess: async () => {
      void message.success("Đã xác nhận kiểm nhập và cập nhật tồn kho");
      await onConfirmed();
    },
    onError: (error) =>
      void message.error(getErrorMessage(error, "Không xác nhận được phiếu nhập")),
  });

  const hasFailedWithoutReason = receipt.lines.some((line) => {
    const result = results[line.id];
    return result && !result.passed && result.rejectReason.trim().length === 0;
  });
  const failedCount = receipt.lines.filter(
    (line) => results[line.id] && !results[line.id]!.passed,
  ).length;

  return (
    <Modal
      open={open}
      width={720}
      title="Kiểm nhập cảm quan trước khi nhập kho"
      okText={failedCount > 0 ? `Xác nhận (${failedCount} dòng biệt trữ)` : "Xác nhận nhập kho"}
      cancelText="Đóng"
      onCancel={onClose}
      onOk={() => confirm.mutate()}
      confirmLoading={confirm.isPending}
      okButtonProps={{ disabled: hasFailedWithoutReason }}
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        title="Kiểm tra hạn dùng, bao bì và chất lượng cảm quan từng dòng trước khi cho vào kho bán. Dòng Không đạt sẽ vào lô biệt trữ ngay, không bán được cho tới khi mở biệt trữ."
      />
      <div className="inspect-list">
        {receipt.lines.map((line) => {
          const result = results[line.id] ?? { passed: true, rejectReason: "" };
          return (
            <div key={line.id} className={result.passed ? "inspect-item" : "inspect-item failed"}>
              <div className="inspect-item-head">
                <div className="cell-main">
                  <strong>{line.productName}</strong>
                  <span>
                    Lô {line.batchNumber} · HSD {formatDate(line.expiryDate)} ·{" "}
                    {formatNumber(line.quantity)} {line.unitName}
                  </span>
                </div>
                <Segmented
                  value={result.passed ? "pass" : "fail"}
                  onChange={(value) =>
                    setResults((current) => ({
                      ...current,
                      [line.id]: { ...result, passed: value === "pass" },
                    }))
                  }
                  options={[
                    {
                      value: "pass",
                      label: (
                        <span className="text-success">
                          <CheckCircleOutlined /> Đạt
                        </span>
                      ),
                    },
                    {
                      value: "fail",
                      label: (
                        <span className="text-danger">
                          <CloseCircleOutlined /> Không đạt
                        </span>
                      ),
                    },
                  ]}
                />
              </div>
              <ShelfLocationInput
                size="small"
                value={shelfOf(line)}
                locations={hints.data?.locations ?? []}
                onChange={(value) =>
                  setResults((current) => ({
                    ...current,
                    [line.id]: { ...result, shelfLocation: value },
                  }))
                }
              />
              {!result.passed ? (
                <Input.TextArea
                  rows={2}
                  placeholder="Lý do không đạt (bắt buộc), ví dụ: bao bì móp, ẩm mốc, sai số lô…"
                  value={result.rejectReason}
                  status={result.rejectReason.trim() ? undefined : "error"}
                  onChange={(event) =>
                    setResults((current) => ({
                      ...current,
                      [line.id]: { ...result, rejectReason: event.target.value },
                    }))
                  }
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
