import { InboxOutlined, SearchOutlined, SettingOutlined, ShoppingOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Empty, Input, InputNumber, Popover, Segmented, Select, Skeleton, Table, Tag, Tooltip } from "antd";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { getErrorMessage, http } from "../../api/http.js";
import { formatVnd, type Envelope } from "../../api/types.js";
import { formatNumber } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { useAuth } from "../auth/AuthProvider.js";
import { ExcelExportButton } from "../excel/ExcelButtons.js";
import { ReceiptFormModal } from "./ReceiptFormModal.js";

type Reason = "OUT_OF_STOCK" | "BELOW_MIN" | "RUNNING_OUT" | "REFILL" | "OK";

type Suggestion = {
  productId: string;
  code: string;
  name: string;
  categoryName: string;
  baseUnitName: string;
  orderUnit: { id: string; name: string; conversionToBase: number };
  sellableBaseQuantity: number;
  minStockBaseQuantity: number;
  onOrderBaseQuantity: number;
  soldBaseQuantity: number;
  avgDailyBaseQuantity: number;
  daysOfStock: number | null;
  targetBaseQuantity: number;
  suggestedBaseQuantity: number;
  suggestedOrderQuantity: number;
  reason: Reason;
  lastSupplier: { id: string; name: string } | null;
  lastUnitCost: number | null;
  lastReceivedAt: string | null;
  estimatedCost: number | null;
};

type SuggestionResponse = {
  items: Suggestion[];
  summary: { total: number; outOfStock: number; belowMin: number; runningOut: number; refill: number; estimatedCost: number; suppliers: number; withoutSupplier: number };
  settings: { windowDays: number; coverDays: number; leadTimeDays: number };
};

const REASON: Record<Reason, { label: string; color: string }> = {
  OUT_OF_STOCK: { label: "Đã hết hàng", color: "red" },
  BELOW_MIN: { label: "Dưới tồn tối thiểu", color: "orange" },
  RUNNING_OUT: { label: "Hết trước khi hàng về", color: "gold" },
  REFILL: { label: "Bổ sung cho kỳ tới", color: "blue" },
  OK: { label: "Đang đủ hàng", color: "green" },
};

