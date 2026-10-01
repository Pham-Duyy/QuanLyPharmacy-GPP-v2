import {
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  FileTextOutlined,
  LineChartOutlined,
  RightOutlined,
  SearchOutlined,
  TeamOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Card, Drawer, Empty, Grid, Input, Select, Table } from "antd";
import { useMemo, useState } from "react";
import { foldText } from "../../../app/fold-text.js";
import {
  AccountStatus,
  Pairs,
  PersonCell,
  StaffAvatar,
  StaffNote,
  StaffStat,
} from "../staff-ui.js";
import { WORK_STATUS_LABEL } from "./preview-logic.js";
import { usePreview } from "./preview-context.js";
import type { PreviewEmployee } from "./preview-types.js";
import { formatDay, storeShort } from "./preview-format.js";
import { SampleTag, WorkStatusTag } from "./preview-ui.js";
import { PreviewProfileDrawer } from "./PreviewProfile.js";

type Props = {
  selectedId: string;
  onSelect: (id: string) => void;
  onOpenTab: (tab: string) => void;
};

/** Danh sách nhân viên MẪU: có chức danh, mã, tình trạng làm việc — những thứ API thật chưa có. */
export function PreviewStaffList({ selectedId, onSelect, onOpenTab }: Props) {
  const { state } = usePreview();
  const screens = Grid.useBreakpoint();
  const [search, setSearch] = useState("");
  const [store, setStore] = useState("all");
  const [title, setTitle] = useState("all");
  const [work, setWork] = useState("all");
  const [profileOpen, setProfileOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  const titles = [...new Set(state.employees.map((employee) => employee.title))];
  const rows = useMemo(() => {
    const term = foldText(search.trim());
    return state.employees.filter(
      (employee) =>
        (!term ||
          foldText(`${employee.fullName} ${employee.code} ${employee.username}`).includes(term)) &&
        (store === "all" || employee.storeId === store) &&
        (title === "all" || employee.title === title) &&
        (work === "all" || employee.workStatus === work),
    );
  }, [state.employees, search, store, title, work]);

  const selected =
    state.employees.find((employee) => employee.id === selectedId) ?? state.employees[0]!;
  const pendingReviews = state.employees.filter(
    (employee) =>
      !state.reviews.some(
        (review) => review.employeeId === employee.id && review.status === "done",
      ),
  ).length;
  const asDrawer = !screens.xl;
  const select = (employee: PreviewEmployee) => {
    onSelect(employee.id);
    if (asDrawer) setPanelOpen(true);
  };

  const panel = (
    <div className="staff-quick">
      <div className="staff-quick-head">
        <StaffAvatar name={selected.fullName} id={selected.id} size="lg" />
        <div>
          <h3>{selected.fullName}</h3>
          <span className="staff-mono">{selected.code}</span>
          <WorkStatusTag status={selected.workStatus} />
          <small>
            {selected.title} · {storeShort(state, selected.storeId)}
          </small>
        </div>
      </div>
      <nav className="staff-shortcuts" aria-label="Lối tắt hồ sơ">
        <button type="button" onClick={() => setProfileOpen(true)}>
          <UserOutlined aria-hidden />
          <span>
            <strong>Hồ sơ nhân viên</strong>
            <small>Thông tin cá nhân, tài khoản, lịch sử</small>
          </span>
          <RightOutlined aria-hidden />
        </button>
        <button type="button" onClick={() => onOpenTab("sales")}>
          <LineChartOutlined aria-hidden />
          <span>
            <strong>Doanh số cá nhân</strong>
            <small>Doanh số và xét thưởng trong kỳ</small>
          </span>
          <RightOutlined aria-hidden />
        </button>
        <button type="button" onClick={() => onOpenTab("schedule")}>
          <CalendarOutlined aria-hidden />
          <span>
            <strong>Lịch làm việc</strong>
            <small>Ca làm, chấm công và yêu cầu điều chỉnh</small>
          </span>
          <RightOutlined aria-hidden />
        </button>
      </nav>
      <h4>Thông tin chung</h4>
      <Pairs
        items={[
          ["Mã nhân viên", selected.code],
          ["Chức danh", selected.title],
          ["Cửa hàng", state.stores.find((item) => item.id === selected.storeId)?.name ?? "—"],
          ["Vai trò truy cập", selected.accessRole],
          ["Tình trạng làm việc", <WorkStatusTag key="w" status={selected.workStatus} />],
          ["Tài khoản", <AccountStatus key="a" active={selected.accountActive} />],
          ["Ngày vào làm", formatDay(selected.joinedAt)],
        ]}
      />
      <StaffNote>Lương chỉ hiển thị với người có quyền.</StaffNote>
    </div>
  );

  return (
    <>
      <div className="staff-stats">
        <StaffStat icon={<TeamOutlined />} value={state.employees.length} label="Nhân viên" />
        <StaffStat
          icon={<CheckCircleOutlined />}
          tone="green"
          value={state.employees.filter((item) => item.workStatus !== "on_leave").length}
          label="Đang làm việc"
        />
        <StaffStat
          icon={<ClockCircleOutlined />}
          tone="orange"
          value={state.employees.filter((item) => item.workStatus === "on_leave").length}
          label="Tạm nghỉ"
        />
        <StaffStat
          icon={<FileTextOutlined />}
          tone="purple"
          value={pendingReviews}
          label="Chờ đánh giá"
        />
      </div>
      <div className={asDrawer ? "" : "staff-split"}>
        <Card className="staff-card">
          <div className="staff-toolbar" role="search">
            <Input
              allowClear
              prefix={<SearchOutlined aria-hidden />}
              aria-label="Tìm nhân viên mẫu"
              placeholder="Tìm theo tên, mã hoặc tên đăng nhập"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Select
              aria-label="Lọc cửa hàng"
              value={store}
              onChange={setStore}
              options={[
                { value: "all", label: "Tất cả cửa hàng" },
                ...state.stores.map((item) => ({ value: item.id, label: item.short })),
              ]}
            />
            <Select
              aria-label="Lọc chức danh"
              value={title}
              onChange={setTitle}
              options={[
                { value: "all", label: "Tất cả chức danh" },
                ...titles.map((value) => ({ value, label: value })),
              ]}
            />
            <Select
              aria-label="Lọc tình trạng làm việc"
              value={work}
              onChange={setWork}
              options={[
                { value: "all", label: "Tất cả tình trạng" },
                ...Object.entries(WORK_STATUS_LABEL).map(([value, label]) => ({ value, label })),
              ]}
            />
          </div>
          <Table<PreviewEmployee>
            rowKey="id"
            className="staff-table"
            dataSource={rows}
            scroll={{ x: 900 }}
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
            rowClassName={(row) => (row.id === selected.id ? "staff-row-selected" : "")}
            onRow={(row) => ({
              onClick: () => select(row),
              onKeyDown: (event) => event.key === "Enter" && select(row),
              tabIndex: 0,
              "aria-selected": row.id === selected.id,
            })}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="Không có nhân viên khớp bộ lọc"
                />
              ),
            }}
            columns={[
              {
                title: "Nhân viên",
                key: "person",
                fixed: "left",
                width: 220,
                render: (_, row) => <PersonCell name={row.fullName} id={row.id} sub={row.code} />,
              },
              { title: "Chức danh", dataIndex: "title", width: 150 },
              {
                title: "Cửa hàng",
                key: "store",
                width: 110,
                render: (_, row) => storeShort(state, row.storeId),
              },
              { title: "Vai trò truy cập", dataIndex: "accessRole", width: 140 },
              {
                title: "Tình trạng làm việc",
                key: "work",
                width: 160,
                render: (_, row) => <WorkStatusTag status={row.workStatus} />,
              },
              {
                title: "Tài khoản",
                key: "account",
                width: 150,
                render: (_, row) => <AccountStatus active={row.accountActive} />,
              },
            ]}
          />
          <div className="staff-table-footer">
            <span>
              Hiển thị {rows.length} / {state.employees.length} nhân viên
            </span>
            <SampleTag />
          </div>
        </Card>
        {asDrawer ? (
          <Drawer open={panelOpen} onClose={() => setPanelOpen(false)} title="Thông tin nhân viên">
            {panel}
          </Drawer>
        ) : (
          <Card className="staff-card staff-aside" title="Thông tin nhân viên">
            {panel}
          </Card>
        )}
      </div>
      <PreviewProfileDrawer
        employeeId={selected.id}
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
      />
    </>
  );
}
