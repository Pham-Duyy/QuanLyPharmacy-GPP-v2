import type { ReactNode } from "react";

/** Chỗ trống của panel chi tiết khi chưa chọn dòng nào. */
export function PanelEmpty({ icon, title, description }: { icon: ReactNode; title: string; description?: string }) {
  return (
    <div className="panel-empty">
      <span className="panel-empty-icon" aria-hidden>
        {icon}
      </span>
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
    </div>
  );
}
