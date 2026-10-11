import { PrinterOutlined, WalletOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Card, Drawer, Empty, Grid, Skeleton, Table, Tag } from "antd";
import { useState } from "react";
import { getErrorMessage, http } from "../../api/http.js";
import { formatVnd, type Envelope } from "../../api/types.js";
import { formatDateTime } from "../../ui/format.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { printDocument } from "../printing/printing.js";
import {
  cashShiftKeys,
  cashShiftPrintUrl,
  type CashShift,
  type CashShiftListItem,
} from "./cash-shift-api.js";

function Difference({ value }: { value: number | null }) {
  if (value === null) return <span>—</span>;
  if (value === 0) return <Tag color="green">Khớp</Tag>;
  return (
    <Tag color={value < 0 ? "red" : "orange"}>
      {value < 0 ? "Thiếu" : "Thừa"} {formatVnd(Math.abs(value))}
    </Tag>
  );
}

/** Lịch sử ca thu ngân của cửa hàng: tiền đầu ca, dự kiến, đếm thực tế, chênh lệch. */
export function CashShiftsPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  const shifts = useQuery({
    queryKey: cashShiftKeys.list,
    queryFn: async () => (await http.get<Envelope<CashShiftListItem[]>>("/cash-shifts")).data.data,
  });

  return (
    <div>
      <PageHeader icon={<WalletOutlined />} title="Ca thu ngân" />
      <Card>
        <Table<CashShiftListItem>
          rowKey="id"
          loading={shifts.isFetching}
          dataSource={shifts.data ?? []}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          scroll={{ x: 900 }}
          onRow={(row) => ({ onClick: () => setOpenId(row.id), style: { cursor: "pointer" } })}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  shifts.isError
                    ? getErrorMessage(shifts.error, "Không tải được danh sách ca")
                    : "Chưa có ca nào. Mở ca ở màn Quầy bán."
                }
              />
            ),
          }}
          columns={[
            {
              title: "Mã ca",
              dataIndex: "code",
              width: 190,
              render: (value: string) => <span className="mono">{value}</span>,
            },
            {
              title: "Mở ca",
              key: "opened",
              render: (_: unknown, row) => `${formatDateTime(row.openedAt)} · ${row.openedByName}`,
            },
            {
              title: "Chốt ca",
              key: "closed",
              render: (_: unknown, row) =>
                row.status === "OPEN" ? (
                  <Tag color="blue">Đang mở</Tag>
                ) : (
                  `${formatDateTime(row.closedAt)} · ${row.closedByName ?? ""}`
                ),
            },
            {
              title: "Đầu ca",
              dataIndex: "openingCash",
              align: "right",
              width: 130,
              render: (value: number) => formatVnd(value),
            },
            {
              title: "Dự kiến",
              dataIndex: "expectedCash",
              align: "right",
              width: 130,
              render: (value: number | null) => formatVnd(value),
            },
            {
              title: "Thực tế",
              dataIndex: "countedCash",
              align: "right",
              width: 130,
              render: (value: number | null) => formatVnd(value),
            },
            {
              title: "Chênh lệch",
              dataIndex: "difference",
              align: "right",
              width: 150,
              render: (value: number | null) => <Difference value={value} />,
            },
          ]}
        />
      </Card>
      <ShiftDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function ShiftDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const detail = useQuery({
    queryKey: id ? cashShiftKeys.detail(id) : ["cash-shift", "none"],
    enabled: id !== null,
    queryFn: async () => (await http.get<Envelope<CashShift>>(`/cash-shifts/${id}`)).data.data,
  });
  const shift = detail.data;
  const t = shift?.totals;

  return (
    <Drawer
      open={id !== null}
      onClose={onClose}
      destroyOnHidden
      size={screens.md ? 460 : "100%"}
      title={shift ? `Ca ${shift.code}` : "Ca thu ngân"}
      extra={
        shift ? (
          <Button
            icon={<PrinterOutlined />}
            onClick={() => void printDocument(cashShiftPrintUrl(shift.id), message)}
          >
            In phiếu
          </Button>
        ) : null
      }
    >
      {!shift || !t ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : (
        <div className="detail-stack">
          <dl className="kv-list">
            <div>
              <dt>Mở ca</dt>
              <dd>
                {formatDateTime(shift.openedAt)} · {shift.openedBy.fullName}
              </dd>
            </div>
            <div>
              <dt>Chốt ca</dt>
              <dd>
                {shift.closedAt ? (
                  `${formatDateTime(shift.closedAt)} · ${shift.closedBy?.fullName ?? ""}`
                ) : (
                  <Tag color="blue">Đang mở</Tag>
                )}
              </dd>
            </div>
          </dl>
          <dl className="cash-shift-sum">
            {(
              [
                ["Tiền đầu ca", t.openingCash],
                ["+ Bán tiền mặt", t.cashSales],
                ["− Hủy hóa đơn tiền mặt", t.cashVoided],
                ["− Hoàn tiền trả hàng", t.cashRefunds],
                ["+ Thu khác", t.cashIn],
                ["− Chi khác", t.cashOut],
              ] as Array<[string, number]>
            ).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{formatVnd(value)}</dd>
              </div>
            ))}
            <div className="is-total">
              <dt>Tiền mặt dự kiến</dt>
              <dd>{formatVnd(t.expectedCash)}</dd>
            </div>
            {shift.countedCash !== null ? (
              <div className="is-total">
                <dt>Tiền đếm thực tế</dt>
                <dd>{formatVnd(shift.countedCash)}</dd>
              </div>
            ) : null}
          </dl>
          {shift.status === "CLOSED" ? (
            <div>
              <Difference value={shift.difference} />{" "}
              {shift.closeNote ? <span>{shift.closeNote}</span> : null}
            </div>
          ) : null}
          <p className="section-note">
            {t.invoiceCount} hóa đơn · tiền mặt {formatVnd(t.salesByMethod.CASH)} · chuyển khoản{" "}
            {formatVnd(t.salesByMethod.BANK_TRANSFER)} · thẻ {formatVnd(t.salesByMethod.CARD)}
            {t.voidedCount ? ` · ${t.voidedCount} hóa đơn hủy` : ""}
            {t.refundCount ? ` · ${t.refundCount} phiếu trả` : ""}
          </p>
          {shift.movements.length ? (
            <div>
              <h4>Thu chi khác</h4>
              <ul className="cash-shift-moves">
                {shift.movements.map((move) => (
                  <li key={move.id}>
                    <span>
                      {move.direction === "IN" ? "Thu" : "Chi"}: {move.reason}
                      <small>
                        {formatDateTime(move.createdAt)} · {move.createdByName}
                      </small>
                    </span>
                    <strong>
                      {move.direction === "IN" ? "+" : "−"}
                      {formatVnd(move.amount)}
                    </strong>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}
