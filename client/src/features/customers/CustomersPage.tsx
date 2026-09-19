import { DownloadOutlined, FilterOutlined, PlusOutlined, SearchOutlined, ShoppingCartOutlined, TeamOutlined, UserAddOutlined, HistoryOutlined, InfoCircleOutlined } from "@ant-design/icons";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Badge, Button, Drawer, Empty, Grid, Input, Pagination, Popover, Result, Select, Skeleton, Tooltip } from "antd";
import { useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { getErrorMessage, http } from "../../api/http.js";
import type { CustomerListItem, CustomerSummary, Envelope, Paged } from "../../api/types.js";
import { formatDate } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";
import { CustomerFormModal } from "./customer-forms.js";
import { SEGMENT, avatarTone, initials, money } from "./customer-labels.js";
import { CustomerDetailPanel } from "./CustomerDetailPanel.js";

type Tab = "ALL" | "LOYAL" | "NEW" | "DORMANT";
type Sort = "createdAt" | "totalSpent" | "lastPurchaseAt" | "fullName";

const SORTS: Record<Sort, { label: string; order: "asc" | "desc" }> = {
  createdAt: { label: "Mới tạo gần đây", order: "desc" },
  totalSpent: { label: "Tổng mua cao nhất", order: "desc" },
  lastPurchaseAt: { label: "Mua gần đây nhất", order: "desc" },
  fullName: { label: "Tên A → Z", order: "asc" },
};

const PAGE_SIZE = 20;

/** Quản lý khách hàng (contract §11): danh sách toàn chuỗi, nhóm theo lịch sử mua, hồ sơ và chăm sóc. */
export function CustomersPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const screens = Grid.useBreakpoint();
  const wide = screens.xl ?? true;
  const compact = !(screens.md ?? true);
  const [params, setParams] = useSearchParams();
  const openId = params.get("id");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<Tab>("ALL");
  const [sort, setSort] = useState<Sort>("createdAt");
  const [page, setPage] = useState(1);
  const [filterOpen, setFilterOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const term = useDebounced(search.trim(), 300);

  function select(id: string | null) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id) next.set("id", id);
        else next.delete("id");
        return next;
      },
      { replace: true },
    );
  }

  const summary = useQuery({
    queryKey: ["customers", "summary"],
    queryFn: async () => (await http.get<Envelope<CustomerSummary>>("/customers/summary")).data.data,
  });

  const filters = { q: term || undefined, segment: tab === "ALL" ? undefined : tab, sortBy: sort, order: SORTS[sort].order };
  const list = useQuery({
    queryKey: ["customers", "list", filters, page],
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => (await http.get<Envelope<Paged<CustomerListItem>>>("/customers", { signal, params: { ...filters, page, limit: PAGE_SIZE } })).data.data,
  });

  async function refreshAll() {
    await queryClient.invalidateQueries({ queryKey: ["customers"] });
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const response = await http.get<Blob>("/customers/export", { params: { q: filters.q, segment: filters.segment }, responseType: "blob" });
      const url = URL.createObjectURL(response.data);
      const link = document.createElement("a");
      link.href = url;
      link.download = `khach-hang-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      void message.success("Đã xuất danh sách khách hàng");
    } catch (error) {
      void message.error(getErrorMessage(error, "Không xuất được danh sách"));
    } finally {
      setExporting(false);
    }
  }

  const rules = summary.data?.rules;
  const counts = summary.data?.segments;
  const tabs: Array<{ key: Tab; label: string; count?: number; hint?: string }> = [
    { key: "ALL", label: "Tất cả", count: summary.data?.total },
    { key: "LOYAL", label: "Khách thân thiết", count: counts?.LOYAL, hint: rules ? `Từ ${rules.loyalMinOrders} hóa đơn trong ${rules.loyalWindowDays} ngày gần nhất` : undefined },
    { key: "NEW", label: "Khách mới", count: counts?.NEW, hint: rules ? `Tạo hồ sơ trong ${rules.newWithinDays} ngày gần nhất` : undefined },
    { key: "DORMANT", label: "Lâu chưa quay lại", count: counts?.DORMANT, hint: rules ? `Lần mua cuối cách hơn ${rules.dormantAfterDays} ngày — nên gọi chăm sóc` : undefined },
  ];

  const stats: Array<{ key: string; label: string; value: number | undefined; icon: ReactNode; tone: string; tab?: Tab }> = [
    { key: "total", label: "Tổng khách hàng", value: summary.data?.total, icon: <TeamOutlined />, tone: "blue", tab: "ALL" },
    { key: "new", label: "Khách mới tháng này", value: summary.data?.newThisMonth, icon: <UserAddOutlined />, tone: "teal" },
    { key: "bought", label: "Đã mua trong 30 ngày", value: summary.data?.purchasedLast30Days, icon: <ShoppingCartOutlined />, tone: "green" },
    { key: "dormant", label: "Lâu chưa quay lại", value: counts?.DORMANT, icon: <HistoryOutlined />, tone: "orange", tab: "DORMANT" },
  ];

  const items = list.data?.items ?? [];
  const total = list.data?.pagination.total ?? 0;
  const hasFilters = Boolean(term) || tab !== "ALL";

  let body: ReactNode;
  if (list.isError && !list.data) {
    body = <Result status="warning" title="Không tải được danh sách khách hàng" subTitle={getErrorMessage(list.error, "Kiểm tra kết nối rồi thử lại.")} extra={<Button onClick={() => void list.refetch()}>Thử lại</Button>} />;
  } else if (list.isPending) {
    body = <Skeleton avatar active paragraph={{ rows: 6 }} />;
  } else if (items.length === 0) {
    body = hasFilters ? (
      <Empty className="product-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không có khách hàng phù hợp">
        <Button
          onClick={() => {
            setSearch("");
            setTab("ALL");
            setPage(1);
          }}
        >
          Xóa bộ lọc
        </Button>
      </Empty>
    ) : (
      <Empty className="product-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có khách hàng nào">
        {can("customer.manage") ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            Thêm khách hàng đầu tiên
          </Button>
        ) : null}
      </Empty>
    );
  } else {
    body = (
      <div className="cust-table" role="table" aria-label="Danh sách khách hàng">
        {compact ? null : (
          <div className="cust-table-head" role="row">
            <span role="columnheader">Khách hàng</span>
            <span role="columnheader">Liên hệ</span>
            <span role="columnheader" className="col-num">
              Tổng mua
            </span>
            <span role="columnheader" className="col-num">
              Lần mua cuối
            </span>
          </div>
        )}
        {items.map((row) => {
          const segment = SEGMENT[row.segment];
          return (
            <button
              key={row.id}
              type="button"
              role="row"
              className={row.id === openId ? "cust-row is-selected" : "cust-row"}
              aria-current={row.id === openId ? "true" : undefined}
              onClick={() => select(row.id)}
            >
              <span role="cell" className="cust-row-main">
                <span className={`cust-avatar tone-${avatarTone(row.code)}`} aria-hidden>
                  {initials(row.fullName)}
                </span>
                <span className="cust-row-text">
                  <strong>{row.fullName ?? "Khách chưa có tên"}</strong>
                  <span>
                    <span className="mono muted">{row.code}</span> <span className={`class-badge tone-${segment.tone}`}>{segment.label}</span>
                  </span>
                </span>
              </span>
              <span role="cell" className="mono cust-row-phone">
                {row.phone ?? <span className="muted">—</span>}
              </span>
              <span role="cell" className="col-num cust-row-money">
                {row.orderCount > 0 ? money(row.totalSpent) : <span className="muted">Chưa mua</span>}
                {row.orderCount > 0 ? <small className="muted">{row.orderCount} đơn</small> : null}
              </span>
              <span role="cell" className="col-num cust-row-date">
                {row.lastPurchaseAt ? formatDate(row.lastPurchaseAt) : <span className="muted">—</span>}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  const detail = openId ? <CustomerDetailPanel key={openId} customerId={openId} onClose={() => select(null)} onChanged={refreshAll} /> : null;

  return (
    <div>
      <PageHeader
        icon={<TeamOutlined />}
        title="Khách hàng"
        description="Thông tin liên hệ, lịch sử mua hàng và chăm sóc khách hàng"
        extra={
          <>
            {can("customer.sensitive") ? (
              <Tooltip title="Xuất CSV theo bộ lọc đang xem (có số điện thoại đầy đủ, được ghi nhật ký)">
                <Button icon={<DownloadOutlined />} loading={exporting} onClick={() => void exportCsv()}>
                  Xuất danh sách
                </Button>
              </Tooltip>
            ) : null}
            {can("customer.manage") ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                Thêm khách hàng
              </Button>
            ) : null}
          </>
        }
      />

      <div className="cust-stats">
        {stats.map((stat) => {
          const content = (
            <>
              <span className={`cust-stat-icon tone-${stat.tone}`} aria-hidden>
                {stat.icon}
              </span>
              <span className="cust-stat-text">
                <span>{stat.label}</span>
                <strong>{stat.value === undefined ? <Skeleton.Button active size="small" /> : stat.value.toLocaleString("vi-VN")}</strong>
              </span>
            </>
          );
          return stat.tab ? (
            <button
              key={stat.key}
              type="button"
              className="cust-stat is-clickable"
              onClick={() => {
                setTab(stat.tab!);
                setPage(1);
              }}
            >
              {content}
            </button>
          ) : (
            <div key={stat.key} className="cust-stat">
              {content}
            </div>
          );
        })}
      </div>

      <div className={detail && wide ? "cust-layout has-detail" : "cust-layout"}>
        <section className="cust-list-card" aria-label="Danh sách khách hàng">
          <h2 className="cust-list-title">Danh sách khách hàng</h2>
          <div className="cust-toolbar">
            <Input
              allowClear
              size="large"
              prefix={<SearchOutlined />}
              placeholder="Tìm tên, số điện thoại hoặc mã khách hàng"
              aria-label="Tìm khách hàng"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
            <Popover
              open={filterOpen}
              onOpenChange={setFilterOpen}
              trigger="click"
              placement="bottomRight"
              title="Bộ lọc"
              content={
                <div className="product-filter-panel">
                  <label>
                    <span>Sắp xếp</span>
                    <Select
                      value={sort}
                      onChange={(value) => {
                        setSort(value);
                        setPage(1);
                      }}
                      options={Object.entries(SORTS).map(([value, info]) => ({ value, label: info.label }))}
                    />
                  </label>
                  <div className="product-filter-actions">
                    <Button size="small" disabled={sort === "createdAt"} onClick={() => setSort("createdAt")}>
                      Đặt lại
                    </Button>
                    <Button size="small" type="primary" onClick={() => setFilterOpen(false)}>
                      Xong
                    </Button>
                  </div>
                </div>
              }
            >
              <Badge count={sort === "createdAt" ? 0 : 1} size="small">
                <Button size="large" icon={<FilterOutlined />}>
                  Bộ lọc
                </Button>
              </Badge>
            </Popover>
          </div>

          <div className="cust-tabs" role="tablist" aria-label="Nhóm khách hàng">
            {tabs.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={tab === item.key}
                title={item.hint}
                className={tab === item.key ? "cust-tab is-active" : "cust-tab"}
                onClick={() => {
                  setTab(item.key);
                  setPage(1);
                }}
              >
                {item.label}
                {item.count !== undefined ? ` (${item.count.toLocaleString("vi-VN")})` : ""}
              </button>
            ))}
          </div>
          {tab !== "ALL" ? (
            <p className="cust-rule">
              <InfoCircleOutlined /> {tabs.find((item) => item.key === tab)?.hint}
            </p>
          ) : null}

          <div className={list.isFetching && list.data ? "products-body is-refreshing" : "products-body"}>{body}</div>

          {total > 0 ? (
            <div className="products-footer">
              <span className="muted">
                Hiển thị {(page - 1) * PAGE_SIZE + 1} – {Math.min(total, page * PAGE_SIZE)} / {total.toLocaleString("vi-VN")} khách hàng
              </span>
              <Pagination size={compact ? "small" : "middle"} current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false} onChange={setPage} />
            </div>
          ) : null}
        </section>

        {detail && wide ? <aside className="cust-aside">{detail}</aside> : null}
      </div>

      {!wide ? (
        <Drawer open={Boolean(detail)} onClose={() => select(null)} placement="right" size={compact ? "100%" : 520} closable={false} rootClassName="product-drawer" styles={{ body: { padding: 0 } }} destroyOnHidden>
          {detail}
        </Drawer>
      ) : null}

      <CustomerFormModal
        open={creating}
        customer={null}
        onClose={() => setCreating(false)}
        onSaved={async (id) => {
          setCreating(false);
          await refreshAll();
          select(id);
        }}
      />
    </div>
  );
}
