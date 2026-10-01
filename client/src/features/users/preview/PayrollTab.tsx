import {
  CheckCircleOutlined,
  CreditCardOutlined,
  FileAddOutlined,
  NotificationOutlined,
  RollbackOutlined,
  SendOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Drawer,
  Empty,
  Grid,
  Popconfirm,
  Select,
  Steps,
  Table,
} from "antd";
import { useState } from "react";
import { money } from "../staff-format.js";
import { Pairs, PersonCell, StaffNote, StatusDot } from "../staff-ui.js";
import { PREVIEW_PERIOD } from "./preview-fixtures.js";
import { approvedBonusOf } from "./preview-logic.js";
import { usePreview } from "./preview-context.js";
import type { PayrollLine } from "./preview-types.js";
import {
  employeeOf,
  formatDay,
  formatPeriod,
  PAYROLL_STATUS,
  storeShort,
} from "./preview-format.js";
import { SampleTag, SectionHead } from "./preview-ui.js";

const STEP_INDEX = { none: 0, draft: 0, pending: 1, approved: 2, published: 3 } as const;

export function PayrollTab({ onOpenBonus }: { onOpenBonus: (employeeId: string) => void }) {
  const { state, dispatch } = usePreview();
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const [slipFor, setSlipFor] = useState<string | null>(null);
  const run = state.payroll;
  const status = PAYROLL_STATUS[run.status];
  const pendingBonuses = state.bonuses.filter(
    (bonus) => bonus.period === run.period && bonus.status !== "approved",
  ).length;
  const line = slipFor ? run.lines.find((item) => item.employeeId === slipFor) : undefined;

  const act = (action: Parameters<typeof dispatch>[0], text: string) => {
    dispatch(action);
    void message.success(text);
  };

  return (
    <Card className="staff-card">
      <SectionHead
        title={
          <span className="staff-title-with-tag">
            Bảng lương tháng {formatPeriod(run.period)}{" "}
            <StatusDot tone={status.tone}>{status.label}</StatusDot>
          </span>
        }
        description="Lương theo công và mức lương là số minh họa, không phải chính sách lương chính thức."
        extra={
          <>
            <SampleTag />
            <Select
              aria-label="Kỳ lương"
              value={PREVIEW_PERIOD}
              options={[{ value: PREVIEW_PERIOD, label: formatPeriod(PREVIEW_PERIOD) }]}
            />
          </>
        }
      />

      <div className="staff-payroll-actions">
        {run.status === "none" || run.status === "draft" ? (
          <Button
            icon={<FileAddOutlined />}
            onClick={() =>
              act(
                { type: "buildPayroll" },
                run.status === "none"
                  ? "Đã lập bảng lương nháp (mẫu)."
                  : "Đã lập lại bảng lương; các dòng cũ được thay, không cộng dồn.",
              )
            }
          >
            {run.status === "none" ? "Lập bảng lương" : "Lập lại bảng lương"}
          </Button>
        ) : null}
        {run.status === "draft" ? (
          <Popconfirm
            title="Gửi duyệt bảng lương?"
            description="Sau khi gửi, thưởng của kỳ này bị khóa chỉnh sửa."
            okText="Gửi duyệt"
            cancelText="Quay lại"
            onConfirm={() => act({ type: "submitPayroll" }, "Đã gửi duyệt bảng lương (mẫu).")}
          >
            <Button type="primary" icon={<SendOutlined />}>
              Gửi duyệt
            </Button>
          </Popconfirm>
        ) : null}
        {run.status === "pending" ? (
          <>
            <Button
              icon={<RollbackOutlined />}
              onClick={() => act({ type: "returnPayroll" }, "Đã trả bảng lương về nháp để sửa.")}
            >
              Trả lại để sửa
            </Button>
            <Button
              type="primary"
              icon={<CheckCircleOutlined />}
              onClick={() =>
                act(
                  { type: "approvePayroll" },
                  "Đã duyệt bảng lương (mẫu). Chưa có nghĩa là đã thanh toán.",
                )
              }
            >
              Duyệt bảng lương
            </Button>
          </>
        ) : null}
        {run.status === "approved" ? (
          <Popconfirm
            title="Công bố phiếu lương?"
            description="Mỗi nhân viên sẽ thấy phiếu lương của riêng mình."
            okText="Công bố"
            cancelText="Quay lại"
            onConfirm={() => act({ type: "publishPayroll" }, "Đã công bố phiếu lương (mẫu).")}
          >
            <Button type="primary" icon={<NotificationOutlined />}>
              Công bố
            </Button>
          </Popconfirm>
        ) : null}
        {(run.status === "approved" || run.status === "published") &&
        run.paymentStatus === "unpaid" ? (
          <Button
            icon={<CreditCardOutlined />}
            onClick={() => act({ type: "markPaid" }, "Đã ghi nhận thanh toán (mẫu).")}
          >
            Ghi nhận đã thanh toán
          </Button>
        ) : null}
      </div>

      <Steps
        className="staff-steps"
        size="small"
        current={STEP_INDEX[run.status]}
        status={run.status === "none" ? "wait" : run.status === "published" ? "finish" : "process"}
        items={[
          { title: "Nháp" },
          { title: "Chờ duyệt" },
          { title: "Đã duyệt" },
          { title: "Đã công bố" },
        ]}
      />
      <div className={`staff-payment tone-${run.paymentStatus === "paid" ? "green" : "orange"}`}>
        <CreditCardOutlined aria-hidden /> Trạng thái thanh toán:{" "}
        <strong>{run.paymentStatus === "paid" ? "Đã thanh toán" : "Chưa thanh toán"}</strong>
      </div>
      {pendingBonuses && run.status !== "published" ? (
        <Alert
          type="warning"
          showIcon
          className="staff-inline-alert"
          title={`${pendingBonuses} khoản thưởng của kỳ chưa được duyệt sẽ không vào lương.`}
          description={
            run.status === "none" || run.status === "draft"
              ? "Duyệt ở tab Doanh số & thưởng rồi lập lại bảng lương."
              : "Bảng lương đã gửi duyệt; muốn bổ sung thì trả lại về nháp."
          }
        />
      ) : null}

      {run.status === "none" ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa lập bảng lương cho kỳ này" />
      ) : (
        <Table<PayrollLine>
          rowKey="employeeId"
          className="staff-table"
          dataSource={run.lines}
          pagination={false}
          scroll={{ x: 980 }}
          onRow={(row) => ({
            onClick: () => setSlipFor(row.employeeId),
            onKeyDown: (event) => event.key === "Enter" && setSlipFor(row.employeeId),
            tabIndex: 0,
          })}
          columns={[
            { title: "STT", key: "no", width: 56, render: (_, __, index) => index + 1 },
            {
              title: "Nhân viên",
              key: "person",
              fixed: "left",
              width: 210,
              render: (_, row) => {
                const employee = employeeOf(state, row.employeeId)!;
                return <PersonCell name={employee.fullName} id={employee.id} sub={employee.code} />;
              },
            },
            { title: "Công duyệt", dataIndex: "approvedDays", align: "right", width: 100 },
            {
              title: "Lương theo công",
              key: "base",
              align: "right",
              render: (_, row) => money(row.basePay),
            },
            {
              title: "Phụ cấp",
              key: "allowance",
              align: "right",
              render: (_, row) => money(row.allowance),
            },
            {
              title: "Thưởng đã duyệt",
              key: "bonus",
              align: "right",
              render: (_, row) => money(row.bonus),
            },
            {
              title: "Khấu trừ",
              key: "deduction",
              align: "right",
              render: (_, row) => money(row.deduction),
            },
            {
              title: "Thực nhận",
              key: "net",
              align: "right",
              render: (_, row) => (
                <Button
                  type="link"
                  className="staff-money-link"
                  onClick={(event) => {
                    event.stopPropagation();
                    setSlipFor(row.employeeId);
                  }}
                >
                  {money(row.net)}
                </Button>
              ),
            },
          ]}
        />
      )}

      <Drawer
        open={line !== undefined}
        onClose={() => setSlipFor(null)}
        size={screens.md ? 460 : "default"}
        title={
          line ? `Phiếu lương · ${employeeOf(state, line.employeeId)?.fullName}` : "Phiếu lương"
        }
      >
        {line ? (
          <Payslip
            line={line}
            onOpenBonus={() => {
              setSlipFor(null);
              onOpenBonus(line.employeeId);
            }}
          />
        ) : null}
      </Drawer>
    </Card>
  );
}

