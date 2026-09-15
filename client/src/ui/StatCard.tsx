import { ArrowDownOutlined, ArrowUpOutlined } from "@ant-design/icons";
import { Skeleton } from "antd";
import type { ReactNode } from "react";

export type Tone = "blue" | "green" | "orange" | "purple" | "red" | "cyan" | "slate";

type StatCardProps = {
  icon: ReactNode;
  label: ReactNode;
  value: ReactNode;
  /** Dòng phụ bên dưới giá trị: xu hướng, ghi chú phạm vi dữ liệu… */
  hint?: ReactNode;
  tone?: Tone;
  loading?: boolean;
};

export function StatCard({ icon, label, value, hint, tone = "blue", loading = false }: StatCardProps) {
  return (
    <div className={`stat-card tone-${tone}`}>
      <span className="stat-card-icon" aria-hidden>
        {icon}
      </span>
      <div className="stat-card-body">
        <span className="stat-card-label">{label}</span>
        {loading ? (
          <Skeleton.Input active size="small" className="stat-card-skeleton" />
        ) : (
          <strong className="stat-card-value">{value}</strong>
        )}
        {hint ? <span className="stat-card-hint">{hint}</span> : null}
      </div>
    </div>
  );
}

/** Mũi tên tăng/giảm có màu; null nghĩa là chưa có kỳ trước để so. */
export function Trend({ value, suffix }: { value: number | null | undefined; suffix: string }) {
  if (value === null || value === undefined) return <span className="trend trend-none">Chưa có số liệu so sánh</span>;
  const down = value < 0;
  return (
    <span className={down ? "trend trend-down" : "trend trend-up"}>
      {down ? <ArrowDownOutlined /> : <ArrowUpOutlined />} {Math.abs(value).toLocaleString("vi-VN")}% {suffix}
    </span>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="stat-grid">{children}</div>;
}
