import { ArrowDownOutlined, ArrowUpOutlined, BarcodeOutlined, LeftOutlined, PlusOutlined, RightOutlined } from "@ant-design/icons";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Button, Empty, Input, Result, Select, Skeleton, Switch, Tooltip } from "antd";
import type { InputRef } from "antd";
import { useState } from "react";
import type { RefObject } from "react";
import { getErrorMessage, http } from "../../../api/http.js";
import type { CategoryItem, Envelope, Paged, ProductListItem } from "../../../api/types.js";
import { useDebounced } from "../../../ui/useDebounced.js";
import { useAuth } from "../../auth/AuthProvider.js";
import { priceText, stockText } from "../../catalog/products/product-labels.js";
import { ProductThumb } from "../../catalog/products/ProductThumb.js";

type Tab = "ALL" | "RX" | "OTC" | "SUPPLEMENT" | "MEDICAL_DEVICE";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "ALL", label: "Tất cả" },
  { key: "RX", label: "Kê đơn" },
  { key: "OTC", label: "Không kê đơn" },
  { key: "SUPPLEMENT", label: "TPCN" },
  { key: "MEDICAL_DEVICE", label: "Thiết bị y tế" },
];

const TAB_PARAMS: Record<Tab, Record<string, string>> = {
  ALL: {},
  RX: { productType: "DRUG", drugClass: "RX,CONTROLLED" },
  OTC: { productType: "DRUG", drugClass: "OTC" },
  SUPPLEMENT: { productType: "SUPPLEMENT" },
  MEDICAL_DEVICE: { productType: "MEDICAL_DEVICE" },
};

const PAGE_SIZE = 10;

type Props = {
  term: string;
  onTermChange: (value: string) => void;
  searchRef: RefObject<InputRef | null>;
  /** Enter khi chưa chọn dòng nào: tra mã vạch/tên chính xác (máy quét gõ nhanh rồi Enter). */
  onScanEnter: () => void;
  onAdd: (productId: string, unitId: string | undefined) => void;
};

function defaultUnitId(item: ProductListItem): string | undefined {
  return item.saleUnits.find((unit) => unit.isDefaultSaleUnit)?.id ?? item.saleUnits[0]?.id;
}

