import type { ReactNode } from "react";

type PageHeaderProps = {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Nút thao tác chính, bộ lọc kỳ… căn phải, tự xuống dòng trên màn hẹp. */
  extra?: ReactNode;
};

export function PageHeader({ icon, title, description, extra }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        {icon ? (
          <span className="page-header-icon" aria-hidden>
            {icon}
          </span>
        ) : null}
        <div className="page-header-text">
          <h1 className="page-header-title">{title}</h1>
          {description ? <p className="page-header-desc">{description}</p> : null}
        </div>
      </div>
      {extra ? <div className="page-header-extra">{extra}</div> : null}
    </header>
  );
}
