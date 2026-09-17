import { FileTextOutlined, RightOutlined, SettingOutlined, ShoppingCartOutlined } from "@ant-design/icons";
import { Breadcrumb, Card } from "antd";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { confirmLeave } from "../../app/leave-guard.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { InvoiceTemplateSettings } from "./InvoiceTemplateSettings.js";

type SettingSection = { key: string; label: string; description: string; icon: ReactNode; render: () => ReactNode };
type SettingGroup = { key: string; label: string; icon: ReactNode; sections: SettingSection[] };

/**
 * Chỉ liệt kê những cài đặt đã làm thật. Thêm nhóm/mục mới vào đây khi có
 * chức năng tương ứng — không dựng mục trống cho đẹp menu.
 */
const GROUPS: SettingGroup[] = [
  {
    key: "ban-hang",
    label: "Bán hàng & hóa đơn",
    icon: <ShoppingCartOutlined />,
    sections: [
      {
        key: "mau-in-hoa-don",
        label: "Mẫu in hóa đơn",
        description: "Thông tin cố định, khổ giấy và nội dung hiển thị khi in hóa đơn bán lẻ",
        icon: <FileTextOutlined />,
        render: () => <InvoiceTemplateSettings />,
      },
    ],
  },
];

const ALL = GROUPS.flatMap((group) => group.sections.map((section) => ({ group, section })));

/** Cài đặt cửa hàng (chỉ người có quyền `settings.manage`). */
export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const active = ALL.find((entry) => entry.section.key === params.get("muc")) ?? ALL[0]!;

  return (
    <div>
      <PageHeader icon={<SettingOutlined />} title="Cài đặt" description="Thiết lập áp dụng cho cửa hàng (chi nhánh) đang làm việc." />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Danh mục cài đặt">
          <Card size="small">
            {GROUPS.map((group) => (
              <div key={group.key} className="settings-nav-group">
                <div className="settings-nav-title">
                  {group.icon} {group.label}
                </div>
                <ul>
                  {group.sections.map((section) => (
                    <li key={section.key}>
                      <button
                        type="button"
                        className={section.key === active.section.key ? "settings-nav-item active" : "settings-nav-item"}
                        aria-current={section.key === active.section.key ? "page" : undefined}
                        onClick={() => {
                          if (section.key !== active.section.key) {
                            confirmLeave(() => setParams({ muc: section.key }));
                          }
                        }}
                      >
                        {section.icon}
                        <span>
                          <strong>{section.label}</strong>
                          <small>{section.description}</small>
                        </span>
                        <RightOutlined className="settings-nav-arrow" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Card>
        </nav>
        <section className="settings-content" aria-label={active.section.label}>
          <Breadcrumb
            className="settings-breadcrumb"
            items={[{ title: "Cài đặt" }, { title: active.group.label }, { title: active.section.label }]}
          />
          {active.section.render()}
        </section>
      </div>
    </div>
  );
}
