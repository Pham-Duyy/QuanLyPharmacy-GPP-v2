import {
  CheckCircleOutlined,
  EyeOutlined,
  LockOutlined,
  SearchOutlined,
  TeamOutlined,
  UserDeleteOutlined,
} from "@ant-design/icons";
import { Button, Card, Drawer, Empty, Grid, Input, Result, Select, Table, Tag } from "antd";
import { useMemo, useState } from "react";
import { getErrorMessage } from "../../api/http.js";
import type { UserListItem } from "../../api/types.js";
import { foldText } from "../../app/fold-text.js";
import { useRoles, useStaffList, useStores } from "./staff-api.js";
import { CHAIN_SCOPE } from "./staff-scope.js";
import { AccountStatus, PersonCell, StaffNote, StaffStat } from "./staff-ui.js";
import { StaffProfile } from "./StaffProfile.js";

type Filters = { search: string; scope: string; role: string; status: "all" | "active" | "locked" };
const NO_FILTER: Filters = { search: "", scope: "all", role: "all", status: "all" };

/** Danh sách nhân viên bằng dữ liệu thật của API tài khoản (contract §21). */
export function StaffList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const screens = Grid.useBreakpoint();
  const asDrawer = !screens.xl;
  const list = useStaffList();
  const stores = useStores();
  const roles = useRoles();
  const [filters, setFilters] = useState<Filters>(NO_FILTER);
  const [page, setPage] = useState({ current: 1, size: 20 });

  const storeName = useMemo(
    () => new Map((stores.data ?? []).map((store) => [store.id, store.name])),
    [stores.data],
  );
  const all = useMemo(() => list.data ?? [], [list.data]);

  const rows = useMemo(() => {
    const term = foldText(filters.search.trim());
    return all.filter((user) => {
      if (term && !foldText(`${user.fullName} ${user.username}`).includes(term)) return false;
      if (filters.status !== "all" && user.isActive !== (filters.status === "active")) return false;
      if (filters.role !== "all" && !user.roles.some((role) => role.roleCode === filters.role))
        return false;
      if (
        filters.scope !== "all" &&
        !user.roles.some((role) =>
          filters.scope === CHAIN_SCOPE ? role.storeId === null : role.storeId === filters.scope,
        )
      )
        return false;
      return true;
    });
  }, [all, filters]);

  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTER);
  const setFilter = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage((current) => ({ ...current, current: 1 }));
  };

  const scopesOf = (user: UserListItem) => {
    const names = [
      ...new Set(
        user.roles.map((role) =>
          role.storeId ? (storeName.get(role.storeId) ?? "Cửa hàng khác") : "Toàn chuỗi",
        ),
      ),
    ];
    return names.length ? names.join(", ") : "—";
  };

  const start = rows.length ? (page.current - 1) * page.size + 1 : 0;
  const end = Math.min(page.current * page.size, rows.length);

  let body;
  if (list.isError) {
    // Không thay bằng dữ liệu mẫu khi API lỗi.
    body = (
      <Result
        status="warning"
        title="Không tải được danh sách nhân viên"
        subTitle={getErrorMessage(list.error, "Kiểm tra kết nối rồi thử lại.")}
        extra={<Button onClick={() => void list.refetch()}>Thử lại</Button>}
      />
    );
  } else {
    body = (
      <>
        <div className="staff-toolbar" role="search">
          <Input
            allowClear
            prefix={<SearchOutlined aria-hidden />}
            placeholder="Tìm theo họ tên hoặc tên đăng nhập"
            aria-label="Tìm nhân viên"
            value={filters.search}
            onChange={(event) => setFilter({ search: event.target.value })}
          />
          <Select
            aria-label="Lọc cửa hàng"
            value={filters.scope}
            onChange={(scope) => setFilter({ scope })}
            options={[
              { value: "all", label: "Tất cả cửa hàng" },
              { value: CHAIN_SCOPE, label: "Toàn chuỗi" },
              ...(stores.data ?? []).map((store) => ({ value: store.id, label: store.name })),
            ]}
          />
          <Select
            aria-label="Lọc vai trò"
            value={filters.role}
            onChange={(role) => setFilter({ role })}
            options={[
              { value: "all", label: "Tất cả vai trò" },
              ...(roles.data ?? []).map((role) => ({ value: role.code, label: role.name })),
            ]}
          />
          <Select
            aria-label="Lọc trạng thái tài khoản"
            value={filters.status}
            onChange={(status) => setFilter({ status })}
            options={[
              { value: "all", label: "Tất cả trạng thái" },
              { value: "active", label: "Đang hoạt động" },
              { value: "locked", label: "Đã khóa" },
            ]}
          />
        </div>
        <Table<UserListItem>
          rowKey="id"
          className="staff-table"
          loading={list.isLoading}
          dataSource={rows}
          scroll={{ x: 740 }}
          rowClassName={(row) => (row.id === selectedId ? "staff-row-selected" : "")}
          onRow={(row) => ({
            onClick: () => onSelect(row.id),
            onKeyDown: (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(row.id);
              }
            },
            tabIndex: 0,
            "aria-selected": row.id === selectedId,
          })}
          pagination={{
            current: page.current,
            pageSize: page.size,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50],
            locale: { items_per_page: "/ trang" },
            hideOnSinglePage: rows.length <= 10,
            onChange: (current, size) =>
              setPage({ current: size === page.size ? current : 1, size }),
          }}
          locale={{
            emptyText: list.isLoading ? (
              " "
            ) : filtered ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Không có nhân viên khớp bộ lọc"
              >
                <Button onClick={() => setFilter(NO_FILTER)}>Xóa bộ lọc</Button>
              </Empty>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có nhân viên nào" />
            ),
          }}
          columns={[
            {
              title: "Nhân viên",
              key: "person",
              fixed: "left",
              width: 210,
              render: (_, row) => (
                <PersonCell name={row.fullName} id={row.id} sub={`@${row.username}`} />
              ),
            },
            { title: "Cửa hàng", key: "store", width: 150, render: (_, row) => scopesOf(row) },
            {
              title: "Vai trò truy cập",
              key: "roles",
              width: 170,
              render: (_, row) =>
                row.roles.length === 0 ? (
                  <span className="staff-muted">Chưa gán</span>
                ) : (
                  [...new Set(row.roles.map((role) => role.roleName))].map((name) => (
                    <Tag key={name} className="staff-role-tag">
                      {name}
                    </Tag>
                  ))
                ),
            },
            {
              title: "Trạng thái tài khoản",
              key: "status",
              width: 150,
              render: (_, row) => <AccountStatus active={row.isActive} />,
            },
            {
              title: "Thao tác",
              key: "actions",
              width: 64,
              align: "center",
              render: (_, row) => (
                <Button
                  type="text"
                  icon={<EyeOutlined />}
                  aria-label={`Xem hồ sơ ${row.fullName}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(row.id);
                  }}
                />
              ),
            },
          ]}
        />
        <div className="staff-table-footer">
          <span>
            {rows.length ? `Hiển thị ${start}–${end} của ${rows.length} nhân viên` : null}
          </span>
        </div>
        <StaffNote>
          Chức danh, mã nhân viên và tình trạng làm việc chưa có trong dữ liệu hệ thống; phần này
          hiện chỉ có ở Bản xem trước nhân sự.
        </StaffNote>
      </>
    );
  }

  const profile = <StaffProfile id={selectedId} onClose={() => onSelect(null)} />;

  return (
    <>
      <div className="staff-stats">
        <StaffStat
          icon={<TeamOutlined />}
          value={list.isLoading ? "…" : all.length}
          label="Tài khoản nhân viên"
        />
        <StaffStat
          icon={<CheckCircleOutlined />}
          tone="green"
          value={list.isLoading ? "…" : all.filter((user) => user.isActive).length}
          label="Đang hoạt động"
        />
        <StaffStat
          icon={<LockOutlined />}
          tone="red"
          value={list.isLoading ? "…" : all.filter((user) => !user.isActive).length}
          label="Đã khóa"
        />
        <StaffStat
          icon={<UserDeleteOutlined />}
          tone="orange"
          value={list.isLoading ? "…" : all.filter((user) => user.roles.length === 0).length}
          label="Chưa gán vai trò"
        />
      </div>
      <div className={asDrawer ? "" : "staff-split"}>
        <Card className="staff-card">{body}</Card>
        {asDrawer ? (
          <Drawer
            open={selectedId !== null}
            onClose={() => onSelect(null)}
            title="Hồ sơ nhân viên"
            size={screens.md ? "large" : "default"}
            closable={false}
            styles={{ body: { paddingTop: 8 } }}
          >
            {profile}
          </Drawer>
        ) : (
          <Card className="staff-card staff-aside" title="Thông tin nhân viên">
            {profile}
          </Card>
        )}
      </div>
    </>
  );
}
