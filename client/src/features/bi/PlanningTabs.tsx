import { DownloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Input, Segmented, Table, Tag } from "antd";
import { useState } from "react";
import { formatNumber } from "../../ui/format.js";
import { RankBars } from "../analytics/AnalysisCharts.js";
import { downloadFile } from "../excel/excel-api.js";
import { EmptyState, Panel } from "./BiSections.js";
import {
  REASON_LABELS,
  XYZ_LABELS,
  biApi,
  matchesText,
  money,
  orderText,
  transferText,
  type AbcGroup,
  type ClassItem,
  type ReorderItem,
  type ReorderReason,
  type Transfer,
  type XyzGroup,
} from "./bi-api.js";
import { TABLE_SCROLL, queryState } from "./bi-ui.js";

/**
 * Tab "Đặt hàng" và "ABC" của Bảng điều hành (Phase 5, bước 5.4). Chỉ hiển thị số
 * analytics-service đã tính (bước 5.1–5.3); cách tính nằm trong biểu tượng "?".
 */

const REASON_COLORS: Record<ReorderReason, string> = {
  out_of_stock: "red",
  stockout_before_arrival: "volcano",
  below_min: "orange",
  reorder: "default",
};

const CELL_COLORS: Record<AbcGroup, string> = { A: "blue", B: "cyan", C: "default" };

const nameCell = (item: { medicine_name: string | null; medicine_code: string }) => (
  <span className="bi-name">
    {item.medicine_name ?? item.medicine_code} <span className="muted">{item.medicine_code}</span>
  </span>
);

