import { CheckCircleFilled, SafetyCertificateOutlined } from "@ant-design/icons";
import { Checkbox, Input, Spin, Tag } from "antd";
import type { SafetyResult } from "../../../api/types.js";

const SEVERITY: Record<string, { label: string; color: string }> = {
  HIGH: { label: "Mức cao", color: "red" },
  MEDIUM: { label: "Trung bình", color: "orange" },
  INFO: { label: "Thông tin", color: "blue" },
};

const NOT_CHECKED_TEXT: Record<string, string> = {
  NO_INGREDIENT_MAPPING: "chưa gắn hoạt chất nên không đối chiếu trùng hoạt chất và dị ứng được",
  INTERACTION_SOURCE_NOT_CONFIGURED: "chưa có nguồn dữ liệu tương tác thuốc",
};

/** Kết quả kiểm tra an toàn của giỏ hàng (contract §13): chặn bán, cảnh báo cần ghi nhận, mục chưa kiểm tra được. */
export function SafetyPanel({
  loading,
  failed,
  blocking,
  warnings,
  notChecked,
  liveAcked,
  nameOf,
  onToggle,
  ackReason,
  onAckReasonChange,
}: {
  loading: boolean;
  failed: boolean;
  blocking: SafetyResult["blocking"];
  warnings: SafetyResult["warnings"];
  notChecked: SafetyResult["notChecked"];
  liveAcked: string[];
  nameOf: (productId: string) => string;
  onToggle: (code: string, checked: boolean) => void;
  ackReason: string | null;
  onAckReasonChange: (value: string) => void;
}) {
  return (
    <div className="pos-safety">
      <div className="pos-safety-head">
        <SafetyCertificateOutlined />
        <strong>Kiểm tra an toàn</strong>
        {loading ? <Spin size="small" /> : null}
      </div>

      {failed ? <div className="pos-safety-item danger">Không kiểm tra được an toàn. Thử sửa đơn hoặc tải lại trang.</div> : null}

      {!loading && !failed && blocking.length === 0 && warnings.length === 0 ? (
        <div className="pos-safety-item ok">
          <CheckCircleFilled /> Không phát hiện vấn đề chặn bán
        </div>
      ) : null}

      {blocking.map((item) => (
        <div className="pos-safety-item danger" key={`${item.code}-${item.productId}`}>
          {item.message}
        </div>
      ))}

      {warnings.map((warning) => {
        const severity = SEVERITY[warning.severity] ?? { label: warning.severity, color: "default" };
        return (
          <div className="pos-safety-item warning" key={`${warning.code}-${warning.productIds.join(",")}`}>
            <div className="pos-safety-title">
              <span>{warning.message}</span>
              <Tag color={severity.color}>{severity.label}</Tag>
            </div>
            {warning.requiresAck ? (
              <Checkbox checked={liveAcked.includes(warning.code)} onChange={(event) => onToggle(warning.code, event.target.checked)}>
                Đã tư vấn khách và chịu trách nhiệm tiếp tục bán
              </Checkbox>
            ) : (
              <span className="pos-safety-source">
                Nguồn: {warning.source} ({warning.sourceVersion})
              </span>
            )}
          </div>
        );
      })}

      {ackReason !== null ? <Input size="small" placeholder="Ghi chú khi ghi nhận cảnh báo (không bắt buộc)" value={ackReason} onChange={(event) => onAckReasonChange(event.target.value)} /> : null}

      {notChecked.length > 0 ? (
        <div className="pos-safety-item info">
          <strong>Hệ thống KHÔNG kiểm tra được các mục sau, đừng coi là an toàn:</strong>
          <ul>
            {notChecked.map((item) => (
              <li key={`${item.productId}-${item.reason}`}>
                {nameOf(item.productId)}: {NOT_CHECKED_TEXT[item.reason] ?? item.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
