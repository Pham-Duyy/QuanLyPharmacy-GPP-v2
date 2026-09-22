import { AppstoreOutlined, FilterOutlined, MedicineBoxOutlined, PlusOutlined, SearchOutlined, UnorderedListOutlined, WarningFilled } from "@ant-design/icons";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Drawer, Empty, Grid, Input, Pagination, Popover, Result, Select, Skeleton, Switch, Tooltip } from "antd";
import { useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { getErrorMessage, http } from "../../api/http.js";
import type { CategoryItem, Envelope, Paged, ProductListItem } from "../../api/types.js";
import { ExcelMenuButton } from "../excel/ExcelButtons.js";
import { ExcelImportModal } from "../excel/ExcelImportModal.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useDebounced } from "../../ui/useDebounced.js";
import { useAuth } from "../auth/AuthProvider.js";
import { ClassBadge } from "./products/ClassBadge.js";
import { priceText, stockText, subtitle } from "./products/product-labels.js";
import { ProductDetailPanel } from "./products/ProductDetailPanel.js";
import { ProductFormModal } from "./products/ProductModals.js";
import { ProductThumb } from "./products/ProductThumb.js";

type Tab = "ALL" | "RX" | "OTC" | "SUPPLEMENT" | "MEDICAL_DEVICE";
type View = "list" | "grid";
type Sort = "name" | "code" | "newest";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "ALL", label: "Tất cả" },
  { key: "RX", label: "Kê đơn" },
  { key: "OTC", label: "Không kê đơn" },
  { key: "SUPPLEMENT", label: "TPCN" },
  { key: "MEDICAL_DEVICE", label: "Thiết bị y tế" },
];

const TAB_PARAMS: Record<Tab, Record<string, string>> = {
  ALL: {},
  // "Kê đơn" gồm cả thuốc kiểm soát đặc biệt — đều phải có đơn.
  RX: { productType: "DRUG", drugClass: "RX,CONTROLLED" },
  OTC: { productType: "DRUG", drugClass: "OTC" },
  SUPPLEMENT: { productType: "SUPPLEMENT" },
  MEDICAL_DEVICE: { productType: "MEDICAL_DEVICE" },
};

const SORTS: Record<Sort, { label: string; sortBy: string; order: "asc" | "desc" }> = {
  name: { label: "Tên A → Z", sortBy: "name", order: "asc" },
  code: { label: "Mã sản phẩm", sortBy: "code", order: "asc" },
  newest: { label: "Mới thêm gần đây", sortBy: "createdAt", order: "desc" },
};

const PAGE_SIZE = 20;
const VIEW_KEY = "gpp.products.view";

