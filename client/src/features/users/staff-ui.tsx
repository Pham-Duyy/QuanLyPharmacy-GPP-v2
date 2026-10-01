import { InfoCircleOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";
import { avatarTone, initials } from "./staff-format.js";

/** Avatar viết tắt tên, màu cố định theo người. */
export function StaffAvatar({
  name,
  id,
  size = "md",
}: {
  name: string;
  id: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span className={`staff-avatar staff-avatar-${size} tone-${avatarTone(id)}`} aria-hidden>
      {initials(name)}
    </span>
  );
}

export function PersonCell({ name, id, sub }: { name: string; id: string; sub?: ReactNode }) {
  return (
    <div className="staff-person">
      <StaffAvatar name={name} id={id} />
      <div className="staff-person-text">
        <strong>{name}</strong>
        {sub ? <small>{sub}</small> : null}
      </div>
    </div>
  );
}

export type DotTone = "green" | "orange" | "red" | "blue" | "purple" | "slate";

/** Nhãn trạng thái có chấm màu và chữ giải thích — không dựa vào màu đơn thuần. */
export function StatusDot({ tone, children }: { tone: DotTone; children: ReactNode }) {
  return <span className={`staff-status tone-${tone}`}>{children}</span>;
}

export function AccountStatus({ active }: { active: boolean }) {
  return active ? (
    <StatusDot tone="green">Đang hoạt động</StatusDot>
  ) : (
    <StatusDot tone="red">Đã khóa</StatusDot>
  );
}

/** Danh sách nhãn – giá trị hai cột. */
export function Pairs({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="staff-pairs">
      {items.map(([label, value], index) => (
        <div key={index}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function StaffStat({
  icon,
  label,
  value,
  hint,
  tone = "blue",
}: {
  icon: ReactNode;
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "blue" | "green" | "orange" | "purple" | "red";
}) {
  return (
    <div className={`staff-stat tone-${tone}`}>
      <span className="staff-stat-icon" aria-hidden>
        {icon}
      </span>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
        {hint ? <small>{hint}</small> : null}
      </div>
    </div>
  );
}

/** Ghi chú nhỏ màu xanh, dùng cho các lưu ý nghiệp vụ ngắn. */
export function StaffNote({ children }: { children: ReactNode }) {
  return (
    <p className="staff-note">
      <InfoCircleOutlined aria-hidden /> <span>{children}</span>
    </p>
  );
}
