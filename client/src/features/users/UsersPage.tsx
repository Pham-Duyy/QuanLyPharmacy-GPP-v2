import {
  CalendarOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  LineChartOutlined,
  PlusOutlined,
  StarOutlined,
  TeamOutlined,
  UnorderedListOutlined,
  UserOutlined,
  UserSwitchOutlined,
} from "@ant-design/icons";
import { Alert, Button, Card, Empty, Segmented, Tabs } from "antd";
import { useState, type ReactNode } from "react";
import { PageHeader } from "../../ui/PageHeader.js";
import { useAuth } from "../auth/AuthProvider.js";
import { CreateStaffModal } from "./CreateStaffModal.js";
import { PayrollTab } from "./preview/PayrollTab.js";
import { PersonalView } from "./preview/PersonalView.js";
import { usePreview } from "./preview/preview-context.js";
import { PreviewProvider } from "./preview/preview-store.js";
import { PreviewStaffList } from "./preview/PreviewStaffList.js";
import { ReviewsTab } from "./preview/ReviewsTab.js";
import { SalesBonusTab } from "./preview/SalesBonusTab.js";
import { ScheduleTab } from "./preview/ScheduleTab.js";
import { StaffList } from "./StaffList.js";

type Mode = "live" | "preview";
type TabKey = "list" | "schedule" | "sales" | "payroll" | "reviews" | "personal";

const TABS: Array<{ key: TabKey; label: string; icon: ReactNode; previewOnly?: boolean }> = [
  { key: "list", label: "Danh sách", icon: <UnorderedListOutlined /> },
  { key: "schedule", label: "Lịch làm & chấm công", icon: <CalendarOutlined /> },
  { key: "sales", label: "Doanh số & thưởng", icon: <LineChartOutlined /> },
  { key: "payroll", label: "Bảng lương", icon: <FileTextOutlined /> },
  { key: "reviews", label: "Đánh giá & phát triển", icon: <StarOutlined /> },
  { key: "personal", label: "Góc nhìn nhân viên", icon: <UserOutlined />, previewOnly: true },
];

/** Những phần nhân sự chưa có API ở chế độ dữ liệu thật: nói rõ, không hiện số giả. */
const MISSING_API: Record<Exclude<TabKey, "list" | "personal">, string> = {
  schedule: "Lịch làm, chấm công và yêu cầu điều chỉnh công",
  sales: "Mục tiêu doanh số, chính sách và xét thưởng",
  payroll: "Kỳ lương, phiếu lương và trạng thái thanh toán",
  reviews: "Đánh giá tháng và đề xuất thăng chức",
};

/** Phân mục Nhân viên: tài khoản thật + bản xem trước các nghiệp vụ nhân sự chưa có backend. */
export function UsersPage() {
  return (
    <PreviewProvider>
      <StaffWorkspace />
    </PreviewProvider>
  );
}

function StaffWorkspace() {
  const { can } = useAuth();
  const { state } = usePreview();
  const [mode, setMode] = useState<Mode>("live");
  const [tab, setTab] = useState<TabKey>("list");
  const [liveSelected, setLiveSelected] = useState<string | null>(null);
  // Chọn nhân viên mẫu dùng chung giữa các tab xem trước, để đổi tab vẫn đúng người.
  const [previewSelected, setPreviewSelected] = useState(state.employees[0]!.id);
  const [creating, setCreating] = useState(false);

  const switchMode = (next: Mode) => {
    setMode(next);
    if (next === "live" && tab === "personal") setTab("list");
  };

  let content: ReactNode;
  if (mode === "live") {
    content =
      tab === "list" ? (
        <StaffList selectedId={liveSelected} onSelect={setLiveSelected} />
      ) : (
        <Card className="staff-card">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div className="staff-missing-api">
                <strong>Chưa có dữ liệu thật</strong>
                <span>
                  {MISSING_API[tab as keyof typeof MISSING_API]} chưa có API và nơi lưu trữ trong hệ
                  thống.
                </span>
              </div>
            }
          >
            <Button icon={<ExperimentOutlined />} onClick={() => switchMode("preview")}>
              Xem bản xem trước nhân sự
            </Button>
          </Empty>
        </Card>
      );
  } else {
    content = {
      list: (
        <PreviewStaffList
          selectedId={previewSelected}
          onSelect={setPreviewSelected}
          onOpenTab={(key) => setTab(key as TabKey)}
        />
      ),
      schedule: <ScheduleTab />,
      sales: <SalesBonusTab selectedId={previewSelected} onSelect={setPreviewSelected} />,
      payroll: (
        <PayrollTab
          onOpenBonus={(employeeId) => {
            setPreviewSelected(employeeId);
            setTab("sales");
          }}
        />
      ),
      reviews: <ReviewsTab selectedId={previewSelected} onSelect={setPreviewSelected} />,
      personal: <PersonalView viewerId={previewSelected} onViewerChange={setPreviewSelected} />,
    }[tab];
  }

  return (
    <div className="staff-workspace">
      <PageHeader
        icon={<UserSwitchOutlined />}
        title="Nhân viên"
        extra={
          <>
            <Segmented<Mode>
              aria-label="Nguồn dữ liệu"
              value={mode}
              onChange={switchMode}
              options={[
                { value: "live", label: "Dữ liệu thật", icon: <TeamOutlined /> },
                { value: "preview", label: "Bản xem trước nhân sự", icon: <ExperimentOutlined /> },
              ]}
            />
            {can("user.manage") ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                {mode === "live" ? "Thêm nhân viên" : "Thêm nhân viên mẫu"}
              </Button>
            ) : null}
          </>
        }
      />

      {mode === "preview" ? (
        <Alert
          type="warning"
          showIcon
          icon={<ExperimentOutlined />}
          className="staff-preview-banner"
          title="Bản xem trước nhân sự · Dữ liệu minh họa"
          description="Lịch làm, chấm công, thưởng, lương và đánh giá chưa có API. Mọi thao tác ở đây chỉ lưu trong trang này, không tạo tài khoản, không ghi lương hay quyền thật; tải lại trang sẽ đặt lại dữ liệu mẫu."
        />
      ) : null}

      <Tabs
        className="staff-tabs"
        activeKey={tab}
        onChange={(key) => setTab(key as TabKey)}
        items={TABS.filter((item) => mode === "preview" || !item.previewOnly).map((item) => ({
          key: item.key,
          label: (
            <span className="staff-tab-label">
              {item.icon} {item.label}
            </span>
          ),
          children: item.key === tab ? content : null,
        }))}
      />

      <CreateStaffModal
        open={creating}
        mode={mode}
        onClose={() => setCreating(false)}
        onCreated={(result) => {
          setCreating(false);
          setTab("list");
          if (result.mode === "live") setLiveSelected(result.user.id);
          else setPreviewSelected(result.id);
        }}
      />
    </div>
  );
}