function Payslip({ line, onOpenBonus }: { line: PayrollLine; onOpenBonus: () => void }) {
  const { state } = usePreview();
  const employee = employeeOf(state, line.employeeId)!;
  const bonus = approvedBonusOf(state, employee.id, state.payroll.period);
  const status = PAYROLL_STATUS[state.payroll.status];
  return (
    <div className="staff-payslip">
      <div className="staff-payslip-tags">
        <StatusDot tone={status.tone}>{status.label}</StatusDot>
        <StatusDot tone={state.payroll.paymentStatus === "paid" ? "green" : "orange"}>
          {state.payroll.paymentStatus === "paid" ? "Đã thanh toán" : "Chưa thanh toán"}
        </StatusDot>
        <SampleTag />
      </div>
      <PersonCell name={employee.fullName} id={employee.id} sub={employee.code} />
      <Pairs
        items={[
          ["Chức danh", employee.title],
          ["Cửa hàng", storeShort(state, employee.storeId)],
          ["Ngày vào làm", formatDay(employee.joinedAt)],
          ["Kỳ lương", formatPeriod(state.payroll.period)],
        ]}
      />
      <h4>Chi tiết lương tháng {formatPeriod(state.payroll.period)}</h4>
      <Pairs
        items={[
          ["Công duyệt", `${line.approvedDays} công`],
          ["Lương theo công", money(line.basePay)],
          ["Phụ cấp", money(line.allowance)],
          [
            "Thưởng đã duyệt",
            <span key="b" className="staff-bonus-source">
              {money(line.bonus)}
              {line.bonusReviewId && bonus ? (
                <Button type="link" size="small" onClick={onOpenBonus}>
                  Thưởng {formatPeriod(bonus.period)} · Đã duyệt
                </Button>
              ) : (
                <small>Không có khoản thưởng đã duyệt</small>
              )}
            </span>,
          ],
          ["Khấu trừ", money(line.deduction)],
        ]}
      />
      <div className="staff-total">
        <span>Thực nhận</span>
        <strong>{money(line.net)}</strong>
      </div>
      <StaffNote>
        Chỉ lấy công và thưởng đã duyệt. Duyệt lương không đồng nghĩa đã thanh toán.
      </StaffNote>
    </div>
  );
}
