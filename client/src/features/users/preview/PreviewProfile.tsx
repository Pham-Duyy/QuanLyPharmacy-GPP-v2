import { Drawer, Empty, Grid, Tabs, Tag } from "antd";
import { money, percent } from "../staff-format.js";
import { AccountStatus, Pairs, StaffAvatar, StaffNote } from "../staff-ui.js";
import { PREVIEW_PERIOD } from "./preview-fixtures.js";
import { approvedDays, netSales, overallRating, payslipFor, salesOf } from "./preview-logic.js";
import { usePreview } from "./preview-context.js";
import {
  employeeOf,
  formatDay,
  formatPeriod,
  PAYROLL_STATUS,
  PROPOSAL_STATUS,
  storeShort,
  weekdayOf,
} from "./preview-format.js";
import { SampleTag, WorkStatusTag } from "./preview-ui.js";
import { StatusDot } from "../staff-ui.js";

/** Hồ sơ nhân viên MẪU (thiết kế 02), mở dạng drawer. */
export function PreviewProfileDrawer({
  employeeId,
  open,
  onClose,
}: {
  employeeId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { state } = usePreview();
  const screens = Grid.useBreakpoint();
  const employee = employeeOf(state, employeeId);
  if (!employee) return null;

  const sales = salesOf(state, employee.id, PREVIEW_PERIOD);
  const slip = payslipFor(state, employee.id, "manager");
  const shifts = state.shifts
    .filter((shift) => shift.employeeId === employee.id)
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const reviews = state.reviews.filter((review) => review.employeeId === employee.id);
  const proposals = state.proposals.filter((proposal) => proposal.employeeId === employee.id);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size={screens.lg ? 860 : "default"}
      title={
        <span className="staff-drawer-title">
          Hồ sơ nhân viên <SampleTag />
        </span>
      }
    >
      <div className="staff-profile-banner">
        <StaffAvatar name={employee.fullName} id={employee.id} size="lg" />
        <div>
          <h2>
            {employee.fullName} <Tag color="blue">{employee.code}</Tag>
          </h2>
          <p>
            {employee.title} · {state.stores.find((store) => store.id === employee.storeId)?.name} ·{" "}
            <WorkStatusTag status={employee.workStatus} />
          </p>
        </div>
      </div>
      <Tabs
        items={[
          {
            key: "overview",
            label: "Tổng quan",
            children: (
              <div className="staff-profile-grid">
                <section className="staff-panel">
                  <h4>Thông tin cá nhân</h4>
                  <Pairs
                    items={[
                      ["Họ và tên", employee.fullName],
                      ["Mã nhân viên", employee.code],
                      ["Số điện thoại", employee.phone ?? "—"],
                      ["Chức danh", employee.title],
                      ["Chứng chỉ hành nghề", employee.certificate ?? "—"],
                      ["Ngày vào làm", formatDay(employee.joinedAt)],
                    ]}
                  />
                </section>
                <section className="staff-panel">
                  <h4>Kết quả tháng {formatPeriod(PREVIEW_PERIOD)}</h4>
                  <Pairs
                    items={[
                      ["Doanh số thuần", sales ? money(netSales(sales)) : "Không bán hàng"],
                      [
                        "Mục tiêu",
                        sales
                          ? `${percent(netSales(sales), sales.target)} của ${money(sales.target)}`
                          : "—",
                      ],
                      ["Công đã duyệt", `${approvedDays(state, employee.id, PREVIEW_PERIOD)} công`],
                    ]}
                  />
                  <h4>Tài khoản &amp; phân quyền</h4>
                  <Pairs
                    items={[
                      ["Tên đăng nhập", `@${employee.username}`],
                      [
                        "Trạng thái tài khoản",
                        <AccountStatus key="a" active={employee.accountActive} />,
                      ],
                      ["Vai trò truy cập", employee.accessRole],
                      ["Cửa hàng áp dụng", storeShort(state, employee.storeId)],
                    ]}
                  />
                  <StaffNote>
                    Vai trò truy cập quyết định quyền hệ thống; chức danh là thông tin nghiệp vụ
                    nhân sự. Thao tác tài khoản thật nằm ở chế độ Dữ liệu thật.
                  </StaffNote>
                </section>
              </div>
            ),
          },
          {
            key: "shifts",
            label: "Lịch làm",
            children: shifts.length ? (
              <ul className="staff-simple-list">
                {shifts.map((shift) => (
                  <li key={shift.id}>
                    <strong>
                      {weekdayOf(shift.date)}, {formatDay(shift.date)}
                    </strong>
                    <span>
                      {shift.start} – {shift.end} · {storeShort(state, shift.storeId)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có ca trong tuần mẫu" />
            ),
          },
          {
            key: "sales",
            label: "Doanh số",
            children: sales ? (
              <Pairs
                items={[
                  ["Doanh số sau giảm giá", money(sales.grossAfterDiscount)],
                  ["Hàng trả (quy về người bán gốc)", `− ${money(sales.returns)}`],
                  ["Doanh số thuần", <strong key="n">{money(netSales(sales))}</strong>],
                  ["Mục tiêu", money(sales.target)],
                ]}
              />
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Chức danh này không bán hàng"
              />
            ),
          },
          {
            key: "payslip",
            label: "Phiếu lương",
            children: slip ? (
              <>
                <StatusDot tone={PAYROLL_STATUS[state.payroll.status].tone}>
                  {PAYROLL_STATUS[state.payroll.status].label}
                </StatusDot>
                <Pairs
                  items={[
                    ["Công duyệt", `${slip.approvedDays} công`],
                    ["Lương theo công", money(slip.basePay)],
                    ["Phụ cấp", money(slip.allowance)],
                    ["Thưởng đã duyệt", money(slip.bonus)],
                    ["Khấu trừ", money(slip.deduction)],
                    ["Thực nhận", <strong key="t">{money(slip.net)}</strong>],
                  ]}
                />
              </>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Chưa lập bảng lương kỳ này"
              />
            ),
          },
          {
            key: "history",
            label: "Lịch sử đánh giá",
            children:
              reviews.length || proposals.length ? (
                <ul className="staff-simple-list">
                  {reviews.map((review) => (
                    <li key={review.id}>
                      <strong>Đánh giá tháng {formatPeriod(review.period)}</strong>
                      <span>
                        {review.ratings ? overallRating(review.ratings) : "Chưa đánh giá"}
                      </span>
                    </li>
                  ))}
                  {proposals.map((proposal) => (
                    <li key={proposal.id}>
                      <strong>Đề xuất {proposal.proposedTitle}</strong>
                      <span>
                        <StatusDot tone={PROPOSAL_STATUS[proposal.status].tone}>
                          {PROPOSAL_STATUS[proposal.status].label}
                        </StatusDot>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="Chưa có đánh giá hay đề xuất"
                />
              ),
          },
        ]}
      />
    </Drawer>
  );
}
