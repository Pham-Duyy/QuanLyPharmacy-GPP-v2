import { QuestionCircleOutlined } from "@ant-design/icons";
import { Popover } from "antd";
import type { ReactNode } from "react";

/**
 * Biểu tượng "?" mở phần giải thích, cách dùng: giữ màn hình ít chữ, ai cần thì
 * rê chuột hoặc bấm vào xem.
 */
export function InfoTip({ children }: { children: ReactNode }) {
  return (
    <Popover content={<div className="info-tip">{children}</div>} trigger={["hover", "click"]}>
      <QuestionCircleOutlined className="info-tip-icon" aria-label="Xem giải thích" />
    </Popover>
  );
}
