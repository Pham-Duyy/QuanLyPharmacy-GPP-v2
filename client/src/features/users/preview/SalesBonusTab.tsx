import {
  AimOutlined,
  BarChartOutlined,
  CheckCircleOutlined,
  GiftOutlined,
  SearchOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  InputNumber,
  Modal,
  Select,
  Table,
} from "antd";
import { useMemo, useState } from "react";
import { foldText } from "../../../app/fold-text.js";
import { money, percent } from "../staff-format.js";
import { Pairs, PersonCell, StaffNote, StaffStat, StatusDot } from "../staff-ui.js";
import { PREVIEW_PERIOD } from "./preview-fixtures.js";
import { netSales, payrollLocked } from "./preview-logic.js";
import { usePreview } from "./preview-context.js";
import type { BonusReview, SalesFigure } from "./preview-types.js";
import { employeeOf, formatPeriod } from "./preview-format.js";
import { SampleTag, SectionHead } from "./preview-ui.js";

type Row = SalesFigure & { bonus: BonusReview | undefined };

export function SalesBonusTab({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const { state } = usePreview();
  const [policyOpen, setPolicyOpen] = useState(false);
  const [store, setStore] = useState("all");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");

  const rows: Row[] = useMemo(() => {
    const term = foldText(search.trim());
    return state.sales
      .filter((figure) => figure.period === PREVIEW_PERIOD)
      .map((figure) => ({
        ...figure,
        bonus: state.bonuses.find(
          (bonus) => bonus.employeeId === figure.employeeId && bonus.period === figure.period,
        ),
      }))
      .filter((row) => {
        const employee = employeeOf(state, row.employeeId);
        if (!employee) return false;
        if (store !== "all" && employee.storeId !== store) return false;
        if (term && !foldText(`${employee.fullName} ${employee.code}`).includes(term)) return false;
        if (status !== "all" && (row.bonus?.status ?? "pending") !== status) return false;
        return true;
      });
  }, [state, store, search, status]);

  const totalNet = rows.reduce((sum, row) => sum + netSales(row), 0);
  const totalTarget = rows.reduce((sum, row) => sum + row.target, 0);
  const proposed = rows.reduce((sum, row) => sum + (row.bonus?.proposed ?? 0), 0);
  const approved = rows.reduce(
    (sum, row) => sum + (row.bonus?.status === "approved" ? (row.bonus.approved ?? 0) : 0),
    0,
  );
  const current = rows.find((row) => row.employeeId === selectedId) ?? rows[0];

  return (
    <>
      <SectionHead
        title="Doanh số & xét thưởng"
        description={`Kỳ ${formatPeriod(PREVIEW_PERIOD)} · Chính sách thưởng mẫu CS-09/2026`}
        extra={
          <>
            <SampleTag />
            <Button icon={<SettingOutlined />} onClick={() => setPolicyOpen(true)}>
              Chính sách thưởng
            </Button>
          </>
        }
      />
      <div className="staff-stats">
        <StaffStat
          icon={<BarChartOutlined />}
          tone="green"
          value={money(totalNet)}
          label="Doanh số thuần"
        />
        <StaffStat
          icon={<AimOutlined />}
          value={percent(totalNet, totalTarget)}
          label="Hoàn thành mục tiêu"
          hint={`Mục tiêu ${money(totalTarget)}`}
        />
        <StaffStat
          icon={<GiftOutlined />}
          tone="purple"
          value={money(proposed)}
          label="Thưởng đề xuất"
        />
        <StaffStat
          icon={<CheckCircleOutlined />}
          tone="green"
          value={money(approved)}
          label="Thưởng đã duyệt"
        />
      </div>
      <div className="staff-split">
        <Card className="staff-card">
          <div className="staff-toolbar" role="search">
            <Select
              aria-label="Kỳ"
              value={PREVIEW_PERIOD}
              options={[{ value: PREVIEW_PERIOD, label: `Tháng ${formatPeriod(PREVIEW_PERIOD)}` }]}
            />
            <Select
              aria-label="Cửa hàng"
              value={store}
              onChange={setStore}
              options={[
                { value: "all", label: "Tất cả cửa hàng" },
                ...state.stores.map((item) => ({ value: item.id, label: item.short })),
              ]}
            />
            <Input
              allowClear
              prefix={<SearchOutlined aria-hidden />}
              aria-label="Tìm nhân viên"
              placeholder="Nhân viên"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Select
              aria-label="Trạng thái xét thưởng"
              value={status}
              onChange={setStatus}
              options={[
                { value: "all", label: "Tất cả trạng thái" },
                { value: "pending", label: "Chờ duyệt" },
                { value: "approved", label: "Đã duyệt" },
              ]}
            />
          </div>
          <Alert
            type="info"
            showIcon
            className="staff-inline-alert"
            title="Doanh số tính theo người bán trên hóa đơn (không phải người xác nhận đơn thuốc), đã trừ giảm giá một lần; hàng trả điều chỉnh về người bán gốc."
          />
          <Table<Row>
            rowKey="employeeId"
            className="staff-table"
            dataSource={rows}
            pagination={false}
            scroll={{ x: 900 }}
            rowClassName={(row) =>
              row.employeeId === current?.employeeId ? "staff-row-selected" : ""
            }
            onRow={(row) => ({
              onClick: () => onSelect(row.employeeId),
              onKeyDown: (event) => event.key === "Enter" && onSelect(row.employeeId),
              tabIndex: 0,
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
                width: 200,
                render: (_, row) => {
                  const employee = employeeOf(state, row.employeeId)!;
                  return (
                    <PersonCell name={employee.fullName} id={employee.id} sub={employee.code} />
                  );
                },
              },
              {
                title: "Doanh số thuần",
                key: "net",
                align: "right",
                render: (_, row) => money(netSales(row)),
              },
              {
                title: "Mục tiêu",
                key: "target",
                align: "right",
                render: (_, row) => money(row.target),
              },
              {
                title: "% hoàn thành",
                key: "pct",
                align: "right",
                render: (_, row) => (
                  <strong className={netSales(row) >= row.target ? "staff-good" : "staff-bad"}>
                    {percent(netSales(row), row.target)}
                  </strong>
                ),
              },
              {
                title: "Thưởng đề xuất",
                key: "proposed",
                align: "right",
                render: (_, row) => money(row.bonus?.proposed ?? 0),
              },
              {
                title: "Thưởng đã duyệt",
                key: "approved",
                align: "right",
                render: (_, row) =>
                  row.bonus?.status === "approved" ? money(row.bonus.approved) : "—",
              },
              {
                title: "Trạng thái",
                key: "status",
                render: (_, row) =>
                  row.bonus?.status === "approved" ? (
                    <StatusDot tone="green">Đã duyệt</StatusDot>
                  ) : (
                    <StatusDot tone="orange">Chờ duyệt</StatusDot>
                  ),
              },
            ]}
          />
        </Card>
        <Card
          className="staff-card staff-aside"
          title={
            current
              ? `Xét thưởng · ${employeeOf(state, current.employeeId)?.fullName}`
              : "Xét thưởng"
          }
        >
          {current?.bonus ? (
            <BonusPanel
              key={`${current.bonus.id}:${current.bonus.status}:${current.bonus.approved}`}
              figure={current}
              bonus={current.bonus}
            />
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="Chọn nhân viên để xét thưởng"
            />
          )}
        </Card>
      </div>
      <Modal
        open={policyOpen}
        title="Chính sách thưởng mẫu · CS-09/2026"
        onCancel={() => setPolicyOpen(false)}
        footer={<Button onClick={() => setPolicyOpen(false)}>Đóng</Button>}
      >
        <p>
          Hệ thống chưa có chính sách thưởng được cấu hình. Mức đề xuất ở bản xem trước là số minh
          họa, không phải công thức tính thưởng.
        </p>
        <p>
          Khi tích hợp cần cấu hình: ngưỡng doanh số, tiêu chí chất lượng và tuân thủ, thời gian
          hiệu lực, và cách xử lý hàng trả phát sinh sau khi kỳ đã chốt (ghi điều chỉnh vào kỳ sau,
          không sửa kỳ đã chốt).
        </p>
        <p>Doanh số là một tiêu chí; không tự thưởng hay thăng chức chỉ dựa vào doanh số.</p>
      </Modal>
    </>
  );
}

function BonusPanel({ figure, bonus }: { figure: SalesFigure; bonus: BonusReview }) {
  const { state, dispatch } = usePreview();
  const { message } = App.useApp();
  const locked = payrollLocked(state);
  const [amount, setAmount] = useState<number | null>(bonus.approved ?? bonus.proposed);
  const [reason, setReason] = useState(bonus.reason);
  const [compliance, setCompliance] = useState(bonus.compliance);
  const [service, setService] = useState(bonus.service);
  // Đổi người hoặc vừa duyệt thì panel được mount lại (key), nên state luôn khớp khoản thưởng.
  const [tried, setTried] = useState(false);

  const needsReason = amount !== null && amount !== bonus.proposed && !reason.trim();
  const invalidAmount = amount === null || amount < 0;

  return (
    <div className="staff-bonus">
      <h4>Doanh số trong kỳ ({formatPeriod(figure.period)})</h4>
      <Pairs
        items={[
          ["Doanh số sau giảm giá", money(figure.grossAfterDiscount)],
          [
            "Hàng trả",
            <span key="r" className="staff-bad">
              − {money(figure.returns)}
            </span>,
          ],
          ["Doanh số thuần", <strong key="n">{money(netSales(figure))}</strong>],
        ]}
      />
      <h4>Thông tin thưởng</h4>
      <Pairs
        items={[
          ["Chính sách áp dụng", "CS-09/2026 (mẫu)"],
          ["Thưởng đề xuất", money(bonus.proposed)],
        ]}
      />
      <label className="staff-field">
        <span>Mức được duyệt</span>
        <InputNumber<number>
          min={0}
          step={100_000}
          precision={0}
          value={amount}
          disabled={locked}
          onChange={setAmount}
          formatter={(value) =>
            value === undefined || value === null
              ? ""
              : new Intl.NumberFormat("vi-VN").format(Number(value))
          }
          parser={(value) => Number((value ?? "").replace(/\D/g, ""))}
          suffix="₫"
          status={tried && invalidAmount ? "error" : undefined}
          style={{ width: "100%" }}
        />
      </label>
      <label className="staff-field">
        <span>
          Lý do điều chỉnh{" "}
          {amount !== bonus.proposed ? <span className="staff-required">*</span> : "(nếu có)"}
        </span>
        <Input.TextArea
          rows={2}
          maxLength={300}
          value={reason}
          disabled={locked}
          onChange={(event) => setReason(event.target.value)}
          status={tried && needsReason ? "error" : undefined}
          placeholder="Bắt buộc khi mức duyệt khác mức đề xuất"
        />
      </label>
      {tried && needsReason ? (
        <div className="staff-field-error" role="alert">
          Ghi lý do khi duyệt khác mức đề xuất.
        </div>
      ) : null}
      <fieldset className="staff-fieldset" disabled={locked}>
        <legend>Đánh giá chất lượng / tuân thủ</legend>
        <Checkbox checked={compliance} onChange={(event) => setCompliance(event.target.checked)}>
          Tuân thủ quy trình
        </Checkbox>
        <Checkbox checked={service} onChange={(event) => setService(event.target.checked)}>
          Chất lượng phục vụ khách hàng
        </Checkbox>
      </fieldset>
      {locked ? (
        <Alert type="warning" showIcon title="Bảng lương kỳ này đã gửi duyệt — khóa sửa thưởng." />
      ) : (
        <StaffNote>Chỉ thưởng đã duyệt được chuyển vào bảng lương, mỗi khoản một lần.</StaffNote>
      )}
      <Button
        type="primary"
        block
        icon={<CheckCircleOutlined />}
        disabled={locked}
        onClick={() => {
          setTried(true);
          if (invalidAmount || needsReason) return;
          dispatch({
            type: "approveBonus",
            id: bonus.id,
            amount: amount!,
            reason,
            compliance,
            service,
          });
          void message.success(
            bonus.status === "approved"
              ? "Đã cập nhật mức thưởng đã duyệt (mẫu)."
              : "Đã duyệt thưởng (mẫu).",
          );
        }}
      >
        {bonus.status === "approved" ? "Cập nhật thưởng đã duyệt" : "Duyệt thưởng"}
      </Button>
    </div>
  );
}