export function PurchaseSuggestionsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [windowDays, setWindowDays] = useState(30);
  const [coverDays, setCoverDays] = useState(30);
  const [leadTimeDays, setLeadTimeDays] = useState(7);
  const [search, setSearch] = useState("");
  const [supplierFilter, setSupplierFilter] = useState<string | undefined>();
  const [selected, setSelected] = useState<string[]>([]);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [ordering, setOrdering] = useState(false);

  const params = { windowDays, coverDays, leadTimeDays, onlyNeeded: true, search: search.trim() || undefined };
  const data = useQuery({
    queryKey: ["purchase-suggestions", params],
    queryFn: async () => (await http.get<Envelope<SuggestionResponse>>("/purchase-suggestions", { params })).data.data,
  });

  const items = useMemo(() => data.data?.items ?? [], [data.data]);
  const suppliers = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) if (item.lastSupplier) map.set(item.lastSupplier.id, item.lastSupplier.name);
    return [...map].map(([id, name]) => ({ value: id, label: name }));
  }, [items]);

  const visible = supplierFilter ? items.filter((item) => item.lastSupplier?.id === supplierFilter) : items;
  const quantityOf = (item: Suggestion) => quantities[item.productId] ?? item.suggestedOrderQuantity;

  const chosen = items.filter((item) => selected.includes(item.productId));
  const chosenSuppliers = [...new Set(chosen.map((item) => item.lastSupplier?.id ?? "none"))];
  const chosenCost = chosen.reduce((sum, item) => sum + (item.lastUnitCost ?? 0) * quantityOf(item), 0);
  // Một phiếu nhập chỉ của một nhà cung cấp, nên phải chọn trong cùng một NCC.
  const canCreateReceipt = can("goods_receipt.create") && chosen.length > 0 && chosenSuppliers.length === 1 && chosenSuppliers[0] !== "none";

  const prefill = canCreateReceipt
    ? {
        supplierId: chosen[0]!.lastSupplier!.id,
        lines: chosen.map((item) => ({ productId: item.productId, unitName: item.orderUnit.name, quantity: quantityOf(item), unitCost: item.lastUnitCost ?? 0 })),
      }
    : null;

  const columns = [
    {
      title: "Sản phẩm",
      dataIndex: "name",
      render: (_: string, row: Suggestion) => (
        <div className="cell-main">
          <span className="cell-title">{row.name}</span>
          <span className="cell-sub">
            {row.code} · {row.categoryName}
          </span>
        </div>
      ),
    },
    {
      title: "Lý do",
      dataIndex: "reason",
      width: 180,
      render: (reason: Reason) => (
        <Tag variant="filled" color={REASON[reason].color}>
          {REASON[reason].label}
        </Tag>
      ),
    },
    {
      title: "Tồn / tối thiểu",
      dataIndex: "sellableBaseQuantity",
      width: 150,
      align: "right" as const,
      render: (value: number, row: Suggestion) => (
        <div className="cell-main" style={{ alignItems: "flex-end" }}>
          <span className="cell-title">
            {formatNumber(value)} {row.baseUnitName}
          </span>
          <span className="cell-sub">
            Tối thiểu {formatNumber(row.minStockBaseQuantity)}
            {row.onOrderBaseQuantity > 0 ? ` · đang về ${formatNumber(row.onOrderBaseQuantity)}` : ""}
          </span>
        </div>
      ),
    },
    {
      title: "Tốc độ bán",
      dataIndex: "avgDailyBaseQuantity",
      width: 150,
      align: "right" as const,
      render: (value: number, row: Suggestion) => (
        <div className="cell-main" style={{ alignItems: "flex-end" }}>
          <span className="cell-title">
            {formatNumber(value)} {row.baseUnitName}/ngày
          </span>
          <span className="cell-sub">{row.daysOfStock === null ? `${windowDays} ngày qua chưa bán` : `Còn đủ ${formatNumber(row.daysOfStock)} ngày`}</span>
        </div>
      ),
    },
    {
      title: "Đặt",
      dataIndex: "suggestedOrderQuantity",
      width: 170,
      render: (_: number, row: Suggestion) => (
        <div className="count-entry">
          <InputNumber
            min={0}
            max={100000}
            className="count-input"
            value={quantityOf(row)}
            onChange={(value) => setQuantities((current) => ({ ...current, [row.productId]: Number(value ?? 0) }))}
          />
          <span className="cell-sub">{row.orderUnit.name}</span>
        </div>
      ),
    },
    {
      title: "Nhà cung cấp gần nhất",
      dataIndex: "lastSupplier",
      width: 230,
      render: (_: unknown, row: Suggestion) =>
        row.lastSupplier ? (
          <div className="cell-main">
            <span className="cell-title">{row.lastSupplier.name}</span>
            <span className="cell-sub">
              {row.lastUnitCost === null ? "Chưa có giá nhập" : `${formatVnd(row.lastUnitCost)} / ${row.orderUnit.name}`}
              {row.lastUnitCost !== null ? ` · tạm tính ${formatVnd(row.lastUnitCost * quantityOf(row))}` : ""}
            </span>
          </div>
        ) : (
          <Tooltip title="Chưa từng nhập mặt hàng này, cần tự chọn nhà cung cấp khi lập phiếu">
            <span className="cell-sub">Chưa có lịch sử nhập</span>
          </Tooltip>
        ),
    },
  ];

  const summary = data.data?.summary;

  return (
    <div>
      <PageHeader
        icon={<ShoppingOutlined />}
        title="Đề xuất đặt hàng"
        description="Hôm nay cần gọi hàng gì và bao nhiêu, tính từ tốc độ bán thật, tồn tối thiểu và hàng đang trên đường về."
        extra={
          <>
            <Popover
              trigger="click"
              title="Cách tính đề xuất"
              content={
                <div className="purchase-settings">
                  <label>
                    Lấy dữ liệu bán của (ngày)
                    <InputNumber min={7} max={365} value={windowDays} onChange={(value) => setWindowDays(Number(value ?? 30))} />
                  </label>
                  <label>
                    Muốn đủ hàng bán trong (ngày)
                    <InputNumber min={1} max={180} value={coverDays} onChange={(value) => setCoverDays(Number(value ?? 30))} />
                  </label>
                  <label>
                    Thời gian chờ hàng về (ngày)
                    <InputNumber min={0} max={90} value={leadTimeDays} onChange={(value) => setLeadTimeDays(Number(value ?? 7))} />
                  </label>
                </div>
              }
            >
              <Button icon={<SettingOutlined />}>Cách tính</Button>
            </Popover>
            <ExcelExportButton type="purchase-order" label="Xuất đơn đặt hàng" tooltip="Xuất danh sách cần đặt, xếp theo nhà cung cấp để gọi hàng" />
            <Tooltip title={chosen.length === 0 ? "Chọn các dòng cần đặt trước" : chosenSuppliers.length > 1 ? "Mỗi phiếu nhập chỉ của một nhà cung cấp — chọn lại cho cùng một nhà cung cấp" : chosenSuppliers[0] === "none" ? "Mặt hàng chưa có lịch sử nhập, lập phiếu nhập thủ công và chọn nhà cung cấp" : undefined}>
              <Button type="primary" icon={<InboxOutlined />} disabled={!canCreateReceipt} onClick={() => setOrdering(true)}>
                Lập phiếu nhập {chosen.length > 0 ? `(${chosen.length})` : ""}
              </Button>
            </Tooltip>
          </>
        }
      />

      {data.isError ? <Alert type="error" showIcon title="Không tính được đề xuất đặt hàng" description={getErrorMessage(data.error)} /> : null}

      {summary ? (
        <div className="count-stats">
          <div className="count-stat">
            <span>Mặt hàng cần đặt</span>
            <b>{formatNumber(summary.total)}</b>
          </div>
          <div className="count-stat bad">
            <span>Đã hết hàng</span>
            <b>{formatNumber(summary.outOfStock)}</b>
          </div>
          <div className="count-stat">
            <span>Dưới tồn tối thiểu</span>
            <b>{formatNumber(summary.belowMin)}</b>
          </div>
          <div className="count-stat">
            <span>Chi phí tạm tính</span>
            <b>{formatVnd(summary.estimatedCost)}</b>
          </div>
          <div className="count-stat">
            <span>Nhà cung cấp cần gọi</span>
            <b>{formatNumber(summary.suppliers)}</b>
          </div>
        </div>
      ) : null}

      {summary && summary.withoutSupplier > 0 ? (
        <Alert
          className="count-banner"
          type="info"
          showIcon
          title={`${formatNumber(summary.withoutSupplier)} mặt hàng chưa từng nhập qua phần mềm`}
          description="Những mặt hàng này chưa có lịch sử nhập nên chưa gợi ý được nhà cung cấp và giá. Lập phiếu nhập thủ công cho lần đầu, các lần sau hệ thống tự gợi ý."
        />
      ) : null}

      <Card>
        <div className="count-toolbar">
          <Input allowClear prefix={<SearchOutlined />} placeholder="Tìm tên thuốc hoặc mã" className="count-search" value={search} onChange={(event) => setSearch(event.target.value)} />
          <Select allowClear placeholder="Mọi nhà cung cấp" className="controlled-select" style={{ maxWidth: 280 }} value={supplierFilter} onChange={setSupplierFilter} options={suppliers} />
          {chosen.length > 0 ? <Segmented options={[{ value: "sel", label: `Đang chọn ${chosen.length} dòng · ${formatVnd(chosenCost)}` }]} value="sel" /> : null}
        </div>

        {data.isLoading ? (
          <Skeleton active />
        ) : (
          <Table
            rowKey="productId"
            size="small"
            dataSource={visible}
            columns={columns}
            scroll={{ x: 1000 }}
            pagination={visible.length > 30 ? { pageSize: 30, size: "small" } : false}
            rowSelection={{
              selectedRowKeys: selected,
              onChange: (keys) => setSelected(keys as string[]),
              getCheckboxProps: (row) => ({ disabled: quantityOf(row) <= 0 }),
            }}
            locale={{ emptyText: <Empty description="Không có mặt hàng nào cần đặt theo cách tính hiện tại" /> }}
          />
        )}
      </Card>

      <ReceiptFormModal
        open={ordering}
        receipt={null}
        prefill={prefill}
        onClose={() => setOrdering(false)}
        onSaved={async () => {
          setOrdering(false);
          setSelected([]);
          await data.refetch();
          void navigate("/phieu-nhap");
        }}
      />
    </div>
  );
}