/** Danh mục bên trái màn Bán thuốc: tìm/quét, lọc, chọn đơn vị và thêm vào đơn. */
export function PosCatalog({ term, onTermChange, searchRef, onScanEnter, onAdd }: Props) {
  const { storeId } = useAuth();
  const [tab, setTab] = useState<Tab>("ALL");
  const [categoryId, setCategoryId] = useState<string>();
  const [inStock, setInStock] = useState(true);
  const [page, setPage] = useState(1);
  const [unitChoice, setUnitChoice] = useState<Record<string, string>>({});
  const [nav, setNav] = useState<{ key: string; index: number } | null>(null);
  const searchTerm = useDebounced(term.trim(), 250);

  const categories = useQuery({
    queryKey: ["product-categories"],
    queryFn: async () => (await http.get<Envelope<Paged<CategoryItem>>>("/categories", { params: { limit: 100 } })).data.data.items,
    staleTime: 5 * 60_000,
  });

  const filterKey = { searchTerm, tab, categoryId, inStock, page };
  const listKey = JSON.stringify(filterKey);
  const products = useQuery({
    queryKey: ["pos-products", storeId, filterKey],
    queryFn: async ({ signal }) =>
      (
        await http.get<Envelope<Paged<ProductListItem>>>("/products", {
          signal,
          params: {
            search: searchTerm || undefined,
            page,
            limit: PAGE_SIZE,
            categoryId,
            inStock: inStock || undefined,
            sortBy: "name",
            order: "asc",
            ...TAB_PARAMS[tab],
          },
        })
      ).data.data,
    // Không giữ dữ liệu cũ khi đổi cửa hàng: tồn thuộc về cửa hàng đang chọn.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === storeId ? keepPreviousData(previous) : undefined),
  });

  const items = products.data?.items ?? [];
  // Danh sách đang hiện chưa phải kết quả của từ khóa vừa gõ (đang chờ debounce hoặc đang tải):
  // khi đó không cho chọn dòng bằng phím, tránh thêm nhầm thuốc của lần tìm trước.
  const stale = term.trim() !== searchTerm || products.isPlaceholderData;
  const total = products.data?.pagination.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Dòng đang chọn bằng phím mũi tên; đổi bộ lọc/trang thì tự bỏ chọn.
  const active = !stale && nav && nav.key === listKey && nav.index < items.length ? nav.index : null;

  function resetPage() {
    setPage(1);
  }

  function chosenUnit(item: ProductListItem) {
    const id = unitChoice[item.id] ?? defaultUnitId(item);
    return item.saleUnits.find((unit) => unit.id === id);
  }

  function blockReason(item: ProductListItem): string | null {
    if (item.stock !== null && item.stock.sellable <= 0) return "Hết hàng bán được tại cửa hàng này";
    const unit = chosenUnit(item);
    if (!unit) return "Sản phẩm chưa có đơn vị bán";
    if (unit.salePrice === null) return "Đơn vị này chưa đặt giá bán";
    return null;
  }

  function add(item: ProductListItem) {
    if (blockReason(item)) return;
    onAdd(item.id, chosenUnit(item)?.id);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0 || stale) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = active === null ? (step === 1 ? 0 : items.length - 1) : (active + step + items.length) % items.length;
      setNav({ key: listKey, index: next });
      document.getElementById(`pos-row-${items[next]!.id}`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active !== null) add(items[active]!);
      else onScanEnter();
    } else if (event.key === "Escape") {
      setNav(null);
    }
  }

  let body;
  if (products.isError && !products.data) {
    body = <Result status="warning" title="Không tải được danh mục" subTitle={getErrorMessage(products.error, "Kiểm tra kết nối rồi thử lại.")} extra={<Button onClick={() => void products.refetch()}>Thử lại</Button>} />;
  } else if (products.isPending) {
    body = (
      <div className="pos-skeleton" aria-busy="true">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="product-skeleton-row">
            <Skeleton.Avatar active shape="square" size={56} />
            <Skeleton active title={false} paragraph={{ rows: 2, width: ["55%", "30%"] }} />
          </div>
        ))}
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <Empty className="product-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={inStock ? "Không có sản phẩm còn hàng phù hợp" : "Không tìm thấy sản phẩm phù hợp"}>
        {inStock ? <Button onClick={() => setInStock(false)}>Xem cả hàng đã hết</Button> : null}
      </Empty>
    );
  } else {
    body = (
      <div className="pos-table" role="listbox" aria-label="Kết quả tìm thuốc">
        <div className="pos-table-head" aria-hidden>
          <span>Sản phẩm</span>
          <span>Đơn vị bán</span>
          <span className="col-num">Tồn bán được</span>
          <span className="col-num">Giá bán</span>
          <span />
        </div>
        {items.map((item, index) => {
          const unit = chosenUnit(item);
          const reason = blockReason(item);
          const sellable = item.stock?.sellable ?? null;
          const inUnit = unit && unit.conversionToBase > 1 && sellable !== null ? Math.floor(sellable / unit.conversionToBase) : null;
          const rx = item.drugClass === "RX" ? "Kê đơn" : item.drugClass === "CONTROLLED" ? "Kiểm soát đặc biệt" : null;
          const ingredients = item.ingredients.map((ingredient) => ingredient.name).join(", ");
          return (
            <div
              key={item.id}
              id={`pos-row-${item.id}`}
              role="option"
              aria-selected={active === index}
              className={active === index ? "pos-row is-active" : "pos-row"}
              onDoubleClick={() => add(item)}
            >
              <div className="pos-row-product">
                <ProductThumb src={item.primaryImage?.thumbUrl} alt={item.name} size={56} />
                <div className="pos-row-text">
                  <strong>
                    {item.name} {rx ? <span className={item.drugClass === "CONTROLLED" ? "class-badge tone-red" : "class-badge tone-orange"}>{rx}</span> : null}
                  </strong>
                  <span className="muted">{[item.code, ingredients].filter(Boolean).join(" · ")}</span>
                </div>
              </div>
              <div className="pos-row-unit">
                {item.saleUnits.length > 0 ? (
                  <Select
                    value={unit?.id}
                    aria-label={`Đơn vị bán ${item.name}`}
                    onChange={(value) => setUnitChoice((current) => ({ ...current, [item.id]: value }))}
                    options={item.saleUnits.map((option) => ({ value: option.id, label: option.name }))}
                    popupMatchSelectWidth={false}
                  />
                ) : (
                  <span className="muted">Chưa có đơn vị</span>
                )}
              </div>
              <div className="col-num pos-row-stock">
                {sellable === null ? (
                  <span className="muted">—</span>
                ) : (
                  <>
                    <strong className={sellable <= 0 ? "is-out" : item.isBelowMinStock ? "is-low" : "is-ok"}>{stockText(sellable, item.baseUnit?.name)}</strong>
                    {sellable <= 0 ? <small className="is-out">Hết hàng</small> : inUnit !== null ? <small>≈ {stockText(inUnit, unit?.name)}</small> : item.isBelowMinStock ? <small className="is-low">Tồn thấp</small> : null}
                  </>
                )}
              </div>
              <div className="col-num pos-row-price">{unit?.salePrice !== null && unit?.salePrice !== undefined ? <strong>{priceText(unit.salePrice, unit.name)}</strong> : <span className="muted">Chưa đặt giá</span>}</div>
              <div className="pos-row-action">
                <Tooltip title={reason}>
                  <Button icon={<PlusOutlined />} disabled={Boolean(reason)} onClick={() => add(item)} aria-label={`Thêm ${item.name} vào đơn`}>
                    Thêm
                  </Button>
                </Tooltip>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <section className="pos-panel pos-catalog-panel" aria-label="Tìm thuốc">
      <Input
        ref={searchRef}
        size="large"
        className="pos-search"
        prefix={<BarcodeOutlined />}
        placeholder="Quét mã hoặc tìm tên thuốc, hoạt chất..."
        aria-label="Quét mã hoặc tìm thuốc"
        value={term}
        allowClear
        autoFocus
        onChange={(event) => {
          onTermChange(event.target.value);
          resetPage();
        }}
        onKeyDown={onKeyDown}
      />

      <div className="pos-filter-row">
        <div className="product-tabs pos-tabs" role="tablist" aria-label="Phân loại">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              className={tab === item.key ? "product-tab is-active" : "product-tab"}
              onClick={() => {
                setTab(item.key);
                resetPage();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="pos-filter-tools">
          <Select
            className="pos-category"
            value={categoryId ?? ""}
            loading={categories.isLoading}
            showSearch
            optionFilterProp="label"
            aria-label="Nhóm hàng"
            labelRender={({ label }) => <span>Nhóm hàng: {label}</span>}
            onChange={(value) => {
              setCategoryId(value || undefined);
              resetPage();
            }}
            options={[{ value: "", label: "Tất cả" }, ...(categories.data ?? []).map((item) => ({ value: item.id, label: item.name }))]}
          />
          <label className="active-switch">
            <Switch
              checked={inStock}
              onChange={(checked) => {
                setInStock(checked);
                resetPage();
              }}
            />
            <span>Chỉ còn hàng</span>
          </label>
        </div>
      </div>

      <div className={(products.isFetching || stale) && products.data ? "products-body is-refreshing" : "products-body"}>{body}</div>

      <div className="pos-catalog-footer">
        <span className="pos-key-hints">
          <kbd>
            <ArrowUpOutlined />
          </kbd>
          <kbd>
            <ArrowDownOutlined />
          </kbd>
          Chọn thuốc · <kbd>Enter</kbd> Thêm vào đơn
        </span>
        {total > 0 ? (
          <span className="pos-pager">
            <span className="muted">
              {(page - 1) * PAGE_SIZE + 1} – {Math.min(total, page * PAGE_SIZE)} / {total} sản phẩm
            </span>
            <Button icon={<LeftOutlined />} aria-label="Trang trước" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} />
            <Button icon={<RightOutlined />} aria-label="Trang sau" disabled={page >= pages} onClick={() => setPage((value) => value + 1)} />
          </span>
        ) : null}
      </div>
    </section>
  );
}