function readView(): View {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

function PriceCell({ item }: { item: ProductListItem }) {
  const text = priceText(item.currentPrice?.salePrice, item.defaultUnit?.name);
  if (!item.defaultUnit) return <span className="muted">Chưa có đơn vị bán</span>;
  return text ? <span className="price-text">{text}</span> : <span className="muted">Chưa đặt giá</span>;
}

function StockCell({ item }: { item: ProductListItem }) {
  if (!item.stock) return <span className="muted">—</span>;
  const quantity = item.stock.sellable;
  return (
    <span className="stock-cell">
      <strong className={quantity === 0 || item.isBelowMinStock ? "is-warning" : undefined}>{stockText(quantity, item.baseUnit?.name)}</strong>
      {quantity === 0 ? (
        <span className="stock-flag">
          <WarningFilled aria-hidden /> Hết hàng
        </span>
      ) : item.isBelowMinStock ? (
        <span className="stock-flag">
          <WarningFilled aria-hidden /> Tồn thấp
        </span>
      ) : null}
    </span>
  );
}

/** Danh mục dùng chung toàn chuỗi. Tồn kho hiển thị theo cửa hàng đang chọn. */
export function ProductsPage() {
  const { can, storeId, me } = useAuth();
  const screens = Grid.useBreakpoint();
  const wide = screens.xl ?? true;
  const compact = !(screens.md ?? true);
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<Tab>("ALL");
  const [active, setActive] = useState(true);
  const [categoryId, setCategoryId] = useState<string | undefined>();
  const [sort, setSort] = useState<Sort>("name");
  const [view, setViewState] = useState<View>(readView);
  const [page, setPage] = useState(1);
  const [filterOpen, setFilterOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const queryClient = useQueryClient();
  const term = useDebounced(search.trim(), 300);
  // Sản phẩm đang xem nằm trên URL để mở thẳng từ ô tìm nhanh và gửi link được.
  const selectedId = params.get("id");
  const storeName = me?.stores.find((store) => store.id === storeId)?.name;

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

  function setView(next: View) {
    setViewState(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Không lưu được thì chỉ mất lựa chọn ở lần mở sau.
    }
  }

  const categories = useQuery({
    queryKey: ["product-categories"],
    queryFn: async () => (await http.get<Envelope<Paged<CategoryItem>>>("/categories", { params: { limit: 100 } })).data.data.items,
    staleTime: 5 * 60_000,
  });

  const filterKey = { term, tab, active, categoryId, sort, page };
  const products = useQuery({
    // storeId nằm trong khóa: tồn kho thuộc về cửa hàng đang chọn.
    queryKey: ["products-page", storeId, filterKey],
    queryFn: async ({ signal }) =>
      (
        await http.get<Envelope<Paged<ProductListItem>>>("/products", {
          signal,
          params: {
            search: term || undefined,
            page,
            limit: PAGE_SIZE,
            isActive: active,
            categoryId,
            sortBy: SORTS[sort].sortBy,
            order: SORTS[sort].order,
            ...TAB_PARAMS[tab],
          },
        })
      ).data.data,
    // Giữ kết quả cũ khi đổi trang/bộ lọc cho mượt, nhưng KHÔNG giữ qua khi đổi cửa hàng
    // để không hiện tồn của cửa hàng cũ.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === storeId ? keepPreviousData(previous) : undefined),
  });

  const filterCount = (categoryId ? 1 : 0) + (sort !== "name" ? 1 : 0);
  const hasFilters = Boolean(term) || tab !== "ALL" || !active || filterCount > 0;
  const items = products.data?.items ?? [];
  const total = products.data?.pagination.total ?? 0;
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);

  function resetFilters() {
    setSearch("");
    setTab("ALL");
    setActive(true);
    setCategoryId(undefined);
    setSort("name");
    setPage(1);
  }

  const filterPanel = (
    <div className="product-filter-panel">
      <label>
        <span>Nhóm hàng</span>
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Tất cả nhóm hàng"
          loading={categories.isLoading}
          value={categoryId}
          onChange={(value) => {
            setCategoryId(value);
            setPage(1);
          }}
          options={categories.data?.map((item) => ({ value: item.id, label: item.name }))}
        />
      </label>
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
        <Button
          size="small"
          disabled={filterCount === 0}
          onClick={() => {
            setCategoryId(undefined);
            setSort("name");
            setPage(1);
          }}
        >
          Đặt lại
        </Button>
        <Button size="small" type="primary" onClick={() => setFilterOpen(false)}>
          Xong
        </Button>
      </div>
    </div>
  );

  let body: ReactNode;
  if (products.isError && !products.data) {
    body = <Result status="warning" title="Không tải được danh mục" subTitle={getErrorMessage(products.error, "Kiểm tra kết nối rồi thử lại.")} extra={<Button onClick={() => void products.refetch()}>Thử lại</Button>} />;
  } else if (products.isPending) {
    body = (
      <div className="product-skeleton" aria-busy="true" aria-label="Đang tải danh mục">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="product-skeleton-row">
            <Skeleton.Avatar active shape="square" size={56} />
            <Skeleton active title={false} paragraph={{ rows: 2, width: ["60%", "35%"] }} />
          </div>
        ))}
      </div>
    );
  } else if (items.length === 0) {
    body = hasFilters ? (
      <Empty className="product-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description="Không tìm thấy sản phẩm phù hợp">
        <Button onClick={resetFilters}>Xóa bộ lọc</Button>
      </Empty>
    ) : (
      <Empty className="product-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description="Danh mục chưa có sản phẩm">
        {can("catalog.manage") ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            Thêm sản phẩm đầu tiên
          </Button>
        ) : null}
      </Empty>
    );
  } else if (view === "grid") {
    body = (
      <ul className="product-grid">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" className={item.id === selectedId ? "product-card is-selected" : "product-card"} aria-pressed={item.id === selectedId} onClick={() => select(item.id)}>
              <ProductThumb src={item.primaryImage?.thumbUrl} alt={item.name} size={120} className="product-card-image" />
              <span className="product-card-name">{item.name}</span>
              <span className="product-card-code mono">{item.code}</span>
              <ClassBadge productType={item.productType} drugClass={item.drugClass} />
              <span className="product-card-foot">
                <PriceCell item={item} />
                <StockCell item={item} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  } else if (compact) {
    body = (
      <ul className="product-cards">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" className={item.id === selectedId ? "product-row-card is-selected" : "product-row-card"} aria-pressed={item.id === selectedId} onClick={() => select(item.id)}>
              <ProductThumb src={item.primaryImage?.thumbUrl} alt={item.name} size={64} />
              <span className="product-row-card-main">
                <strong>{item.name}</strong>
                <span className="muted">{subtitle(item)}</span>
                <ClassBadge productType={item.productType} drugClass={item.drugClass} />
                <span className="product-row-card-foot">
                  <PriceCell item={item} />
                  <StockCell item={item} />
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <div className="product-table" role="table" aria-label="Danh sách sản phẩm">
        <div className="product-table-head" role="row">
          <span role="columnheader">Sản phẩm</span>
          <span role="columnheader" className="col-class">
            Phân loại
          </span>
          <span role="columnheader" className="col-num">
            Giá bán
          </span>
          <span role="columnheader" className="col-num">
            Tồn bán được
          </span>
        </div>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="row"
            className={item.id === selectedId ? "product-table-row is-selected" : "product-table-row"}
            aria-current={item.id === selectedId ? "true" : undefined}
            onClick={() => select(item.id)}
          >
            <span role="cell" className="product-cell-main">
              <ProductThumb src={item.primaryImage?.thumbUrl} alt={item.name} size={56} />
              <span className="product-cell-text">
                <strong>{item.name}</strong>
                <span className="muted">{subtitle(item)}</span>
                <span className="product-cell-badge-inline">
                  <ClassBadge productType={item.productType} drugClass={item.drugClass} />
                </span>
              </span>
            </span>
            <span role="cell" className="col-class">
              <ClassBadge productType={item.productType} drugClass={item.drugClass} />
            </span>
            <span role="cell" className="col-num">
              <PriceCell item={item} />
            </span>
            <span role="cell" className="col-num">
              <StockCell item={item} />
            </span>
          </button>
        ))}
      </div>
    );
  }

  const detail = selectedId ? <ProductDetailPanel key={selectedId} id={selectedId} onClose={() => select(null)} /> : null;

  return (
    <div>
      <PageHeader
        icon={<MedicineBoxOutlined />}
        title="Thuốc & sản phẩm"
        description={`Danh mục toàn chuỗi · Tồn kho tại ${storeName ?? "cửa hàng đang chọn"}`}
        extra={
          <>
            <ExcelMenuButton onImport={can("catalog.manage") ? () => setImporting(true) : undefined} exportType="products" exportLabel="Xuất danh mục ra Excel" />
            {can("catalog.manage") ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                Thêm sản phẩm
              </Button>
            ) : null}
          </>
        }
      />
      <ExcelImportModal
        type="products"
        title="Danh mục sản phẩm"
        open={importing}
        hint="Mã sản phẩm đã có thì cập nhật, mã mới thì tạo mới. Có thể xuất danh mục ra, sửa rồi nhập lại."
        onClose={() => setImporting(false)}
        onDone={() => void queryClient.invalidateQueries()}
      />

      <div className={detail && wide ? "products-layout has-detail" : "products-layout"}>
        <section className="products-main" aria-label="Danh mục sản phẩm">
          <div className="products-toolbar">
            <Input
              allowClear
              size="large"
              className="products-search"
              prefix={<SearchOutlined />}
              placeholder="Tìm tên thuốc, hoạt chất, mã hoặc mã vạch"
              aria-label="Tìm sản phẩm"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
            <div className="products-toolbar-actions">
              <Popover open={filterOpen} onOpenChange={setFilterOpen} trigger="click" placement="bottomRight" content={filterPanel} title="Bộ lọc">
                <Badge count={filterCount} size="small">
                  <Button size="large" icon={<FilterOutlined />}>
                    Bộ lọc
                  </Button>
                </Badge>
              </Popover>
              <div className="view-switch" role="group" aria-label="Chế độ hiển thị">
                <Tooltip title="Dạng danh sách">
                  <Button size="large" type={view === "list" ? "primary" : "default"} icon={<UnorderedListOutlined />} aria-label="Dạng danh sách" aria-pressed={view === "list"} onClick={() => setView("list")} />
                </Tooltip>
                <Tooltip title="Dạng lưới">
                  <Button size="large" type={view === "grid" ? "primary" : "default"} icon={<AppstoreOutlined />} aria-label="Dạng lưới" aria-pressed={view === "grid"} onClick={() => setView("grid")} />
                </Tooltip>
              </div>
              <label className="active-switch">
                <Switch
                  checked={active}
                  onChange={(checked) => {
                    setActive(checked);
                    setPage(1);
                  }}
                />
                <span>{active ? "Đang kinh doanh" : "Ngừng kinh doanh"}</span>
              </label>
            </div>
          </div>

          <div className="product-tabs" role="tablist" aria-label="Phân loại">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={tab === item.key}
                className={tab === item.key ? "product-tab is-active" : "product-tab"}
                onClick={() => {
                  setTab(item.key);
                  setPage(1);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className={products.isFetching && products.data ? "products-body is-refreshing" : "products-body"}>{body}</div>

          {total > 0 ? (
            <div className="products-footer">
              <span className="muted">
                Hiển thị {from} – {to} / {total} sản phẩm
              </span>
              <Pagination size={compact ? "small" : "middle"} current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false} onChange={setPage} />
            </div>
          ) : null}
        </section>

        {detail && wide ? <aside className="products-aside">{detail}</aside> : null}
      </div>

      {!wide ? (
        <Drawer open={Boolean(detail)} onClose={() => select(null)} placement="right" size={compact ? "100%" : 460} closable={false} rootClassName="product-drawer" styles={{ body: { padding: 0 } }} destroyOnHidden>
          {detail}
        </Drawer>
      ) : null}

      <ProductFormModal
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={async (id) => {
          setCreating(false);
          select(id);
        }}
      />
    </div>
  );
}