export function ReorderTab({ store, version }: { store: string; version: number }) {
  const { message } = App.useApp();
  const [view, setView] = useState<"all" | "order" | "transfer">("all");
  const [exporting, setExporting] = useState(false);
  const query = useQuery({
    queryKey: ["bi", "reorder", store, version],
    queryFn: () => biApi.reorder(store),
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  if (!data) return <Panel title="Đặt hàng">{queryState(query)}</Panel>;
  if (!data.available) {
    return (
      <Panel title="Đặt hàng">
        <EmptyState text="Chưa có tệp tồn kho" />
      </Panel>
    );
  }

  const items = data.items.filter((item) =>
    view === "order"
      ? item.order_quantity > 0
      : view === "transfer"
        ? item.transfer_quantity > 0
        : true,
  );
  const exportFile = async () => {
    setExporting(true);
    try {
      await downloadFile("/bi/reorder/export", { store }, "goi-y-dat-hang.xlsx");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "Không xuất được tệp");
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <Panel
        title={
          <>
            Đặt hàng <span className="bi-panel-sub">đủ bán chờ hàng + {data.cover_days} ngày</span>
          </>
        }
        info={
          <>
            <p>
              Cần có = nhu cầu dự báo (thời gian chờ hàng + {data.cover_days} ngày) + tồn an toàn
              theo nhóm ABC–XYZ; trừ lô sắp hết hạn không bán kịp; làm tròn theo quy cách.
            </p>
            <p>Cửa hàng đang thừa chuyển trước, phần còn thiếu mới mua. Không tạo phiếu nào.</p>
          </>
        }
        extra={
          <Button icon={<DownloadOutlined />} loading={exporting} onClick={() => void exportFile()}>
            Excel
          </Button>
        }
      >
        <div className="bi-plan-summary">
          <div>
            <span className="muted">Mua</span>
            <strong>{money(data.order_value ?? 0)}</strong>
            <span className="muted">{data.order_lines} dòng</span>
          </div>
          <div>
            <span className="muted">Chuyển giữa cửa hàng</span>
            <strong>{money(data.transfer_value ?? 0)}</strong>
            <span className="muted">{data.transfer_lines} chuyến</span>
          </div>
          {(data.by_supplier ?? []).slice(0, 3).map((entry) => (
            <div key={entry.supplier}>
              <span className="muted">{entry.supplier}</span>
              <strong>{money(entry.order_value)}</strong>
              <span className="muted">{entry.lines} dòng</span>
            </div>
          ))}
        </div>
        <div className="bi-filters">
          <Segmented
            value={view}
            onChange={(value) => setView(value as typeof view)}
            options={[
              { value: "all", label: `Tất cả ${data.items.length}` },
              { value: "order", label: `Mua ${data.order_lines ?? 0}` },
              {
                value: "transfer",
                label: `Chuyển ${data.items.filter((item) => item.transfer_quantity > 0).length}`,
              },
            ]}
          />
        </div>
        <Table<ReorderItem>
          size="small"
          rowKey={(item) => `${item.store_code}-${item.medicine_code}`}
          dataSource={items}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          scroll={{ x: 960 }}
          locale={{ emptyText: <EmptyState text="Không cần đặt gì" /> }}
          columns={[
            ...(store === "ALL" ? [{ title: "CH", dataIndex: "store_code", width: 64 }] : []),
            {
              title: "Thuốc",
              key: "name",
              render: (_: unknown, item: ReorderItem) => nameCell(item),
            },
            {
              title: "Lý do",
              dataIndex: "reason",
              width: 150,
              render: (reason: ReorderReason, item: ReorderItem) => (
                <span className="bi-nowrap">
                  <Tag color={REASON_COLORS[reason]}>{REASON_LABELS[reason]}</Tag>
                  {item.days_until_stockout ? (
                    <span className="muted">{item.days_until_stockout} ngày</span>
                  ) : null}
                </span>
              ),
            },
            {
              title: "Còn / cần",
              key: "need",
              align: "right" as const,
              render: (_: unknown, item: ReorderItem) => (
                <span className="bi-nowrap">
                  {formatNumber(Math.round(item.usable_quantity))}
                  <span className="muted"> / {formatNumber(Math.round(item.target_quantity))}</span>
                </span>
              ),
            },
            {
              title: "Chuyển",
              key: "transfer",
              render: (_: unknown, item: ReorderItem) =>
                item.transfer_quantity ? (
                  <span className="bi-nowrap">{transferText(item)}</span>
                ) : (
                  "—"
                ),
            },
            {
              title: "Mua",
              key: "order",
              align: "right" as const,
              render: (_: unknown, item: ReorderItem) =>
                item.order_quantity ? (
                  <strong className="bi-nowrap">{orderText(item)}</strong>
                ) : (
                  "—"
                ),
            },
            {
              title: "Tiền",
              dataIndex: "order_value",
              align: "right" as const,
              render: (value: number | null, item: ReorderItem) =>
                item.order_quantity ? money(value) : "—",
            },
            {
              title: "NCC",
              dataIndex: "supplier",
              render: (value: string | null, item: ReorderItem) =>
                item.order_quantity ? (value ?? <span className="muted">chưa rõ</span>) : "—",
            },
            {
              title: "Nhóm",
              dataIndex: "cell",
              width: 64,
              render: (cell: string) => <Tag color={CELL_COLORS[cell[0] as AbcGroup]}>{cell}</Tag>,
            },
          ]}
        />
      </Panel>
      {data.transfers.length ? (
        <Panel
          title={
            <>
              Chuyển hàng <span className="bi-count">{data.transfers.length}</span>
            </>
          }
          info="Cửa hàng gửi vẫn giữ đủ mức cần có của mình. Mã cửa hàng bạn không được xem tồn kho hiện là “Cửa hàng khác”."
        >
          <Table<Transfer>
            size="small"
            rowKey={(move) => `${move.from_store}-${move.to_store}-${move.medicine_code}`}
            dataSource={data.transfers}
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            scroll={{ x: 560 }}
            columns={[
              {
                title: "Từ → đến",
                key: "route",
                width: 150,
                render: (_: unknown, move: Transfer) => (
                  <span className="bi-nowrap">
                    {move.from_store} → {move.to_store}
                  </span>
                ),
              },
              {
                title: "Thuốc",
                key: "name",
                render: (_: unknown, move: Transfer) => nameCell(move),
              },
              {
                title: "Số lượng",
                key: "quantity",
                align: "right" as const,
                render: (_: unknown, move: Transfer) =>
                  `${formatNumber(move.quantity)} ${move.unit ?? ""}`,
              },
              { title: "Giá trị", dataIndex: "value", align: "right" as const, render: money },
            ]}
          />
        </Panel>
      ) : null}
    </>
  );
}

const ABC_ORDER: AbcGroup[] = ["A", "B", "C"];
const XYZ_ORDER: XyzGroup[] = ["X", "Y", "Z"];
const ABC_BAR_COLORS: Record<AbcGroup, string> = { A: "#2563eb", B: "#0891b2", C: "#94a3b8" };

export function AbcTab({ store, version }: { store: string; version: number }) {
  const [cell, setCell] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["bi", "classification", store, version],
    queryFn: () => biApi.classification(store),
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  if (!data) return <Panel title="ABC–XYZ">{queryState(query)}</Panel>;

  const items = data.items.filter(
    (item) =>
      (cell === null || item.cell === cell || (cell.length === 1 && item.abc === cell)) &&
      matchesText(search, item.medicine_name, item.medicine_code),
  );

  return (
    <Panel
      title={
        <>
          ABC–XYZ{" "}
          <span className="bi-panel-sub">
            {data.window.start.split("-").reverse().slice(0, 2).join("/")} –{" "}
            {data.window.end.split("-").reverse().slice(0, 2).join("/")}
          </span>
        </>
      }
      info={
        <>
          <p>
            ABC theo doanh thu 90 ngày: A làm ra ~80% doanh thu, B ~15%, C ~5%. XYZ theo độ đều của
            nhu cầu bán lẻ mỗi tuần (12 tuần): X ổn định, Y dao động, Z thất thường.
          </p>
          <p>Phần trăm trong mỗi ô là mức phục vụ dùng để tính tồn an toàn khi đặt hàng.</p>
        </>
      }
      extra={
        <Input.Search
          allowClear
          className="bi-search"
          placeholder="Tìm thuốc"
          onChange={(event) => setSearch(event.target.value)}
        />
      }
    >
      <div className="bi-split">
        <div className="bi-bars">
          <RankBars
            bars={ABC_ORDER.map((group) => ({
              label: `Nhóm ${group} · ${data.summary[group].count} thuốc`,
              value: data.summary[group].revenue,
              share: data.summary[group].share_pct,
              color: ABC_BAR_COLORS[group],
            }))}
            valueFormat="currency"
          />
        </div>
        <div className="bi-matrix" role="grid" aria-label="Ma trận ABC–XYZ">
          <span />
          {XYZ_ORDER.map((xyz) => (
            <span key={xyz} className="bi-matrix-head">
              {xyz}
              <small>{XYZ_LABELS[xyz]}</small>
            </span>
          ))}
          {ABC_ORDER.map((abc) => (
            <MatrixRow
              key={abc}
              abc={abc}
              matrix={data.matrix}
              selected={cell}
              onSelect={setCell}
            />
          ))}
        </div>
      </div>
      <div className="bi-filters">
        <Segmented
          value={cell !== null && cell.length === 1 ? cell : cell === null ? "all" : "cell"}
          onChange={(value) => setCell(value === "all" || value === "cell" ? null : String(value))}
          options={[
            { value: "all", label: `Tất cả ${data.items.length}` },
            ...ABC_ORDER.map((group) => ({
              value: group,
              label: `${group} ${data.summary[group].count}`,
            })),
            ...(cell !== null && cell.length === 2 ? [{ value: "cell", label: `Ô ${cell}` }] : []),
          ]}
        />
      </div>
      <Table<ClassItem>
        size="small"
        rowKey="medicine_code"
        dataSource={items}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        scroll={TABLE_SCROLL}
        locale={{ emptyText: <EmptyState text="Không có thuốc nào" /> }}
        columns={[
          { title: "Thuốc", key: "name", render: (_: unknown, item: ClassItem) => nameCell(item) },
          {
            title: "Nhóm",
            dataIndex: "cell",
            width: 70,
            render: (value: string, item: ClassItem) => (
              <Tag color={CELL_COLORS[item.abc]}>{value}</Tag>
            ),
          },
          { title: "Doanh thu", dataIndex: "revenue", align: "right" as const, render: money },
          {
            title: "Cộng dồn",
            dataIndex: "cumulative_pct",
            align: "right" as const,
            render: (value: number) => `${value.toLocaleString("vi-VN")}%`,
          },
          {
            title: "Biến động (CV)",
            dataIndex: "cv",
            align: "right" as const,
            render: (value: number | null, item: ClassItem) =>
              value === null ? (
                <span className="muted">{item.sold ? "chưa đủ tuần" : "không bán"}</span>
              ) : (
                value.toLocaleString("vi-VN")
              ),
          },
          {
            title: "Mức phục vụ",
            dataIndex: "service_level",
            align: "right" as const,
            render: (value: number) => `${Math.round(value * 100)}%`,
          },
        ]}
      />
    </Panel>
  );
}

function MatrixRow({
  abc,
  matrix,
  selected,
  onSelect,
}: {
  abc: AbcGroup;
  matrix: Record<string, { count: number; service_level: number }>;
  selected: string | null;
  onSelect: (cell: string | null) => void;
}) {
  return (
    <>
      <span className="bi-matrix-head">{abc}</span>
      {XYZ_ORDER.map((xyz) => {
        const key = `${abc}${xyz}`;
        const entry = matrix[key];
        return (
          <button
            key={key}
            type="button"
            className={`bi-matrix-cell tone-${abc}${selected === key ? " is-selected" : ""}`}
            disabled={!entry?.count}
            onClick={() => onSelect(selected === key ? null : key)}
          >
            <strong>{entry?.count ?? 0}</strong>
            <small>{Math.round((entry?.service_level ?? 0) * 100)}%</small>
          </button>
        );
      })}
    </>
  );
}
