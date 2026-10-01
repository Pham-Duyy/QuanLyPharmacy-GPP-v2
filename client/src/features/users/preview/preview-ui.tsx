import { Tag } from "antd";
import type { ReactNode } from "react";
import { StatusDot } from "../staff-ui.js";
import { WORK_STATUS_LABEL } from "./preview-logic.js";
import type { PreviewEmployee } from "./preview-types.js";

/** Nhãn nhỏ đặt cạnh mọi số liệu mẫu, để không ai nhầm với dữ liệu vận hành. */
export function SampleTag() {
  return <Tag className="staff-sample-tag">Dữ liệu minh họa</Tag>;
}

export function WorkStatusTag({ status }: { status: PreviewEmployee["workStatus"] }) {
  const tone = status === "working" ? "green" : status === "probation" ? "blue" : "orange";
  return <StatusDot tone={tone}>{WORK_STATUS_LABEL[status]}</StatusDot>;
}

/** Tiêu đề khu vực trong một tab: tên, mô tả ngắn, nút bên phải. */
export function SectionHead({
  title,
  description,
  extra,
}: {
  title: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className="staff-section-head">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {extra ? <div className="staff-section-extra">{extra}</div> : null}
    </div>
  );
}
