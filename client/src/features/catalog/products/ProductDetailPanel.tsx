import { BarcodeOutlined, CameraOutlined, CloseOutlined, DatabaseOutlined, DollarOutlined, EditOutlined, ExclamationCircleFilled, MoreOutlined, PlusOutlined, WarningFilled } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Dropdown, Image, Result, Skeleton, Tag, Tooltip } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router";
import { getErrorMessage, http } from "../../../api/http.js";
import type { Envelope, ProductDetail, ProductUnit } from "../../../api/types.js";
import { formatNumber } from "../../../ui/format.js";
import { useAuth } from "../../auth/AuthProvider.js";
import { ClassBadge } from "./ClassBadge.js";
import { IMAGE_FALLBACK, PRODUCT_DETAIL_QUERY, priceText, stockText } from "./product-labels.js";
import { ProductEditModal, PriceModal, UnitModal } from "./ProductModals.js";
import { ProductImagesModal } from "./ProductImagesModal.js";
import { ProductThumb } from "./ProductThumb.js";

type Props = { id: string; onClose: () => void };

/** Khung chi tiết: ảnh, thông tin danh mục, tồn tại cửa hàng đang chọn, đơn vị & giá. */
export function ProductDetailPanel({ id, onClose }: Props) {
  const { can, storeId, me } = useAuth();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [editingUnit, setEditingUnit] = useState<ProductUnit | null | undefined>(undefined);
  const [pricingUnit, setPricingUnit] = useState<ProductUnit | null>(null);
  const [editingProduct, setEditingProduct] = useState(false);
  const [managingImages, setManagingImages] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  // Khóa theo cửa hàng: đổi cửa hàng thì không hiện tồn của cửa hàng cũ trong lúc tải.
  const product = useQuery({
    queryKey: [PRODUCT_DETAIL_QUERY, storeId, id],
    queryFn: async ({ signal }) => (await http.get<Envelope<ProductDetail>>(`/products/${id}`, { signal })).data.data,
  });
  const item = product.data;
  const storeName = me?.stores.find((store) => store.id === storeId)?.name;

  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [PRODUCT_DETAIL_QUERY] }),
      queryClient.invalidateQueries({ queryKey: ["products-page"] }),
      queryClient.invalidateQueries({ queryKey: ["product", id] }),
    ]);
  }

  const toggleActive = useMutation({
    mutationFn: (active: boolean) => http.post(`/products/${id}/${active ? "activate" : "deactivate"}`),
    onSuccess: async (_data, active) => {
      void message.success(active ? "Đã cho kinh doanh lại" : "Đã ngừng kinh doanh sản phẩm");
      await refresh();
    },
    onError: (error) => void message.error(getErrorMessage(error, "Không đổi được trạng thái")),
  });

  const header = (
    <div className="pd-head">
      <h2>Chi tiết sản phẩm</h2>
      <Button type="text" icon={<CloseOutlined />} aria-label="Đóng chi tiết sản phẩm" onClick={onClose} />
    </div>
  );

  if (product.isError) {
    return (
      <section className="pd-panel" aria-label="Chi tiết sản phẩm">
        {header}
        <Result status="warning" title="Không tải được sản phẩm" subTitle={getErrorMessage(product.error, "Kiểm tra kết nối rồi thử lại.")} extra={<Button onClick={() => void product.refetch()}>Thử lại</Button>} />
      </section>
    );
  }

  if (!item) {
    return (
      <section className="pd-panel" aria-label="Chi tiết sản phẩm" aria-busy="true">
        {header}
        <div className="pd-body">
          <Skeleton.Image active className="pd-skeleton-image" />
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      </section>
    );
  }

  const baseUnit = item.units.find((unit) => unit.conversionToBase === 1);
  const baseName = baseUnit?.name ?? "";
  const images = item.images;
  const primary = images[0];
  const extras = images.slice(1, 4);
  const hiddenCount = images.length - 1 - extras.length;
  const sellable = item.stock?.sellable ?? null;
  const belowMin = sellable !== null && item.minStockBaseQuantity > 0 && sellable < item.minStockBaseQuantity;
  const held = item.stock ? item.stock.quarantined + item.stock.recalled : 0;
  const ingredients = item.ingredients.map((ingredient) => [ingredient.name, ingredient.strengthText].filter(Boolean).join(" ")).join(", ");
  const facts: Array<[string, string | null | undefined]> = [
    ["Nhóm hàng", item.category.name],
    ["Hoạt chất", ingredients || null],
    ["Hàm lượng", item.strengthText],
    ["Dạng bào chế", item.dosageForm],
    ["Quy cách", item.packagingText],
    ["Số đăng ký", item.registrationNumber],
    ["Nhà sản xuất", [item.manufacturer, item.countryOfOrigin].filter(Boolean).join(" · ") || null],
    ["Bảo quản", item.storageCondition],
  ];
  const canManage = can("catalog.manage");

  return (
    <section className="pd-panel" aria-label={`Chi tiết ${item.name}`}>
      {header}
      <div className="pd-body">
        <div className={extras.length > 0 || canManage ? "pd-gallery" : "pd-gallery is-single"}>
          <button type="button" className="pd-main-image" onClick={() => primary && setPreviewIndex(0)} disabled={!primary} aria-label={primary ? `Phóng to ảnh ${item.name}` : `${item.name} chưa có ảnh`}>
            {primary ? <img src={primary.url} alt={item.name} onError={(event) => (event.currentTarget.src = IMAGE_FALLBACK)} /> : <ProductThumb src={null} alt={item.name} size={120} className="pd-empty-image" />}
            {!primary ? <span className="pd-no-image">Chưa có ảnh</span> : null}
          </button>
          {extras.length > 0 || canManage ? (
            <div className="pd-side-images">
              {extras.map((image, index) => (
                <button key={image.id} type="button" className="pd-side-image" onClick={() => setPreviewIndex(index + 1)} aria-label={`Phóng to ảnh ${index + 2}`}>
                  <ProductThumb src={image.thumbUrl} alt={`${item.name} — ảnh ${index + 2}`} size={72} />
                  {index === extras.length - 1 && hiddenCount > 0 ? <span className="pd-more-images">+{hiddenCount}</span> : null}
                </button>
              ))}
              {canManage ? (
                <Button className="pd-manage-images" icon={<CameraOutlined />} onClick={() => setManagingImages(true)}>
                  Quản lý ảnh
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        {images.length > 0 ? (
          <Image.PreviewGroup
            items={images.map((image) => image.url)}
            preview={{ open: previewIndex !== null, current: previewIndex ?? 0, onOpenChange: (open) => !open && setPreviewIndex(null), onChange: (current) => setPreviewIndex(current) }}
          />
        ) : null}

        <div className="pd-title">
          <h3>{item.name}</h3>
          <div className="pd-tags">
            <span className="mono">{item.code}</span>
            {item.isActive ? <Tag color="green">Đang kinh doanh</Tag> : <Tag>Ngừng kinh doanh</Tag>}
            <ClassBadge productType={item.productType} drugClass={item.drugClass} />
          </div>
        </div>

        <dl className="pd-facts">
          {facts
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
        </dl>

        <div className="pd-stock">
          <div className="pd-stock-cell">
            <DatabaseOutlined aria-hidden />
            <div>
              <span>Tồn bán được</span>
              {sellable === null ? (
                <strong className="muted">Chưa chọn cửa hàng</strong>
              ) : (
                <strong className={sellable === 0 || belowMin ? "is-warning" : undefined}>
                  {stockText(sellable, baseName)}
                  {sellable === 0 ? <em> · Hết hàng</em> : belowMin ? <em> · Tồn thấp</em> : null}
                </strong>
              )}
              <small>{storeName ? `Tại ${storeName}` : "Theo cửa hàng đang chọn"}</small>
            </div>
          </div>
          <div className="pd-stock-cell">
            <ExclamationCircleFilled aria-hidden className="pd-min-icon" />
            <div>
              <span>Tồn tối thiểu</span>
              <strong>{item.minStockBaseQuantity > 0 ? stockText(item.minStockBaseQuantity, baseName) : "Chưa đặt"}</strong>
              <small>Áp dụng mọi cửa hàng</small>
            </div>
          </div>
        </div>
        {held > 0 ? (
          <p className="pd-held">
            <WarningFilled /> {stockText(held, baseName)} đang biệt trữ hoặc thu hồi, không tính vào tồn bán được.
          </p>
        ) : null}

        <div className="pd-actions">
          <Button block icon={<BarcodeOutlined />} onClick={() => void navigate(`/in-tem?sanpham=${item.id}`)}>
            In tem mã vạch
          </Button>
        </div>

        {canManage ? (
          <div className="pd-actions">
            <Button block icon={<EditOutlined />} onClick={() => setEditingProduct(true)}>
              Sửa thông tin sản phẩm
            </Button>
            <Dropdown
              trigger={["click"]}
              placement="bottomRight"
              menu={{
                items: [item.isActive ? { key: "deactivate", danger: true, label: "Ngừng kinh doanh" } : { key: "activate", label: "Cho kinh doanh lại" }],
                onClick: ({ key }) => toggleActive.mutate(key === "activate"),
              }}
            >
              <Button icon={<MoreOutlined />} aria-label="Thao tác khác" loading={toggleActive.isPending} />
            </Dropdown>
          </div>
        ) : null}
      </div>

      <div className="pd-units">
        <div className="pd-units-head">
          <h3>Đơn vị & giá bán</h3>
          {canManage ? (
            <Button type="link" size="small" icon={<PlusOutlined />} onClick={() => setEditingUnit(null)}>
              Thêm đơn vị
            </Button>
          ) : null}
        </div>
        <ul>
          {item.units.map((unit) => {
            const price = priceText(unit.currentPrice?.salePrice, null);
            return (
              <li key={unit.id} className={unit.isActive === false ? "is-inactive" : undefined}>
                <div className="pd-unit-main">
                  <div className="pd-unit-name">
                    <strong>{unit.name}</strong>
                    {unit.isDefaultSaleUnit ? <Tag color="blue">Mặc định</Tag> : null}
                    {unit.isSellable === false ? <Tag>Không bán</Tag> : null}
                    {unit.isActive === false ? <Tag>Ngừng dùng</Tag> : null}
                  </div>
                  <span>{unit.conversionToBase === 1 ? "Đơn vị cơ bản" : `1 ${unit.name.toLowerCase()} = ${formatNumber(unit.conversionToBase)} ${baseName.toLowerCase()}`}</span>
                  <span className={unit.barcodes?.length ? "mono" : "muted"}>
                    <BarcodeOutlined aria-hidden /> {unit.barcodes?.length ? unit.barcodes.join(", ") : "Chưa có mã vạch"}
                  </span>
                </div>
                <div className="pd-unit-side">
                  {price ? <strong>{price}</strong> : <span className="muted">Chưa đặt giá</span>}
                  {unit.currentPrice?.isStoreOverride ? <small>Giá riêng cửa hàng</small> : null}
                  <span className="pd-unit-actions">
                    {canManage ? (
                      <Tooltip title="Sửa đơn vị">
                        <Button size="small" type="text" icon={<EditOutlined />} aria-label={`Sửa đơn vị ${unit.name}`} onClick={() => setEditingUnit(unit)} />
                      </Tooltip>
                    ) : null}
                    {can("price.manage") ? (
                      <Tooltip title="Đặt giá">
                        <Button size="small" type="text" icon={<DollarOutlined />} aria-label={`Đặt giá cho ${unit.name}`} onClick={() => setPricingUnit(unit)} />
                      </Tooltip>
                    ) : null}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <ProductEditModal product={item} open={editingProduct} onClose={() => setEditingProduct(false)} onSaved={refresh} />
      <UnitModal productId={item.id} baseUnitName={baseName} unit={editingUnit ?? null} open={editingUnit !== undefined} onClose={() => setEditingUnit(undefined)} onSaved={refresh} />
      {pricingUnit ? <PriceModal productId={item.id} unit={pricingUnit} onClose={() => setPricingUnit(null)} onSaved={refresh} /> : null}
      <ProductImagesModal productId={item.id} productName={item.name} images={images} open={managingImages} onClose={() => setManagingImages(false)} onChanged={refresh} />
    </section>
  );
}
